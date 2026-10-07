const { neon } = require("@neondatabase/serverless");
const { TIME_ZONE, createHistoryOptions } = require("./order-history");
const { PRODUCTS } = require("./catalog");

let schemaPromise;
let schemaDatabaseUrl;

function getSql() {
  if (!process.env.DATABASE_URL) return null;
  return neon(process.env.DATABASE_URL);
}

async function ensureSchema() {
  const sql = getSql();
  if (!sql) return null;
  if (schemaDatabaseUrl !== process.env.DATABASE_URL) {
    schemaPromise = undefined;
    schemaDatabaseUrl = process.env.DATABASE_URL;
  }
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        address TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        payment_method TEXT NOT NULL,
        items JSONB NOT NULL,
        total BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'baru',
        tracking_token TEXT,
        stock_reserved BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_token TEXT`;
      await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_reserved BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS orders_tracking_token_idx ON orders(tracking_token) WHERE tracking_token IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS orders_created_at_id_idx ON orders(created_at DESC, id DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS inventory (
          product_id TEXT PRIMARY KEY,
          stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        INSERT INTO inventory (product_id, stock)
        SELECT value, 0 FROM jsonb_array_elements_text(${JSON.stringify(PRODUCTS.map(product => product.id))}::jsonb)
        ON CONFLICT (product_id) DO NOTHING
      `;
      // A PostgreSQL function runs in the statement transaction, also over
      // Neon's HTTP driver. Exceptions roll back every deduction and INSERT.
      // Lock in product-id order; read balances after acquiring each row lock.
      await sql`
        CREATE OR REPLACE FUNCTION dapoer_save_order(
          p_id TEXT, p_name TEXT, p_phone TEXT, p_address TEXT, p_notes TEXT,
          p_payment TEXT, p_items JSONB, p_total BIGINT, p_tracking_token TEXT
        ) RETURNS BOOLEAN LANGUAGE plpgsql AS $function$
        DECLARE
          item RECORD;
          available INTEGER;
        BEGIN
          IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK';
          END IF;
          FOR item IN
            SELECT id, SUM(quantity) AS quantity
            FROM jsonb_to_recordset(p_items) AS requested(id TEXT, quantity BIGINT)
            GROUP BY id ORDER BY id
          LOOP
            SELECT stock INTO available FROM inventory
            WHERE product_id = item.id FOR UPDATE;
            IF NOT FOUND OR item.quantity IS NULL OR item.quantity < 1 OR available < item.quantity THEN
              RAISE EXCEPTION 'INSUFFICIENT_STOCK';
            END IF;
            UPDATE inventory SET stock = stock - item.quantity, updated_at = NOW()
            WHERE product_id = item.id;
          END LOOP;
          INSERT INTO orders (
            id, customer_name, customer_phone, address, notes, payment_method,
            items, total, status, tracking_token, stock_reserved
          ) VALUES (
            p_id, p_name, p_phone, p_address, p_notes, p_payment,
            p_items, p_total, 'baru', p_tracking_token, TRUE
          );
          RETURN TRUE;
        END;
        $function$
      `;
      await sql`
        CREATE OR REPLACE FUNCTION dapoer_update_order_status(p_id TEXT, p_status TEXT)
        RETURNS JSONB LANGUAGE plpgsql AS $function$
        DECLARE
          current_order orders%ROWTYPE;
          item RECORD;
          result JSONB;
        BEGIN
          SELECT * INTO current_order FROM orders WHERE id = p_id FOR UPDATE;
          IF NOT FOUND THEN RETURN NULL; END IF;
          IF current_order.status = 'dibatalkan' AND current_order.stock_reserved
             AND p_status <> 'dibatalkan' THEN
            RAISE EXCEPTION 'ORDER_CANCELLED';
          END IF;
          IF p_status = 'dibatalkan' AND current_order.status <> 'dibatalkan'
             AND current_order.stock_reserved THEN
            FOR item IN
              SELECT id, SUM(quantity) AS quantity
              FROM jsonb_to_recordset(current_order.items) AS reserved(id TEXT, quantity BIGINT)
              GROUP BY id ORDER BY id
            LOOP
              PERFORM 1 FROM inventory WHERE product_id = item.id FOR UPDATE;
              UPDATE inventory SET stock = stock + item.quantity, updated_at = NOW()
              WHERE product_id = item.id;
            END LOOP;
          END IF;
          UPDATE orders SET status = p_status, updated_at = NOW() WHERE id = p_id
          RETURNING jsonb_build_object('id', id, 'status', status, 'updated_at', updated_at) INTO result;
          RETURN result;
        END;
        $function$
      `;
    })().catch(error => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
  return sql;
}

