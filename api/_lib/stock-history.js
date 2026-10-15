const crypto = require("node:crypto");
const { PRODUCTS } = require("./catalog");
const { createFinanceOptions } = require("./finance");

const TIME_ZONE = "Asia/Jakarta";
const PERIODS = { day: "daily", week: "weekly", month: "monthly", year: "yearly" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const productIds = new Set(PRODUCTS.map(product => product.id));

function historyError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function stockReason(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
    throw historyError("INVALID_STOCK_REASON", "Keterangan stok harus berupa teks paling banyak 200 karakter.");
  }
  const normalized = value.replace(/[\t\r\n]+/g, " ").trim();
  if (normalized.length > 200) throw historyError("INVALID_STOCK_REASON", "Keterangan stok paling banyak 200 karakter.");
  return normalized;
}

function createStockHistoryOptions(input = {}, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw historyError("INVALID_STOCK_HISTORY");
  const { snapshot, cursor = 0, pageSize = 100 } = input;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 2147482647 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      !Number.isSafeInteger(cursor + pageSize)) throw historyError("INVALID_STOCK_HISTORY", "Halaman riwayat stok tidak valid.");
  if (snapshot !== undefined) {
    if (typeof snapshot !== "string" || !UUID.test(snapshot) || ["period", "date", "productId"].some(key => input[key] !== undefined)) {
      throw historyError("INVALID_STOCK_HISTORY", "Parameter salinan laporan tidak valid. Muat ulang laporan.");
    }
    return { snapshot: snapshot.toLowerCase(), cursor, pageSize };
  }
  if (cursor !== 0) throw historyError("INVALID_STOCK_HISTORY", "Muat halaman pertama laporan terlebih dahulu.");
  const period = input.period === undefined ? "day" : input.period;
  if (!Object.hasOwn(PERIODS, period)) throw historyError("INVALID_STOCK_HISTORY", "Periode laporan stok tidak valid.");
  const productId = input.productId === undefined || input.productId === "" ? null : input.productId;
  if (productId !== null && (typeof productId !== "string" || !productIds.has(productId))) throw historyError("INVALID_STOCK_HISTORY", "Menu laporan stok tidak valid.");
  let range;
  try { range = createFinanceOptions({ period: PERIODS[period], date: input.date }, now); }
  catch (error) { throw historyError("INVALID_STOCK_HISTORY", error.message); }
  return { period: { type: period, date: range.date, startDate: range.startDate, endDate: range.endDate, start: range.start, end: range.end }, productId, cursor, pageSize };
}

function parseStockHistoryQuery(req, now = Date.now()) {
  const query = req.query === undefined ? {} : req.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) throw historyError("INVALID_STOCK_HISTORY");
  let params;
  try { params = new URL(req.url || "/api/admin/stock", "https://localhost").searchParams; }
  catch { throw historyError("INVALID_STOCK_HISTORY"); }
  const allowed = new Set(["view", "period", "date", "productId", "snapshot", "cursor", "pageSize"]);
  if ([...params.keys(), ...Object.keys(query)].some(key => !allowed.has(key))) throw historyError("INVALID_STOCK_HISTORY");
  function single(name) {
    const values = params.getAll(name);
    const value = query[name];
    if (values.length > 1 || (value !== undefined && typeof value !== "string") ||
        (values.length === 1 && value !== undefined && value !== values[0])) throw historyError("INVALID_STOCK_HISTORY");
    return values.length ? values[0] : value;
  }
  if (single("view") !== "history") throw historyError("INVALID_STOCK_HISTORY");
  function integer(name, fallback) {
    const value = single(name);
    if (value === undefined) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw historyError("INVALID_STOCK_HISTORY");
    return Number(value);
  }
  return createStockHistoryOptions({ period: single("period"), date: single("date"), productId: single("productId"),
    snapshot: single("snapshot"), cursor: integer("cursor", 0), pageSize: integer("pageSize", 100) }, now);
}

