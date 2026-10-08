// Optional integration suite; excluded from `npm test` because it needs PostgreSQL.
// Run against an isolated LOCAL database whose name begins with dapoer_stock_test:
// STOCK_TEST_DATABASE_URL=postgresql://localhost/dapoer_stock_test \
// STOCK_TEST_PG_MODULE=/path/to/pg node --test test/inventory-postgres.integration.cjs
// pg may be installed outside this checkout; application dependencies stay unchanged.
const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { PRODUCTS } = require("../api/_lib/catalog");

const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
let pool, adminPool, db, inventory;
const schema = `stock_integration_${process.pid}`;
const previousDatabaseUrl = process.env.DATABASE_URL;
const [firstProduct, secondProduct] = [...PRODUCTS].sort((a, b) => a.id.localeCompare(b.id));
let sequence = 0;

function order(items, overrides = {}) {
  const id = `stock-integration-${++sequence}`;
  return {
    id,
    trackingToken: `tracking-${id}`,
    customer: { name: "Local integration customer", phone: "081234567890", address: "Test address", notes: "", paymentMethod: "DANA" },
    items: items.map(([product, quantity]) => ({ id: product.id, name: product.name, price: product.price, quantity })),
    total: items.reduce((sum, [product, quantity]) => sum + product.price * quantity, 0),
    ...overrides
  };
}

async function stock(product = firstProduct) {
  const result = await pool.query("SELECT stock FROM inventory WHERE product_id = $1", [product.id]);
  return result.rows[0].stock;
}

async function reset() {
  await pool.query("TRUNCATE orders");
  await pool.query("UPDATE inventory SET stock = 0");
}

function requireThroughPostgres(sql) {
  const dbPath = require.resolve("../api/_lib/db");
  const inventoryPath = require.resolve("../api/_lib/inventory");
  delete require.cache[dbPath];
  delete require.cache[inventoryPath];
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === dbPath && name === "@neondatabase/serverless") return { neon: () => sql };
    return originalLoad.call(this, name, parent, isMain);
  };
  try { return { db: require(dbPath), inventory: require(inventoryPath) }; }
  finally { Module._load = originalLoad; }
}