function stockError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function rethrowStockError(error) {
  if (["INSUFFICIENT_STOCK", "ORDER_CANCELLED"].includes(error?.message)) {
    throw stockError(error.message);
  }
  throw error;
}

async function saveOrder(order) {
  const sql = await ensureSchema();
  if (!sql) throw stockError("DATABASE_NOT_CONFIGURED");
  try {
    await sql`
    SELECT dapoer_save_order(
      ${order.id}, ${order.customer.name}, ${order.customer.phone},
      ${order.customer.address}, ${order.customer.notes},
      ${order.customer.paymentMethod}, ${JSON.stringify(order.items)}::jsonb,
      ${order.total}::bigint, ${order.trackingToken}
    )
  `;
  } catch (error) {
    rethrowStockError(error);
  }
  return true;
}

async function listOrders(limit = 100) {
  const sql = await ensureSchema();
  if (!sql) throw new Error("DATABASE_NOT_CONFIGURED");
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return sql`
    SELECT id, customer_name, customer_phone, address, notes,
           payment_method, items, total, status, tracking_token, created_at, updated_at
    FROM orders
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
}

async function listOrdersByDate(options = {}) {
  // Validate again before schema or order queries so direct callers are safe too.
  const { date, page, pageSize, offset, start, end } = createHistoryOptions(options);
  const sql = await ensureSchema();
  if (!sql) throw new Error("DATABASE_NOT_CONFIGURED");
  // The page and full-day totals share one Postgres snapshot, including empty pages.
  const rows = await sql`
    WITH day_summary AS (
      SELECT COUNT(*) AS total_orders,
             COUNT(*) FILTER (WHERE status = 'baru') AS new_orders,
             COUNT(*) FILTER (WHERE status IN ('diproses', 'dikirim')) AS processing_orders,
             COALESCE(SUM(total) FILTER (WHERE status <> 'dibatalkan'), 0) AS order_value
      FROM orders
      WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
    ), page_orders AS (
      SELECT id, customer_name, customer_phone, address, notes,
             payment_method, items, total, status, tracking_token, created_at, updated_at
      FROM orders
      WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    )
    SELECT day_summary.*,
           (SELECT COALESCE(jsonb_agg(page_orders ORDER BY created_at DESC, id DESC), '[]'::jsonb)
            FROM page_orders) AS orders
    FROM day_summary
  `;
  const result = rows[0];
  const total = Number(result.total_orders);
  const totalPages = Math.ceil(total / pageSize);
  return {
    orders: result.orders,
    date,
    timeZone: TIME_ZONE,
    pagination: { page, pageSize, total, totalPages, hasMore: page < totalPages },
    summary: {
      totalOrders: total,
      newOrders: Number(result.new_orders),
      processingOrders: Number(result.processing_orders),
      orderValue: Number(result.order_value)
    }
  };
}

async function getPublicOrderStatus(id, trackingToken) {
  const sql = await ensureSchema();
  if (!sql) throw new Error("DATABASE_NOT_CONFIGURED");
  const rows = await sql`
    SELECT id, customer_name, customer_phone, address, notes, items, total, status, payment_method, created_at, updated_at
    FROM orders
    WHERE id = ${id} AND tracking_token = ${trackingToken}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function updateOrderStatus(id, status) {
  const sql = await ensureSchema();
  if (!sql) throw new Error("DATABASE_NOT_CONFIGURED");
  try {
    const rows = await sql`SELECT dapoer_update_order_status(${id}, ${status}) AS "order"`;
    return rows[0]?.order || null;
  } catch (error) {
    rethrowStockError(error);
  }
}

module.exports = { getSql, ensureSchema, saveOrder, listOrders, listOrdersByDate, getPublicOrderStatus, updateOrderStatus };