async function ensureStockHistorySchema(sql) {
  // Baseline and trigger are installed under the same non-waiting inventory
  // lock. A checkout either finishes before this actual opening balance or
  // records its deduction after the trigger becomes visible; never both.
  await sql`
    DO $stock_history_schema$
    DECLARE baseline_time TIMESTAMPTZ;
    BEGIN
      PERFORM pg_advisory_xact_lock(1885433957,117);
      IF to_regclass('inventory_history_meta') IS NULL THEN
        LOCK TABLE inventory IN ACCESS EXCLUSIVE MODE NOWAIT;
        baseline_time:=clock_timestamp();
        CREATE TABLE inventory_history_meta (
          singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), started_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO inventory_history_meta(singleton,started_at) VALUES(TRUE,baseline_time);
        CREATE TABLE inventory_baselines (
          product_id TEXT PRIMARY KEY, stock INTEGER NOT NULL CHECK(stock>=0), started_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO inventory_baselines(product_id,stock,started_at) SELECT product_id,stock,baseline_time FROM inventory;
        CREATE TABLE inventory_movements (
          id BIGSERIAL PRIMARY KEY, product_id TEXT NOT NULL REFERENCES inventory_baselines(product_id),
          stock_before INTEGER NOT NULL CHECK(stock_before>=0), stock_after INTEGER NOT NULL CHECK(stock_after>=0),
          delta INTEGER NOT NULL CHECK(delta<>0), source TEXT NOT NULL CHECK(source IN('restock','adjustment','order','cancellation','system')),
          reason TEXT NOT NULL CHECK(length(reason)<=200), order_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          CHECK(stock_after::bigint-stock_before=delta)
        );
        CREATE INDEX inventory_movements_time_idx ON inventory_movements(created_at,id);
        CREATE INDEX inventory_movements_product_time_idx ON inventory_movements(product_id,created_at,id);
      END IF;
      CREATE OR REPLACE FUNCTION dapoer_immutable_stock_history() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
      BEGIN RAISE EXCEPTION 'IMMUTABLE_STOCK_HISTORY'; END;
      $function$;
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inventory_movements'::regclass AND tgname='inventory_movements_immutable') THEN
        CREATE TRIGGER inventory_movements_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inventory_movements
          FOR EACH STATEMENT EXECUTE FUNCTION dapoer_immutable_stock_history();
        CREATE TRIGGER inventory_baselines_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inventory_baselines
          FOR EACH STATEMENT EXECUTE FUNCTION dapoer_immutable_stock_history();
        CREATE TRIGGER inventory_history_meta_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inventory_history_meta
          FOR EACH STATEMENT EXECUTE FUNCTION dapoer_immutable_stock_history();
      END IF;
      CREATE OR REPLACE FUNCTION dapoer_record_stock_movement() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
      DECLARE context JSONB; movement_source TEXT; movement_reason TEXT; prior_stock INTEGER;
      BEGIN
        IF TG_OP='INSERT' THEN
          INSERT INTO inventory_baselines(product_id,stock,started_at) VALUES(NEW.product_id,0,clock_timestamp()) ON CONFLICT DO NOTHING;
          prior_stock:=0;
        ELSE prior_stock:=OLD.stock;
        END IF;
        IF NEW.stock=prior_stock THEN RETURN NEW; END IF;
        context:=COALESCE(NULLIF(current_setting('dapoer.stock_context',TRUE),'')::jsonb,'{}'::jsonb);
        movement_source:=COALESCE(context->>'source','system');
        IF movement_source NOT IN('restock','adjustment','order','cancellation','system') THEN movement_source:='system'; END IF;
        movement_reason:=COALESCE(NULLIF(context->>'reason',''),CASE movement_source
          WHEN 'restock' THEN 'Penambahan stok oleh admin' WHEN 'adjustment' THEN 'Penyesuaian stok oleh admin'
          WHEN 'order' THEN 'Stok dipesan pelanggan' WHEN 'cancellation' THEN 'Stok dikembalikan dari pesanan dibatalkan'
          ELSE 'Perubahan stok sistem' END);
        INSERT INTO inventory_movements(product_id,stock_before,stock_after,delta,source,reason,order_id)
          VALUES(NEW.product_id,prior_stock,NEW.stock,NEW.stock-prior_stock,movement_source,left(movement_reason,200),NULLIF(context->>'orderId',''));
        RETURN NEW;
      END;
      $function$;
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inventory'::regclass AND tgname='inventory_movement_capture') THEN
        CREATE TRIGGER inventory_movement_capture AFTER INSERT OR UPDATE OF stock ON inventory
          FOR EACH ROW EXECUTE FUNCTION dapoer_record_stock_movement();
      END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inventory'::regclass AND tgname='inventory_delete_immutable') THEN
        CREATE TRIGGER inventory_delete_immutable BEFORE DELETE OR TRUNCATE ON inventory
          FOR EACH STATEMENT EXECUTE FUNCTION dapoer_immutable_stock_history();
        CREATE TRIGGER inventory_identity_immutable BEFORE UPDATE OF product_id ON inventory
          FOR EACH ROW WHEN(OLD.product_id IS DISTINCT FROM NEW.product_id)
          EXECUTE FUNCTION dapoer_immutable_stock_history();
      END IF;
      -- Versioned outer wrappers keep metadata intact even when an older cold
      -- instance briefly replaces a shared legacy procedure during rollout.
      -- Context is local to this transaction and restored on normal completion;
      -- an exception rolls it back with the function's subtransaction.
      CREATE OR REPLACE FUNCTION dapoer_save_order_once_recorded(
        p_id TEXT,p_name TEXT,p_phone TEXT,p_address TEXT,p_notes TEXT,p_payment TEXT,p_items JSONB,
        p_total BIGINT,p_tracking_token TEXT,p_request_id UUID,p_fingerprint TEXT,p_expected_total BIGINT
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE saved JSONB; previous_context TEXT;
      BEGIN
        previous_context:=current_setting('dapoer.stock_context',TRUE);
        PERFORM set_config('dapoer.stock_context',jsonb_build_object('source','order','orderId',p_id)::text,TRUE);
        saved:=dapoer_save_order_once(p_id,p_name,p_phone,p_address,p_notes,p_payment,p_items,p_total,
          p_tracking_token,p_request_id,p_fingerprint,p_expected_total);
        PERFORM set_config('dapoer.stock_context',COALESCE(previous_context,''),TRUE);
        RETURN saved;
      END;
      $function$;
      CREATE OR REPLACE FUNCTION dapoer_save_order_with_queue_recorded(
        p_id TEXT,p_name TEXT,p_phone TEXT,p_address TEXT,p_notes TEXT,p_payment TEXT,p_items JSONB,p_total BIGINT,p_tracking_token TEXT
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE saved JSONB; previous_context TEXT;
      BEGIN
        previous_context:=current_setting('dapoer.stock_context',TRUE);
        PERFORM set_config('dapoer.stock_context',jsonb_build_object('source','order','orderId',p_id)::text,TRUE);
        saved:=dapoer_save_order_with_queue(p_id,p_name,p_phone,p_address,p_notes,p_payment,p_items,p_total,p_tracking_token);
        PERFORM set_config('dapoer.stock_context',COALESCE(previous_context,''),TRUE);
        RETURN saved;
      END;
      $function$;
      CREATE OR REPLACE FUNCTION dapoer_update_order_status_checked_recorded(
        p_id TEXT,p_status TEXT,p_expected_status TEXT,p_expected_updated_at TIMESTAMPTZ
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE saved JSONB; previous_context TEXT;
      BEGIN
        previous_context:=current_setting('dapoer.stock_context',TRUE);
        PERFORM set_config('dapoer.stock_context',jsonb_build_object('source','cancellation','orderId',p_id)::text,TRUE);
        saved:=dapoer_update_order_status_checked(p_id,p_status,p_expected_status,p_expected_updated_at);
        PERFORM set_config('dapoer.stock_context',COALESCE(previous_context,''),TRUE);
        RETURN saved;
      END;
      $function$;
      CREATE OR REPLACE FUNCTION dapoer_update_order_status_recorded(p_id TEXT,p_status TEXT)
      RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE saved JSONB; previous_context TEXT;
      BEGIN
        previous_context:=current_setting('dapoer.stock_context',TRUE);
        PERFORM set_config('dapoer.stock_context',jsonb_build_object('source','cancellation','orderId',p_id)::text,TRUE);
        saved:=dapoer_update_order_status(p_id,p_status);
        PERFORM set_config('dapoer.stock_context',COALESCE(previous_context,''),TRUE);
        RETURN saved;
      END;
      $function$;
      CREATE TABLE IF NOT EXISTS inventory_report_snapshots (
        id UUID PRIMARY KEY, report JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+INTERVAL '1 hour'
      );
      CREATE INDEX IF NOT EXISTS inventory_report_snapshots_expiry_idx ON inventory_report_snapshots(expires_at);
      CREATE OR REPLACE FUNCTION dapoer_create_stock_report(p_id UUID,p_period JSONB,p_product_id TEXT,p_products JSONB)
      RETURNS BOOLEAN LANGUAGE plpgsql AS $function$
      BEGIN
        -- Bound ephemeral storage and serialize quota checks across cold instances.
        PERFORM pg_advisory_xact_lock(1885433957,118);
        DELETE FROM inventory_report_snapshots WHERE id IN(
          SELECT id FROM inventory_report_snapshots WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100);
        IF (SELECT COUNT(*)>=240 OR COALESCE(SUM(pg_column_size(report)),0)>=134217728 FROM inventory_report_snapshots) THEN
          -- Return rather than raise: expired-row cleanup must commit even
          -- when the remaining active snapshots still exceed the quota.
          RETURN FALSE;
        END IF;
        -- All balances, totals and rows share ONE statement snapshot. Persisting
        -- the resulting immutable JSON also excludes transactions that commit
        -- later with a lower sequence id, unlike max-id cursor pagination.
        WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS now),
        bounds AS MATERIALIZED (
          SELECT started_at,now,GREATEST(started_at,(p_period->>'start')::timestamptz) AS effective_start,
            LEAST(now,(p_period->>'end')::timestamptz) AS effective_end,
            started_at<(p_period->>'end')::timestamptz AND now>=(p_period->>'start')::timestamptz AS available
          FROM inventory_history_meta CROSS JOIN moment
        ), selected_products AS MATERIALIZED (
          SELECT catalog.id,catalog.name,baseline.stock,baseline.started_at
          FROM jsonb_to_recordset(p_products) AS catalog(id TEXT,name TEXT)
          JOIN inventory_baselines baseline ON baseline.product_id=catalog.id
          WHERE p_product_id IS NULL OR catalog.id=p_product_id
        ), movement_rows AS MATERIALIZED (
          SELECT m.*,p.name FROM inventory_movements m JOIN selected_products p ON p.id=m.product_id
          CROSS JOIN bounds b WHERE b.available AND m.created_at>=b.effective_start AND m.created_at<b.effective_end
        ), product_totals AS MATERIALIZED (
          SELECT p.id,p.name,
            CASE WHEN b.available THEN p.stock+COALESCE((SELECT SUM(m.delta) FROM inventory_movements m
              WHERE m.product_id=p.id AND m.created_at<b.effective_start),0) ELSE NULL END AS opening,
            COALESCE((SELECT SUM(m.delta) FROM movement_rows m WHERE m.product_id=p.id AND m.delta>0),0) AS incoming,
            COALESCE((SELECT SUM(-m.delta) FROM movement_rows m WHERE m.product_id=p.id AND m.delta<0),0) AS outgoing,
            CASE WHEN b.available THEN p.stock+COALESCE((SELECT SUM(m.delta) FROM inventory_movements m
              WHERE m.product_id=p.id AND m.created_at<b.effective_end),0) ELSE NULL END AS closing
          FROM selected_products p CROSS JOIN bounds b
        )
        INSERT INTO inventory_report_snapshots(id,report)
        SELECT p_id,jsonb_build_object('timeZone','Asia/Jakarta','generatedAt',b.now,'period',p_period,
          'coverage',jsonb_build_object('startedAt',b.started_at,'available',b.available,
            'partial',(p_period->>'start')::timestamptz<b.started_at,
            'inProgress',(p_period->>'end')::timestamptz>b.now AND b.available,
            'effectiveStart',CASE WHEN b.available THEN b.effective_start ELSE NULL END,
            'effectiveEnd',CASE WHEN b.available THEN b.effective_end ELSE NULL END),
          'summary',jsonb_build_object('movementCount',(SELECT COUNT(*) FROM movement_rows),
            'opening',(SELECT SUM(opening) FROM product_totals),'incoming',(SELECT COALESCE(SUM(incoming),0) FROM product_totals),
            'outgoing',(SELECT COALESCE(SUM(outgoing),0) FROM product_totals),'closing',(SELECT SUM(closing) FROM product_totals)),
          'products',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM product_totals p),
          'movements',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id::text,'createdAt',m.created_at,
            'productId',m.product_id,'productName',m.name,'stockBefore',m.stock_before,'quantityIn',GREATEST(m.delta,0),
            'quantityOut',GREATEST(-m.delta,0),'stockAfter',m.stock_after,'source',m.source,'reason',m.reason,'orderId',m.order_id)
            ORDER BY m.created_at DESC,m.id DESC),'[]'::jsonb) FROM movement_rows m)) FROM bounds b;
        RETURN TRUE;
      END;
      $function$;
    END;
    $stock_history_schema$
  `;
}

