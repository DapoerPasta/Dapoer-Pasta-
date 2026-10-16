const crypto = require("node:crypto");

function operationError(code) {
  return Object.assign(new Error(code), { code });
}

function requestId(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw operationError("INVALID_REQUEST_ID");
  }
  return value.toLowerCase();
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function expectedTotal(value) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw operationError("INVALID_EXPECTED_TOTAL");
  return value;
}

function orderFingerprint(order) {
  // Prices are deliberately excluded: a retry must find its committed order
  // before comparing the now-current catalog against the displayed total.
  return fingerprint({
    items: order.items.map(({ id, quantity }) => ({ id, quantity })).sort((a, b) => a.id.localeCompare(b.id)),
    customer: { name: order.customer.name, phone: order.customer.phone, address: order.customer.address,
      notes: order.customer.notes, paymentMethod: order.customer.paymentMethod },
    expectedTotal: order.expectedTotal ?? null,
    // Keep old/default delivery hashes byte-for-byte compatible. Pickup must
    // conflict with a replay of the same UUID made for a delivery checkout.
    ...((order.deliveryMethod ?? order.customer.deliveryMethod) === "pickup" ? { deliveryMethod: "pickup" } : {})
  });
}

function rethrowOperationError(error) {
  const codes = new Set(["INSUFFICIENT_STOCK", "ORDER_CANCELLED", "REQUEST_CONFLICT", "PRICE_CHANGED",
    "ORDER_CONFLICT", "INVALID_STATUS_TRANSITION", "CANCELLATION_NOT_ALLOWED", "STOCK_CONFLICT",
    "INVALID_STOCK_ADJUSTMENT", "INVALID_STOCK_SET"]);
  if (codes.has(error?.message)) throw operationError(error.message);
  throw error;
}

function validateExpectedStatus(options = {}) {
  const { expectedStatus, expectedUpdatedAt } = options;
  if (expectedStatus === undefined && expectedUpdatedAt === undefined) return null;
  const statuses = ["baru", "diproses", "dikirim", "selesai", "dibatalkan"];
  const match = typeof expectedUpdatedAt === "string" && expectedUpdatedAt.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/);
  const offset = typeof expectedUpdatedAt === "string" && expectedUpdatedAt.match(/[+-](\d{2}):(\d{2})$/);
  const calendarDate = match && new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (!statuses.includes(expectedStatus) || !match || Number(match[1]) < 1 ||
      !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0,10) !== `${match[1]}-${match[2]}-${match[3]}` ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 ||
      (offset && (Number(offset[1]) > 15 || Number(offset[2]) > 59)) ||
      !Number.isFinite(new Date(expectedUpdatedAt).getTime())) throw operationError("INVALID_EXPECTED_STATUS");
  return { expectedStatus, expectedUpdatedAt };
}

