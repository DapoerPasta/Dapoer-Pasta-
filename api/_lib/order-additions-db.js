const { PRODUCTS } = require("./catalog");
const { operationError, requestId, expectedTotal, fingerprint, validateExpectedStatus } = require("./operations");

const ERRORS = new Set(["ADDITION_NOT_ALLOWED", "ADDITION_PENDING", "ADDITION_LIMIT", "ADDITION_NOT_FOUND",
  "ADDITION_ALREADY_REVIEWED", "INSUFFICIENT_STOCK", "REQUEST_CONFLICT", "PRICE_CHANGED", "ORDER_CONFLICT"]);

function normalizeAddition(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw operationError("INVALID_ITEMS");
  const catalog = new Map(PRODUCTS.map(product => [product.id, product]));
  const quantities = new Map();
  for (const item of input) {
    if (!item || typeof item.id !== "string" || !catalog.has(item.id) ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000000) throw operationError("INVALID_ITEM");
    const quantity = (quantities.get(item.id) || 0) + item.quantity;
    if (quantity > 1000000) throw operationError("INVALID_QUANTITY");
    quantities.set(item.id, quantity);
  }
  return [...quantities].sort(([a], [b]) => a.localeCompare(b)).map(([id, quantity]) => {
    const { name, price } = catalog.get(id);
    return { id, name, price, quantity, subtotal: price * quantity };
  });
}

function identity(input, tokenRequired = false) {
  if (!input || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id) ||
      (tokenRequired && (typeof input.trackingToken !== "string" || !/^[0-9a-f]{48}$/i.test(input.trackingToken)))) {
    throw operationError("INVALID_ORDER");
  }
  const operationId = requestId(input.requestId);
  if (!operationId) throw operationError("INVALID_REQUEST_ID");
  return operationId;
}

function rethrow(error) {
  if (ERRORS.has(error?.message)) throw operationError(error.message);
  throw error;
}

