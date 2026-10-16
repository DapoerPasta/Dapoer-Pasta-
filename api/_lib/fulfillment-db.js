const { operationError, fingerprint } = require("./operations");
const { validateShippingUpdate } = require("./fulfillment");

async function ensureFulfillmentSchema(sql) {
  await sql`
    DO $fulfillment_schema$
    BEGIN
      PERFORM pg_advisory_xact_lock(1885433957,121);
      IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='orders'::regclass AND attname='delivery_method' AND NOT attisdropped)
         OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='orders'::regclass AND attname='shipping_fee' AND NOT attisdropped) THEN
        -- A genuine migration must not queue behind order -> inventory work.
        LOCK TABLE orders IN ACCESS EXCLUSIVE MODE NOWAIT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'delivery'
          CHECK(delivery_method IN('delivery','pickup'));
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_fee BIGINT CHECK(shipping_fee BETWEEN 0 AND 100000000);
      END IF;

      CREATE OR REPLACE FUNCTION dapoer_fulfillment_metadata(p_method TEXT,p_fee BIGINT,p_total BIGINT)
      RETURNS JSONB LANGUAGE sql IMMUTABLE AS $function$
        SELECT jsonb_build_object('deliveryMethod',p_method,'shippingFee',p_fee,
          'itemsSubtotal',p_total-COALESCE(p_fee,0),'shippingConfirmed',p_fee IS NOT NULL,
          'grandTotal',CASE WHEN p_fee IS NOT NULL THEN p_total ELSE NULL END)
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_save_order_fulfillment_recorded(
        p_id TEXT,p_name TEXT,p_phone TEXT,p_address TEXT,p_notes TEXT,p_payment TEXT,p_items JSONB,
        p_total BIGINT,p_tracking_token TEXT,p_request_id UUID,p_fingerprint TEXT,p_expected_total BIGINT,p_method TEXT
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE prior operation_requests%ROWTYPE; saved JSONB; current_order orders%ROWTYPE;
      BEGIN
        IF p_method IS NULL OR p_method NOT IN('delivery','pickup') THEN RAISE EXCEPTION 'INVALID_DELIVERY_METHOD'; END IF;
        IF p_request_id IS NOT NULL THEN
          -- Match the original checkout lock before testing its immutable result.
          PERFORM pg_advisory_xact_lock(hashtextextended('checkout:'||p_request_id::text,0));
          SELECT * INTO prior FROM operation_requests WHERE scope='checkout' AND request_id=p_request_id;
          IF FOUND THEN
            IF prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
            -- Never replace an old checkout snapshot with subsequently edited
            -- quantities, shipping fees, addresses, status or queue metadata.
            RETURN prior.result || CASE WHEN prior.result ? 'deliveryMethod' THEN '{}'::jsonb ELSE
              dapoer_fulfillment_metadata('delivery',NULL,(prior.result->>'total')::bigint) END;
          END IF;
        END IF;
        IF p_request_id IS NOT NULL OR p_expected_total IS NOT NULL THEN
          saved:=dapoer_save_order_once_recorded(p_id,p_name,p_phone,p_address,p_notes,p_payment,p_items,p_total,
            p_tracking_token,p_request_id,p_fingerprint,p_expected_total);
        ELSE
          saved:=dapoer_save_order_with_queue_recorded(p_id,p_name,p_phone,p_address,p_notes,p_payment,p_items,p_total,p_tracking_token);
        END IF;
        UPDATE orders SET delivery_method=p_method,shipping_fee=CASE WHEN p_method='pickup' THEN 0 ELSE NULL END
          WHERE id=p_id AND tracking_token=p_tracking_token RETURNING * INTO current_order;
        IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_SAVE_UNCONFIRMED'; END IF;
        saved:=jsonb_build_object('id',current_order.id,'customer',jsonb_build_object('name',current_order.customer_name,
          'phone',current_order.customer_phone,'address',current_order.address,'notes',current_order.notes,
          'paymentMethod',current_order.payment_method),'items',current_order.items,'total',current_order.total,
          'trackingToken',current_order.tracking_token,'queueNumber',current_order.queue_number,
          'queueDate',current_order.queue_date,'createdAt',current_order.created_at,'updatedAt',current_order.updated_at)
          ||dapoer_fulfillment_metadata(current_order.delivery_method,current_order.shipping_fee,current_order.total);
        IF p_request_id IS NOT NULL THEN
          UPDATE operation_requests SET result=saved WHERE scope='checkout' AND request_id=p_request_id;
        END IF;
        RETURN saved;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_update_order_shipping(
        p_id TEXT,p_fee BIGINT,p_request UUID,p_fingerprint TEXT,p_status TEXT,p_updated TIMESTAMPTZ
      ) RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE prior operation_requests%ROWTYPE; current_order orders%ROWTYPE; saved JSONB;
      BEGIN
        IF p_fee IS NULL OR p_fee<0 OR p_fee>100000000 THEN RAISE EXCEPTION 'INVALID_SHIPPING_FEE'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('order-shipping:'||p_request::text,0));
        SELECT * INTO current_order FROM orders WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO prior FROM operation_requests WHERE scope='order-shipping' AND request_id=p_request;
        IF FOUND THEN
          IF prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
          RETURN prior.result;
        END IF;
        IF p_status IS NULL OR p_updated IS NULL OR current_order.status<>p_status OR current_order.updated_at<>p_updated THEN
          RAISE EXCEPTION 'ORDER_CONFLICT';
        END IF;
        IF current_order.status NOT IN('baru','diproses') OR (current_order.delivery_method='pickup' AND p_fee<>0) THEN
          RAISE EXCEPTION 'SHIPPING_NOT_ALLOWED';
        END IF;
        IF current_order.shipping_fee IS DISTINCT FROM p_fee THEN
          IF current_order.total::numeric-COALESCE(current_order.shipping_fee,0)+p_fee>9007199254740991 THEN
            RAISE EXCEPTION 'INVALID_SHIPPING_FEE';
          END IF;
          UPDATE orders SET shipping_fee=p_fee,total=total-COALESCE(shipping_fee,0)+p_fee,
            updated_at=GREATEST(clock_timestamp(),current_order.updated_at+INTERVAL '1 microsecond')
            WHERE id=p_id RETURNING * INTO current_order;
        END IF;
        saved:=to_jsonb(current_order)||dapoer_fulfillment_metadata(current_order.delivery_method,current_order.shipping_fee,current_order.total);
        INSERT INTO operation_requests(scope,request_id,fingerprint,result) VALUES('order-shipping',p_request,p_fingerprint,saved);
        RETURN saved;
      END;
      $function$;
    END;
    $fulfillment_schema$
  `;
}

async function updateOrderShipping(input, providedSql) {
  const value = validateShippingUpdate(input);
  const intent = fingerprint({ action: "order-shipping", ...value, requestId: undefined });
  const sql = providedSql || await require("./db").ensureSchema();
  if (!sql) throw operationError("DATABASE_NOT_CONFIGURED");
  try {
    const rows = await sql`SELECT dapoer_update_order_shipping(${value.id},${value.shippingFee}::bigint,
      ${value.requestId}::uuid,${intent},${value.expectedStatus},${value.expectedUpdatedAt}::timestamptz) AS result`;
    return rows[0]?.result || null;
  } catch (error) {
    if (["INVALID_SHIPPING_FEE", "ORDER_CONFLICT", "SHIPPING_NOT_ALLOWED", "REQUEST_CONFLICT"].includes(error?.message)) {
      throw operationError(error.message);
    }
    throw error;
  }
}

module.exports = { ensureFulfillmentSchema, updateOrderShipping };