async function ensureOperationsSchema(sql) {
  // One statement transaction and one lock serialize new cold instances.
  // No request key is committed until its mutation and response snapshot are.
  await sql`
    DO $operations_schema$
    BEGIN
      PERFORM pg_advisory_xact_lock(1885433957, 115);
      CREATE TABLE IF NOT EXISTS operation_requests (
        scope TEXT NOT NULL,
        request_id UUID NOT NULL,
        fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
        result JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (scope, request_id)
      );
      CREATE TABLE IF NOT EXISTS order_status_transitions (
        order_id TEXT PRIMARY KEY REFERENCES orders(id),
        expected_status TEXT NOT NULL,
        expected_updated_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL,
        result JSONB NOT NULL
      );

      CREATE OR REPLACE FUNCTION dapoer_save_order_once(
        p_id TEXT, p_name TEXT, p_phone TEXT, p_address TEXT, p_notes TEXT,
        p_payment TEXT, p_items JSONB, p_total BIGINT, p_tracking_token TEXT,
        p_request_id UUID, p_fingerprint TEXT, p_expected_total BIGINT
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE previous operation_requests%ROWTYPE; saved JSONB;
      BEGIN
        IF p_request_id IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('checkout:' || p_request_id::text, 0));
          SELECT * INTO previous FROM operation_requests WHERE scope='checkout' AND request_id=p_request_id;
          IF FOUND THEN
            IF previous.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
            RETURN previous.result;
          END IF;
        END IF;
        IF p_expected_total IS NOT NULL AND p_expected_total <> p_total THEN RAISE EXCEPTION 'PRICE_CHANGED'; END IF;
        PERFORM dapoer_save_order(p_id,p_name,p_phone,p_address,p_notes,p_payment,p_items,p_total,p_tracking_token);
        SELECT jsonb_build_object('id',id,'customer',jsonb_build_object('name',customer_name,
          'phone',customer_phone,'address',address,'notes',notes,'paymentMethod',payment_method),
          'items',items,'total',total,'trackingToken',tracking_token,'queueNumber',queue_number,
          'queueDate',queue_date,'createdAt',created_at,'updatedAt',updated_at)
          INTO saved FROM orders WHERE id=p_id AND tracking_token=p_tracking_token;
        IF saved IS NULL THEN RAISE EXCEPTION 'ORDER_SAVE_UNCONFIRMED'; END IF;
        IF p_request_id IS NOT NULL THEN
          INSERT INTO operation_requests(scope,request_id,fingerprint,result) VALUES('checkout',p_request_id,p_fingerprint,saved);
        END IF;
        RETURN saved;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_change_stock_once(
        p_id TEXT, p_delta INTEGER, p_target INTEGER, p_expected INTEGER,
        p_request_id UUID, p_fingerprint TEXT, p_reason TEXT
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE previous operation_requests%ROWTYPE; saved JSONB; previous_stock_context TEXT;
      BEGIN
        IF p_request_id IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || p_request_id::text, 0));
          SELECT * INTO previous FROM operation_requests WHERE scope='stock' AND request_id=p_request_id;
          IF FOUND THEN
            IF previous.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
            RETURN previous.result;
          END IF;
        END IF;
        previous_stock_context:=current_setting('dapoer.stock_context',TRUE);
        PERFORM set_config('dapoer.stock_context',jsonb_build_object(
          'source',CASE WHEN p_delta>0 THEN 'restock' ELSE 'adjustment' END,
          'reason',COALESCE(NULLIF(p_reason,''),CASE WHEN p_delta>0 THEN 'Penambahan stok oleh admin'
            WHEN p_delta<0 THEN 'Pengurangan stok oleh admin' WHEN p_target=0 THEN 'Stok dikosongkan oleh admin'
            ELSE 'Jumlah stok ditetapkan oleh admin' END))::text,TRUE);
        IF p_delta IS NOT NULL THEN
          UPDATE inventory SET stock=stock+p_delta,updated_at=clock_timestamp()
            WHERE product_id=p_id AND stock::bigint+p_delta>=0
              AND (p_delta<0 OR stock::bigint+p_delta<=1000000)
            RETURNING jsonb_build_object('product_id',product_id,'stock',stock) INTO saved;
          IF saved IS NULL THEN
            IF p_delta<0 THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; ELSE RAISE EXCEPTION 'INVALID_STOCK_ADJUSTMENT'; END IF;
          END IF;
        ELSE
          UPDATE inventory SET stock=p_target,updated_at=clock_timestamp()
            WHERE product_id=p_id AND stock=p_expected
            RETURNING jsonb_build_object('product_id',product_id,'stock',stock) INTO saved;
          IF saved IS NULL THEN RAISE EXCEPTION 'STOCK_CONFLICT'; END IF;
        END IF;
        PERFORM set_config('dapoer.stock_context',COALESCE(previous_stock_context,''),TRUE);
        IF p_request_id IS NOT NULL THEN
          INSERT INTO operation_requests(scope,request_id,fingerprint,result) VALUES('stock',p_request_id,p_fingerprint,saved);
        END IF;
        RETURN saved;
      END;
      $function$;
      -- Preserve the original SQL signature for in-flight/legacy clients.
      CREATE OR REPLACE FUNCTION dapoer_change_stock_once(
        p_id TEXT,p_delta INTEGER,p_target INTEGER,p_expected INTEGER,p_request_id UUID,p_fingerprint TEXT
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      BEGIN RETURN dapoer_change_stock_once(p_id,p_delta,p_target,p_expected,p_request_id,p_fingerprint,''); END;
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_update_order_status_checked(
        p_id TEXT,p_status TEXT,p_expected_status TEXT,p_expected_updated_at TIMESTAMPTZ
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE current_order orders%ROWTYPE; previous order_status_transitions%ROWTYPE; saved JSONB;
      BEGIN
        SELECT * INTO current_order FROM orders WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO previous FROM order_status_transitions WHERE order_id=p_id;
        IF FOUND AND previous.expected_status=p_expected_status AND previous.expected_updated_at=p_expected_updated_at
          AND previous.status=p_status AND current_order.status=p_status
          AND (previous.result->>'updated_at')::timestamptz=current_order.updated_at THEN RETURN previous.result; END IF;
        IF current_order.status<>p_expected_status OR current_order.updated_at<>p_expected_updated_at THEN
          RAISE EXCEPTION 'ORDER_CONFLICT';
        END IF;
        IF current_order.status=p_status THEN
          RETURN jsonb_build_object('id',current_order.id,'status',current_order.status,
            'updated_at',current_order.updated_at,'updatedAt',current_order.updated_at);
        END IF;
        saved:=dapoer_update_order_status(p_id,p_status);
        INSERT INTO order_status_transitions(order_id,expected_status,expected_updated_at,status,result)
          VALUES(p_id,p_expected_status,p_expected_updated_at,p_status,saved)
          ON CONFLICT(order_id) DO UPDATE SET expected_status=EXCLUDED.expected_status,
            expected_updated_at=EXCLUDED.expected_updated_at,status=EXCLUDED.status,result=EXCLUDED.result;
        RETURN saved;
      END;
      $function$;
    END;
    $operations_schema$
  `;
}

module.exports = { operationError, requestId, fingerprint, expectedTotal, orderFingerprint,
  rethrowOperationError, validateExpectedStatus, ensureOperationsSchema };