async function ensureOrderAdditionsSchema(sql) {
  await sql`
    DO $addition_schema$
    BEGIN
      PERFORM pg_advisory_xact_lock(1885433957,119);
      CREATE TABLE IF NOT EXISTS order_additions (
        id UUID PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id),
        fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
        items JSONB NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)>0),
        total BIGINT NOT NULL CHECK(total>0),
        status TEXT NOT NULL CHECK(status IN('applied','pending','approved','rejected','expired')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS order_additions_order_idx ON order_additions(order_id,created_at DESC,id);
      CREATE UNIQUE INDEX IF NOT EXISTS order_additions_pending_idx ON order_additions(order_id) WHERE status='pending';

      CREATE OR REPLACE FUNCTION dapoer_order_additions_json(p_id TEXT)
      RETURNS JSONB LANGUAGE sql STABLE AS $function$
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'status',a.status,'items',a.items,'total',a.total,
          'createdAt',a.created_at,'updatedAt',a.updated_at) ORDER BY a.created_at DESC,a.id DESC),'[]'::jsonb)
        FROM (SELECT * FROM order_additions WHERE order_id=p_id ORDER BY created_at DESC,id DESC LIMIT 100) a
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_addition_result(p_id TEXT,p_addition UUID)
      RETURNS JSONB LANGUAGE sql STABLE AS $function$
        SELECT jsonb_build_object('addition',jsonb_build_object('id',a.id,'status',a.status,'items',a.items,'total',a.total,
            'createdAt',a.created_at,'updatedAt',a.updated_at),
          'order',jsonb_build_object('id',o.id,'status',o.status,'items',o.items,'total',o.total,
            'paymentMethod',o.payment_method,'queueNumber',o.queue_number,'queueDate',o.queue_date,
            'createdAt',o.created_at,'updatedAt',o.updated_at,'additions',dapoer_order_additions_json(o.id),
            'canAddItems',o.stock_reserved AND o.status IN('baru','diproses'))
            ||dapoer_fulfillment_metadata(o.delivery_method,o.shipping_fee,o.total))
        FROM orders o JOIN order_additions a ON a.order_id=o.id WHERE o.id=p_id AND a.id=p_addition
      $function$;

      -- The caller owns the order row lock before touching any inventory row.
      -- Cancellation and status changes use the same order -> sorted product
      -- lock sequence, so the combined quantity can never be returned twice.
      CREATE OR REPLACE FUNCTION dapoer_apply_order_addition(p_id TEXT,p_items JSONB,p_total BIGINT,p_addition UUID)
      RETURNS VOID LANGUAGE plpgsql AS $function$
      DECLARE current_order orders%ROWTYPE; item JSONB; balance INTEGER; idx INTEGER;
        combined JSONB; next_quantity BIGINT; previous_context TEXT;
      BEGIN
        SELECT * INTO current_order FROM orders WHERE id=p_id FOR UPDATE;
        IF NOT FOUND OR NOT current_order.stock_reserved OR current_order.status NOT IN('baru','diproses') THEN
          RAISE EXCEPTION 'ADDITION_NOT_ALLOWED';
        END IF;
        IF p_total<=0 OR current_order.total::numeric+p_total>9007199254740991 THEN RAISE EXCEPTION 'ADDITION_LIMIT'; END IF;
        combined:=current_order.items;
        -- Keep separate historical price lines. Validate the eventual receipt
        -- before reserving any additional unit of inventory.
        FOR item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'id'
        LOOP
          SELECT (ordinality-1)::integer INTO idx FROM jsonb_array_elements(combined) WITH ORDINALITY existing(value,ordinality)
            WHERE value->>'id'=item->>'id' AND (value->>'price')::bigint=(item->>'price')::bigint LIMIT 1;
          IF FOUND THEN
            next_quantity:=(combined->idx->>'quantity')::bigint+(item->>'quantity')::bigint;
            combined:=jsonb_set(combined,ARRAY[idx::text,'quantity'],to_jsonb(next_quantity));
            combined:=jsonb_set(combined,ARRAY[idx::text,'subtotal'],to_jsonb(next_quantity*(item->>'price')::bigint));
          ELSE combined:=combined||jsonb_build_array(item);
          END IF;
        END LOOP;
        IF jsonb_array_length(combined)>100 THEN RAISE EXCEPTION 'ADDITION_LIMIT'; END IF;
        previous_context:=current_setting('dapoer.stock_context',TRUE);
        PERFORM set_config('dapoer.stock_context',jsonb_build_object('source','order','orderId',p_id,
          'reason','Tambahan menu '||p_addition::text||' pada pesanan yang sama')::text,TRUE);
        FOR item IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'id'
        LOOP
          SELECT stock INTO balance FROM inventory WHERE product_id=item->>'id' FOR UPDATE;
          IF NOT FOUND OR balance<(item->>'quantity')::bigint THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
          UPDATE inventory SET stock=stock-(item->>'quantity')::integer,updated_at=clock_timestamp()
            WHERE product_id=item->>'id';
        END LOOP;
        PERFORM set_config('dapoer.stock_context',COALESCE(previous_context,''),TRUE);
        UPDATE orders SET items=combined,total=total+p_total,
          updated_at=GREATEST(clock_timestamp(),current_order.updated_at+INTERVAL '1 microsecond') WHERE id=p_id;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_request_order_addition(
        p_id TEXT,p_token TEXT,p_request UUID,p_fingerprint TEXT,p_items JSONB,p_total BIGINT,p_expected BIGINT
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE current_order orders%ROWTYPE; prior operation_requests%ROWTYPE; next_status TEXT; saved JSONB;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('order-addition:'||p_request::text,0));
        SELECT * INTO current_order FROM orders WHERE id=p_id AND tracking_token=p_token FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO prior FROM operation_requests WHERE scope='order-addition' AND request_id=p_request;
        IF FOUND THEN
          IF prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
          RETURN dapoer_addition_result(p_id,p_request);
        END IF;
        IF NOT current_order.stock_reserved OR current_order.status NOT IN('baru','diproses') THEN
          RAISE EXCEPTION 'ADDITION_NOT_ALLOWED';
        END IF;
        IF p_expected IS NULL OR p_expected<>p_total THEN RAISE EXCEPTION 'PRICE_CHANGED'; END IF;
        IF EXISTS(SELECT 1 FROM order_additions WHERE order_id=p_id AND status='pending') THEN RAISE EXCEPTION 'ADDITION_PENDING'; END IF;
        IF (SELECT COUNT(*) FROM order_additions WHERE order_id=p_id)>=100 THEN RAISE EXCEPTION 'ADDITION_LIMIT'; END IF;
        IF jsonb_array_length(current_order.items)+(SELECT COUNT(*) FROM jsonb_array_elements(p_items) added
          WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(current_order.items) existing
            WHERE existing->>'id'=added->>'id' AND (existing->>'price')::bigint=(added->>'price')::bigint))>100 THEN
          RAISE EXCEPTION 'ADDITION_LIMIT';
        END IF;
        next_status:=CASE current_order.status WHEN 'baru' THEN 'applied' ELSE 'pending' END;
        IF next_status='applied' THEN PERFORM dapoer_apply_order_addition(p_id,p_items,p_total,p_request); END IF;
        INSERT INTO order_additions(id,order_id,fingerprint,items,total,status)
          VALUES(p_request,p_id,p_fingerprint,p_items,p_total,next_status);
        IF next_status='pending' THEN
          UPDATE orders SET updated_at=GREATEST(clock_timestamp(),current_order.updated_at+INTERVAL '1 microsecond') WHERE id=p_id;
        END IF;
        saved:=dapoer_addition_result(p_id,p_request);
        INSERT INTO operation_requests(scope,request_id,fingerprint,result)
          VALUES('order-addition',p_request,p_fingerprint,jsonb_build_object('orderId',p_id,'additionId',p_request));
        RETURN saved;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_review_order_addition(
        p_id TEXT,p_addition UUID,p_decision TEXT,p_request UUID,p_fingerprint TEXT,
        p_expected_status TEXT,p_expected_updated TIMESTAMPTZ,p_catalog JSONB
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE current_order orders%ROWTYPE; addition order_additions%ROWTYPE;
        prior operation_requests%ROWTYPE; saved JSONB;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('order-addition-review:'||p_request::text,0));
        SELECT * INTO current_order FROM orders WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO prior FROM operation_requests WHERE scope='order-addition-review' AND request_id=p_request;
        IF FOUND THEN
          IF prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
          RETURN dapoer_addition_result(p_id,p_addition);
        END IF;
        SELECT * INTO addition FROM order_additions WHERE id=p_addition AND order_id=p_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'ADDITION_NOT_FOUND'; END IF;
        IF addition.status<>'pending' THEN RAISE EXCEPTION 'ADDITION_ALREADY_REVIEWED'; END IF;
        IF p_expected_status IS NOT NULL AND (current_order.status<>p_expected_status OR current_order.updated_at<>p_expected_updated) THEN
          RAISE EXCEPTION 'ORDER_CONFLICT';
        END IF;
        IF p_decision NOT IN('approve','reject') OR p_decision IS NULL THEN RAISE EXCEPTION 'ADDITION_NOT_ALLOWED'; END IF;
        IF p_decision='approve' THEN
          IF current_order.status<>'diproses' OR NOT current_order.stock_reserved THEN RAISE EXCEPTION 'ADDITION_NOT_ALLOWED'; END IF;
          IF EXISTS(SELECT 1 FROM jsonb_array_elements(addition.items) item
            WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_catalog) product
              WHERE product->>'id'=item->>'id' AND (product->>'price')::bigint=(item->>'price')::bigint)) THEN
            RAISE EXCEPTION 'PRICE_CHANGED';
          END IF;
          PERFORM dapoer_apply_order_addition(p_id,addition.items,addition.total,p_addition);
        ELSE
          UPDATE orders SET updated_at=GREATEST(clock_timestamp(),current_order.updated_at+INTERVAL '1 microsecond') WHERE id=p_id;
        END IF;
        UPDATE order_additions SET status=CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
          updated_at=GREATEST(clock_timestamp(),addition.updated_at+INTERVAL '1 microsecond') WHERE id=p_addition;
        saved:=dapoer_addition_result(p_id,p_addition);
        INSERT INTO operation_requests(scope,request_id,fingerprint,result)
          VALUES('order-addition-review',p_request,p_fingerprint,jsonb_build_object('orderId',p_id,'additionId',p_addition));
        RETURN saved;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_expire_order_additions()
      RETURNS TRIGGER LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.status IN('dikirim','selesai','dibatalkan') AND OLD.status IS DISTINCT FROM NEW.status THEN
          UPDATE order_additions SET status='expired',updated_at=GREATEST(clock_timestamp(),updated_at+INTERVAL '1 microsecond')
            WHERE order_id=NEW.id AND status='pending';
        END IF;
        RETURN NEW;
      END;
      $function$;
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='orders'::regclass AND tgname='dapoer_expire_order_additions_v1') THEN
        -- Never queue a schema lock behind a live inventory mutation.
        LOCK TABLE orders IN SHARE ROW EXCLUSIVE MODE NOWAIT;
        CREATE TRIGGER dapoer_expire_order_additions_v1 AFTER UPDATE OF status ON orders
          FOR EACH ROW EXECUTE FUNCTION dapoer_expire_order_additions();
      END IF;
    END;
    $addition_schema$
  `;
}