async function listStockHistory(input = {}, providedSql = null) {
  // parseStockHistoryQuery already produces canonical options; direct callers
  // can provide plain input as well without bypassing validation.
  const options = input.period && typeof input.period === "object"
    ? createStockHistoryOptions({ period: input.period.type, date: input.period.date, productId: input.productId,
      cursor: input.cursor, pageSize: input.pageSize }) : createStockHistoryOptions(input);
  const sql = providedSql || await require("./db").ensureSchema();
  if (!sql) throw historyError("DATABASE_NOT_CONFIGURED");
  let snapshot = options.snapshot;
  if (!snapshot) {
    snapshot = crypto.randomUUID();
    const created = await sql`SELECT dapoer_create_stock_report(${snapshot}::uuid,${JSON.stringify(options.period)}::jsonb,
      ${options.productId},${JSON.stringify(PRODUCTS.map(({ id, name }) => ({ id, name })))}::jsonb) AS created`;
    if (created[0]?.created === false) throw historyError("STOCK_HISTORY_BUSY", "Terlalu banyak salinan laporan sedang aktif. Coba lagi setelah beberapa saat.");
    if (created[0]?.created !== true) throw new Error("STOCK_HISTORY_UNCONFIRMED");
  }
  const path = `$[${options.cursor} to ${options.cursor + options.pageSize - 1}]`;
  const rows = await sql`
    SELECT (report-'movements') || jsonb_build_object('movements',jsonb_path_query_array(report->'movements',${path}::jsonpath),
      'pagination',jsonb_build_object('snapshot',id,'cursor',${options.cursor}::integer,
        'nextCursor',CASE WHEN ${options.cursor}::bigint+${options.pageSize}>jsonb_array_length(report->'movements')-1 THEN NULL ELSE ${options.cursor}::bigint+${options.pageSize} END,
        'total',jsonb_array_length(report->'movements'),'pageSize',${options.pageSize}::integer,'expiresAt',expires_at)) AS report
    FROM inventory_report_snapshots WHERE id=${snapshot}::uuid AND expires_at>clock_timestamp()
  `;
  if (!rows[0]) throw historyError("STOCK_HISTORY_EXPIRED", "Salinan laporan sudah kedaluwarsa. Muat ulang laporan untuk melanjutkan.");
  return rows[0].report;
}

module.exports = { TIME_ZONE, stockReason, historyError, createStockHistoryOptions, parseStockHistoryQuery,
  ensureStockHistorySchema, listStockHistory };
