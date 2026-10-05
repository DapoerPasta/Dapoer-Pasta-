const { neon } = require("@neondatabase/serverless");

let schemaPromise;

function getSql() {
  if (!process.env.DATABASE_URL) return null;
  return neon(process.env.DATABASE_URL);
}

async function ensureSchema() {
  const sql = getSql();
  if (!sql) return null;
  if (!schemaPromise) {
    schemaPromise = sql`
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  }
  await schemaPromise;
  return sql;
}

async function saveOrder(order) {
  const sql = await ensureSchema();
  if (!sql) return false;
  await sql`
    INSERT INTO orders (
      id, customer_name, customer_phone, address, notes,
      payment_method, items, total, status
    ) VALUES (
      ${order.id}, ${order.customer.name}, ${order.customer.phone},
      ${order.customer.address}, ${order.customer.notes},
      ${order.customer.paymentMethod}, ${JSON.stringify(order.items)}::jsonb,
      ${order.total}, 'baru'
    )
  `;
  return true;
}

async function listOrders(limit = 100) {
  const sql = await ensureSchema();
  if (!sql) throw new Error("DATABASE_NOT_CONFIGURED");
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return sql`
    SELECT id, customer_name, customer_phone, address, notes,
           payment_method, items, total, status, created_at, updated_at
    FROM orders
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `;
}

async function updateOrderStatus(id, status) {
  const sql = await ensureSchema();
  if (!sql) throw new Error("DATABASE_NOT_CONFIGURED");
  const rows = await sql`
    UPDATE orders
    SET status = ${status}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, status, updated_at
  `;
  return rows[0] || null;
}

module.exports = { getSql, ensureSchema, saveOrder, listOrders, updateOrderStatus };
