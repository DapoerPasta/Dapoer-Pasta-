const { PRODUCTS } = require("./catalog");
const { ensureSchema } = require("./db");

const MAX_STOCK = 1000000;
const byId = new Map(PRODUCTS.map(product => [product.id, product]));

function inventoryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateStockAdjustment(id, delta) {
  if (!byId.has(id) || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_STOCK) {
    throw inventoryError("INVALID_STOCK_ADJUSTMENT");
  }
}

async function listInventory() {
  const sql = await ensureSchema();
  if (!sql) throw inventoryError("DATABASE_NOT_CONFIGURED");
  const rows = await sql`SELECT product_id, stock FROM inventory`;
  const counts = new Map(rows.map(row => [row.product_id, Number(row.stock)]));
  return PRODUCTS.map(product => ({ ...product, stock: counts.get(product.id) ?? 0 }));
}

async function adjustStock(id, delta) {
  validateStockAdjustment(id, delta);
  const sql = await ensureSchema();
  if (!sql) throw inventoryError("DATABASE_NOT_CONFIGURED");
  // PostgreSQL rechecks this condition after waiting for concurrent UPDATEs.
  // Additive changes never replace an administrator's or customer's update.
  const rows = await sql`
    UPDATE inventory SET stock = stock + ${delta}, updated_at = NOW()
    WHERE product_id = ${id} AND stock::bigint + ${delta} >= 0
      AND (${delta} < 0 OR stock::bigint + ${delta} <= ${MAX_STOCK})
    RETURNING product_id, stock
  `;
  if (!rows[0]) throw inventoryError(delta < 0 ? "INSUFFICIENT_STOCK" : "INVALID_STOCK_ADJUSTMENT");
  return { ...byId.get(id), stock: Number(rows[0].stock) };
}

module.exports = { MAX_STOCK, listInventory, adjustStock, validateStockAdjustment };