describe("real PostgreSQL stock transactions", { skip: !enabled, concurrency: false }, () => {
  before(async () => {
    const url = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only a local scratch database is allowed");
    assert.match(url.pathname, /^\/dapoer_stock_test(?:_[a-z0-9_]+)?$/, "Use a dedicated dapoer_stock_test database");
    const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=8000`
    });
    // Only the Neon transport is replaced. The application's emitted SQL,
    // functions, constraints and real PostgreSQL locking all execute unchanged.
    const sql = async (parts, ...values) => {
      const text = typeof parts === "string" ? parts : parts.reduce((result, part, index) => result + (index ? `$${index}` : "") + part, "");
      return (await pool.query(text, values)).rows;
    };
    sql.query = async (text, values = []) => (await pool.query(text, values)).rows;
    process.env.DATABASE_URL = databaseUrl;
    ({ db, inventory } = requireThroughPostgres(sql));
    await db.ensureSchema();
  });

  beforeEach(reset);

  after(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    delete require.cache[require.resolve("../api/_lib/db")];
    delete require.cache[require.resolve("../api/_lib/inventory")];
  });

  test("all existing products start at zero and adjustments cannot make stock negative", async () => {
    const products = await inventory.listInventory();
    assert.equal(products.length, PRODUCTS.length);
    assert.ok(products.every(product => product.stock === 0));
    assert.equal((await inventory.adjustStock(firstProduct.id, 5)).stock, 5);
    assert.equal((await inventory.adjustStock(firstProduct.id, -2)).stock, 3);
    await assert.rejects(() => inventory.adjustStock(firstProduct.id, -4));
    assert.equal(await stock(), 3);
  });

  test("exact stock edits can increase, decrease and clear previously entered counts", async () => {
    assert.equal((await inventory.setStock(firstProduct.id, 12, 0)).stock, 12);
    assert.equal((await inventory.setStock(firstProduct.id, 3, 12)).stock, 3);
    assert.equal((await inventory.setStock(firstProduct.id, 0, 3)).stock, 0);
    assert.equal((await inventory.setStock(firstProduct.id, inventory.MAX_STOCK, 0)).stock, inventory.MAX_STOCK);
    assert.equal((await inventory.setStock(firstProduct.id, 0, inventory.MAX_STOCK)).stock, 0);
    assert.equal(await stock(), 0);
  });

  test("an edit based on stale stock cannot overwrite a completed checkout or admin adjustment", async () => {
    await inventory.setStock(firstProduct.id, 5, 0);
    await db.saveOrder(order([[firstProduct, 1]]));
    await assert.rejects(() => inventory.setStock(firstProduct.id, 0, 5), error => error.code === "STOCK_CONFLICT");
    assert.equal(await stock(), 4);
    await inventory.adjustStock(firstProduct.id, 2);
    await assert.rejects(() => inventory.setStock(firstProduct.id, 3, 4), error => error.code === "STOCK_CONFLICT");
    assert.equal(await stock(), 6);
    assert.equal((await inventory.setStock(firstProduct.id, 3, 6)).stock, 3);
  });

  test("two editors using the same observed stock cannot replace each other's updates", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await reset();
      await inventory.adjustStock(firstProduct.id, 5);
      const results = await Promise.allSettled([
        inventory.setStock(firstProduct.id, 0, 5),
        inventory.setStock(firstProduct.id, 8, 5)
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.find(result => result.status === "rejected").reason.code, "STOCK_CONFLICT");
      assert.equal(await stock(), results.find(result => result.status === "fulfilled").value.stock);
    }
  });

  test("checkout racing an exact stock edit keeps the order deduction or rejects the stale edit", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await reset();
      await inventory.adjustStock(firstProduct.id, 5);
      const results = await Promise.allSettled([
        db.saveOrder(order([[firstProduct, 1]])),
        inventory.setStock(firstProduct.id, 3, 5)
      ]);
      assert.equal(results[0].status, "fulfilled");
      if (results[1].status === "fulfilled") assert.equal(await stock(), 2);
      else {
        assert.equal(results[1].reason.code, "STOCK_CONFLICT");
        assert.equal(await stock(), 4);
      }
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count, 1);
    }
  });

  test("clearing stock while checkout runs cannot erase a successful reservation", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await reset();
      await inventory.adjustStock(firstProduct.id, 5);
      const results = await Promise.allSettled([
        db.saveOrder(order([[firstProduct, 1]])),
        inventory.setStock(firstProduct.id, 0, 5)
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      if (results[0].status === "fulfilled") {
        assert.equal(results[1].reason.code, "STOCK_CONFLICT");
        assert.equal(await stock(), 4);
      } else {
        assert.match(results[0].reason.message, /INSUFFICIENT_STOCK/);
        assert.equal(await stock(), 0);
      }
      const orders = (await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count;
      assert.equal(orders, results[0].status === "fulfilled" ? 1 : 0);
    }
  });

  test("a later insufficient item rolls back previous deductions and saves no order", async () => {
    await inventory.adjustStock(firstProduct.id, 3);
    await assert.rejects(() => db.saveOrder(order([[firstProduct, 2], [secondProduct, 1]])), /INSUFFICIENT_STOCK/);
    assert.equal(await stock(firstProduct), 3);
    assert.equal(await stock(secondProduct), 0);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count, 0);
  });

  test("two simultaneous checkouts of the last item produce one order, never overselling", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await reset();
      await inventory.adjustStock(firstProduct.id, 1);
      const results = await Promise.allSettled([
        db.saveOrder(order([[firstProduct, 1]])),
        db.saveOrder(order([[firstProduct, 1]]))
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const failure = results.find(result => result.status === "rejected");
      assert.match(failure.reason.message, /INSUFFICIENT_STOCK/);
      assert.equal(await stock(), 0);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count, 1);
    }
  });

  test("opposite item ordering in concurrent multi-product checkout does not deadlock", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await reset();
      await inventory.adjustStock(firstProduct.id, 2);
      await inventory.adjustStock(secondProduct.id, 2);
      await Promise.all([
        db.saveOrder(order([[firstProduct, 1], [secondProduct, 1]])),
        db.saveOrder(order([[secondProduct, 1], [firstProduct, 1]]))
      ]);
      assert.equal(await stock(firstProduct), 0);
      assert.equal(await stock(secondProduct), 0);
      assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count, 2);
    }
  });

  test("duplicate items are aggregated before stock reservation", async () => {
    await inventory.adjustStock(firstProduct.id, 3);
    await assert.rejects(() => db.saveOrder(order([[firstProduct, 2], [firstProduct, 2]])), /INSUFFICIENT_STOCK/);
    assert.equal(await stock(), 3);
    const purchase = order([[firstProduct, 1], [firstProduct, 2]]);
    await db.saveOrder(purchase);
    assert.equal(await stock(), 0);
    await db.updateOrderStatus(purchase.id, "dibatalkan");
    assert.equal(await stock(), 3);
  });

  test("simultaneous repeated cancellation restores stock exactly once", async () => {
    await inventory.adjustStock(firstProduct.id, 5);
    const purchase = order([[firstProduct, 2]]);
    await db.saveOrder(purchase);
    assert.equal(await stock(), 3);
    const results = await Promise.all([
      db.updateOrderStatus(purchase.id, "dibatalkan"),
      db.updateOrderStatus(purchase.id, "dibatalkan")
    ]);
    assert.ok(results.every(result => result.status === "dibatalkan"));
    assert.equal(await stock(), 5);
    await db.updateOrderStatus(purchase.id, "dibatalkan");
    assert.equal(await stock(), 5);
  });

  test("cancellation racing checkout and admin additions preserves the stock sum", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await reset();
      await inventory.adjustStock(firstProduct.id, 3);
      const previous = order([[firstProduct, 2]]);
      const next = order([[firstProduct, 1]]);
      await db.saveOrder(previous);
      await Promise.all([
        db.updateOrderStatus(previous.id, "dibatalkan"),
        db.saveOrder(next),
        inventory.adjustStock(firstProduct.id, 4)
      ]);
      assert.equal(await stock(), 6); // 3 initial + 4 addition - 1 active order.
      const rows = (await pool.query("SELECT status FROM orders ORDER BY id")).rows;
      assert.equal(rows.filter(row => row.status === "dibatalkan").length, 1);
      assert.equal(rows.filter(row => row.status === "baru").length, 1);
    }
  });

  test("cancellation racing an admin removal and checkout retains every successful change", async () => {
    await inventory.adjustStock(firstProduct.id, 4);
    const previous = order([[firstProduct, 2]]);
    await db.saveOrder(previous);
    const results = await Promise.allSettled([
      db.updateOrderStatus(previous.id, "dibatalkan"),
      db.saveOrder(order([[firstProduct, 1]])),
      inventory.adjustStock(firstProduct.id, -2)
    ]);
    assert.equal(results[0].status, "fulfilled");
    const deducted = (results[1].status === "fulfilled" ? 1 : 0) + (results[2].status === "fulfilled" ? 2 : 0);
    assert.equal(await stock(), 4 - deducted);
    for (const result of results.filter(result => result.status === "rejected")) assert.match(result.reason.message, /INSUFFICIENT_STOCK/);
  });

  test("a failed order INSERT rolls back all stock deductions", async () => {
    await inventory.adjustStock(firstProduct.id, 4);
    await inventory.adjustStock(secondProduct.id, 4);
    const purchase = order([[firstProduct, 1], [secondProduct, 1]]);
    await db.saveOrder(purchase);
    await assert.rejects(() => db.saveOrder(purchase), error => error.code === "23505");
    assert.equal(await stock(firstProduct), 3);
    assert.equal(await stock(secondProduct), 3);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count, 1);
  });

  test("cancelling a legacy order without stock reservation does not invent stock", async () => {
    const legacy = order([[firstProduct, 3]]);
    await pool.query(`INSERT INTO orders (id, customer_name, customer_phone, address, payment_method, items, total)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`, [legacy.id, legacy.customer.name, legacy.customer.phone, legacy.customer.address, legacy.customer.paymentMethod, JSON.stringify(legacy.items), legacy.total]);
    await db.updateOrderStatus(legacy.id, "dibatalkan");
    await db.updateOrderStatus(legacy.id, "dibatalkan");
    assert.equal(await stock(), 0);
  });

  test("a new order cannot be reopened after cancellation restored its stock", async () => {
    await inventory.adjustStock(firstProduct.id, 1);
    const purchase = order([[firstProduct, 1]]);
    await db.saveOrder(purchase);
    await db.updateOrderStatus(purchase.id, "dibatalkan");
    await assert.rejects(() => db.updateOrderStatus(purchase.id, "diproses"), /ORDER_CANCELLED/);
    assert.equal(await stock(), 1);
    assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [purchase.id])).rows[0].status, "dibatalkan");
  });
});