async function requestOrderAddition(input, providedSql) {
  const operationId = identity(input, true);
  const displayedTotal = expectedTotal(input.expectedTotal);
  if (displayedTotal === null) throw operationError("INVALID_EXPECTED_TOTAL");
  const items = normalizeAddition(input.items);
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  const intentFingerprint = fingerprint({ action: "add-menu", id: input.id, token: input.trackingToken,
    items: items.map(({ id, quantity }) => ({ id, quantity })), expectedTotal: displayedTotal });
  const sql = providedSql || await require("./db").ensureSchema();
  if (!sql) throw operationError("DATABASE_NOT_CONFIGURED");
  try {
    const rows = await sql`SELECT dapoer_request_order_addition(${input.id},${input.trackingToken},${operationId}::uuid,
      ${intentFingerprint},${JSON.stringify(items)}::jsonb,${total}::bigint,${displayedTotal}::bigint) AS result`;
    return rows[0]?.result || null;
  } catch (error) { rethrow(error); }
}

async function reviewOrderAddition(input, providedSql) {
  const operationId = identity(input);
  const additionId = requestId(input.additionId);
  if (!additionId) throw operationError("INVALID_REQUEST_ID");
  if (!["approve", "reject"].includes(input.decision)) throw operationError("ADDITION_NOT_ALLOWED");
  const observed = validateExpectedStatus(input);
  if (!observed) throw operationError("INVALID_EXPECTED_STATUS");
  const intentFingerprint = fingerprint({ action: "review-menu", id: input.id, additionId,
    decision: input.decision, expectedStatus: observed?.expectedStatus ?? null, expectedUpdatedAt: observed?.expectedUpdatedAt ?? null });
  const sql = providedSql || await require("./db").ensureSchema();
  if (!sql) throw operationError("DATABASE_NOT_CONFIGURED");
  try {
    const rows = await sql`SELECT dapoer_review_order_addition(${input.id},${additionId}::uuid,${input.decision},
      ${operationId}::uuid,${intentFingerprint},${observed?.expectedStatus ?? null},${observed?.expectedUpdatedAt ?? null}::timestamptz,
      ${JSON.stringify(PRODUCTS.map(({ id, price }) => ({ id, price })))}::jsonb) AS result`;
    return rows[0]?.result || null;
  } catch (error) { rethrow(error); }
}

module.exports = { ensureOrderAdditionsSchema, normalizeAddition, requestOrderAddition, reviewOrderAddition };
