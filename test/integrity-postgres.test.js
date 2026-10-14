// Optional real PostgreSQL tests. Only a dedicated LOCAL scratch database is
// accepted; application and production databases are never used.
// STOCK_TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55432/dapoer_stock_test \
// STOCK_TEST_PG_MODULE=/workspace/.dapoer-postgres/node_modules/pg \
// NODE_PATH=/workspace/.dapoer-cloud/node_modules node --test test/integrity-postgres.test.js
const { describe, test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const { PRODUCTS, STORE } = require("../api/_lib/catalog");

const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const previousDatabaseUrl = process.env.DATABASE_URL;
const [firstProduct, secondProduct] = [...PRODUCTS].sort((a, b) => a.id.localeCompare(b.id));
const fixtures = [];
let adminPool;
let sequence = 0;
let fixtureSequence = 0;

function loadWithMocks(targetName, mocks) {
  const target = require.resolve(targetName);
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === target && Object.hasOwn(mocks, name)) return mocks[name];
    return originalLoad.call(this, name, parent, isMain);
  };
  try { return require(target); }
  finally { Module._load = originalLoad; }
}

async function fixture() {
  const schema = `integrity_integration_${process.pid}_${fixtureSequence++}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 16,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=12000` });
  const sql = async (parts, ...values) => {
    const text = typeof parts === "string" ? parts : parts.reduce((result, part, index) => result + (index ? `$${index}` : "") + part, "");
    return (await pool.query(text, values)).rows;
  };
  sql.query = async (text, values = []) => (await pool.query(text, values)).rows;
  const db = loadWithMocks("../api/_lib/db", { "@neondatabase/serverless": { neon: () => sql } });
  const inventory = loadWithMocks("../api/_lib/inventory", { "./db": db });
  const result = { schema, pool, sql, db, inventory };
  fixtures.push(result);
  await db.ensureSchema();
  return result;
}

async function cleanFixtures() {
  while (fixtures.length) {
    const { pool, schema } = fixtures.pop();
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

function purchase(items = [[firstProduct, 1]], overrides = {}) {
  const id = `integrity-order-${++sequence}`;
  return {
    id, trackingToken: crypto.randomBytes(24).toString("hex"),
    customer: { name: "Local integrity customer", phone: "081234567890", address: "Local test address", notes: "Test note", paymentMethod: "DANA" },
    items: items.map(([product, quantity]) => ({ id: product.id, name: product.name, price: product.price, quantity, subtotal: product.price * quantity })),
    total: items.reduce((sum, [product, quantity]) => sum + product.price * quantity, 0),
    ...overrides
  };
}

function checkoutBody(items = [[firstProduct, 1]], overrides = {}) {
  const order = purchase(items);
  return {
    requestId: crypto.randomUUID(), expectedTotal: order.total,
    customer: order.customer, items: order.items.map(({ id, quantity }) => ({ id, quantity })),
    ...overrides
  };
}

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function orderHandler(db, products = PRODUCTS) {
  return loadWithMocks("../api/order", {
    "./_lib/db": db, "./_lib/security": { guardRequest: async () => true },
    "./_lib/catalog": { STORE, PRODUCTS: products }
  });
}

function stockHandler(inventory) {
  return loadWithMocks("../api/admin/stock", {
    "../_lib/inventory": inventory, "../_lib/security": { guardRequest: async () => true },
    "../_lib/auth": { verifySession: () => true }
  });
}

function statusHandler(db) {
  return loadWithMocks("../api/admin/status", {
    "../_lib/db": db, "../_lib/security": { guardRequest: async () => true },
    "../_lib/auth": { verifySession: () => true }
  });
}

async function call(handler, body, method = "POST") {
  const res = response();
  await handler({ method, body, socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "integrity.example.test", "content-type": "application/json" } }, res);
  return res;
}

async function stock(pool, product = firstProduct) {
  return (await pool.query("SELECT stock FROM inventory WHERE product_id=$1", [product.id])).rows[0].stock;
}

async function orderCount(pool) {
  return (await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count;
}

async function counter(pool) {
  return (await pool.query("SELECT COALESCE(SUM(last_number),0)::integer AS value FROM order_queue_counters")).rows[0].value;
}

async function version(pool, id) {
  return (await pool.query("SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS version FROM orders WHERE id=$1", [id])).rows[0].version;
}

describe("real PostgreSQL checkout, inventory and order status integrity", { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    const url = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only a local scratch database is allowed");
    assert.match(url.pathname, /^\/dapoer_stock_test(?:_[a-z0-9_]+)?$/, "Use a dedicated dapoer_stock_test database");
    const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    process.env.DATABASE_URL = databaseUrl;
  });

  afterEach(cleanFixtures);

  after(async () => {
    await cleanFixtures();
    if (adminPool) await adminPool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    for (const path of ["../api/_lib/db", "../api/_lib/inventory", "../api/order", "../api/admin/stock", "../api/admin/status"]) {
      delete require.cache[require.resolve(path)];
    }
  });

  test("16 concurrent retries return one original checkout and deduct stock only once", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=30");
    const body = checkoutBody([[firstProduct, 2], [secondProduct, 3]]);
    const handler = orderHandler(db);
    const results = await Promise.all(Array.from({ length: 16 }, () => call(handler, structuredClone(body))));
    assert.ok(results.every(result => result.statusCode === 200));
    for (const result of results) assert.deepEqual(result.body, results[0].body);
    assert.equal(await orderCount(pool), 1);
    assert.equal(await stock(pool), 28);
    assert.equal(await stock(pool, secondProduct), 27);
    assert.equal(await counter(pool), 1);
    const saved = (await pool.query("SELECT id, items, total, customer_name, queue_number, tracking_token FROM orders")).rows[0];
    assert.equal(saved.id, results[0].body.order.id);
    assert.deepEqual(saved.items, results[0].body.order.items);
    assert.equal(Number(saved.total), results[0].body.order.total);
    assert.equal(saved.customer_name, body.customer.name);
    assert.equal(saved.queue_number, results[0].body.order.queueNumber);
    assert.equal(new URL(results[0].body.trackingUrl).searchParams.get("token"), saved.tracking_token);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests WHERE scope='checkout'")).rows[0].count, 1);
  });

  test("a request key reused for a different customer or quantity conflicts without another order", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=10");
    const body = checkoutBody();
    const handler = orderHandler(db);
    assert.equal((await call(handler, body)).statusCode, 200);
    for (const changed of [
      { ...body, customer: { ...body.customer, address: "A different address" } },
      { ...body, items: [{ id: firstProduct.id, quantity: 2 }], expectedTotal: firstProduct.price * 2 }
    ]) {
      const result = await call(handler, changed);
      assert.equal(result.statusCode, 409);
      assert.equal(result.body.code, "REQUEST_CONFLICT");
      assert.equal(result.body.order, undefined);
    }
    assert.equal(await stock(pool), 9);
    assert.equal(await orderCount(pool), 1);
    assert.equal(await counter(pool), 1);
  });

  test("competing payloads under one checkout key commit one complete winner", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=10");
    const first = checkoutBody();
    const second = { ...first, items: [{ id: secondProduct.id, quantity: 2 }], expectedTotal: secondProduct.price * 2,
      customer: { ...first.customer, name: "Other local customer" } };
    const results = await Promise.all([call(orderHandler(db), first), call(orderHandler(db), second)]);
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
    assert.equal(results.find(result => result.statusCode === 409).body.code, "REQUEST_CONFLICT");
    const winner = results.find(result => result.statusCode === 200).body.order;
    assert.equal(await stock(pool), 10 - (winner.items[0].id === firstProduct.id ? 1 : 0));
    assert.equal(await stock(pool, secondProduct), 10 - (winner.items[0].id === secondProduct.id ? 2 : 0));
    assert.equal(await orderCount(pool), 1);
    assert.equal(await counter(pool), 1);
  });

  test("checkout replay retains saved prices, item names and links after catalog price changes", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=10");
    const body = checkoutBody([[firstProduct, 2]]);
    const original = await call(orderHandler(db), body);
    assert.equal(original.statusCode, 200);
    const changedCatalog = PRODUCTS.map(product => product.id === firstProduct.id
      ? { ...product, price: product.price + 9000, name: "Renamed product after checkout" } : product);
    const replay = await call(orderHandler(db, changedCatalog), body);
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.body, original.body);
    assert.equal(await stock(pool), 8);
    assert.equal(await orderCount(pool), 1);
    assert.equal(await counter(pool), 1);
  });

  test("a first checkout with a stale total fails before saving and its key can be retried after confirmation", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=10");
    const body = checkoutBody();
    const changedCatalog = PRODUCTS.map(product => product.id === firstProduct.id ? { ...product, price: product.price + 7000 } : product);
    const handler = orderHandler(db, changedCatalog);
    const stale = await call(handler, body);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.code, "PRICE_CHANGED");
    assert.equal(await orderCount(pool), 0);
    assert.equal(await stock(pool), 10);
    assert.equal(await counter(pool), 0);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests")).rows[0].count, 0);
    const confirmed = await call(handler, { ...body, expectedTotal: firstProduct.price + 7000 });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.body.order.total, firstProduct.price + 7000);
    assert.equal(await stock(pool), 9);
  });

  test("insufficient multi-product stock rolls back deductions, queue and request key", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=3 WHERE product_id=$1", [firstProduct.id]);
    const body = checkoutBody([[firstProduct, 2], [secondProduct, 1]]);
    const handler = orderHandler(db);
    const failed = await call(handler, body);
    assert.equal(failed.statusCode, 409);
    assert.equal(failed.body.code, "INSUFFICIENT_STOCK");
    assert.equal(await stock(pool), 3);
    assert.equal(await stock(pool, secondProduct), 0);
    assert.equal(await orderCount(pool), 0);
    assert.equal(await counter(pool), 0);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests")).rows[0].count, 0);
    await pool.query("UPDATE inventory SET stock=1 WHERE product_id=$1", [secondProduct.id]);
    const retry = await call(handler, body);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.body.order.queueNumber, 1);
    assert.equal(await stock(pool), 1);
    assert.equal(await stock(pool, secondProduct), 0);
  });

  test("an INSERT failure after checkout allocation leaves neither a deducted stock nor a consumed key", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=5");
    const initial = purchase();
    await db.saveOrder(initial);
    const requestId = crypto.randomUUID();
    const next = purchase([[firstProduct, 2]], { id: initial.id, requestId, expectedTotal: firstProduct.price * 2 });
    await assert.rejects(() => db.saveOrder(next), error => error.code === "23505");
    assert.equal(await stock(pool), 4);
    assert.equal(await orderCount(pool), 1);
    assert.equal(await counter(pool), 1);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests WHERE request_id=$1::uuid", [requestId])).rows[0].count, 0);
    next.id = `integrity-retry-${++sequence}`;
    await db.saveOrder(next);
    assert.equal(next.queueNumber, 2);
    assert.equal(await stock(pool), 2);
  });

  test("replaying a checkout after cancellation retains its receipt and does not reserve stock again", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=5");
    const body = checkoutBody([[firstProduct, 2]]);
    const handler = orderHandler(db);
    const created = await call(handler, body);
    assert.equal(created.statusCode, 200);
    await db.updateOrderStatus(created.body.order.id, "dibatalkan");
    assert.equal(await stock(pool), 5);
    const replay = await call(handler, body);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.order.id, created.body.order.id);
    assert.equal(replay.body.trackingUrl, created.body.trackingUrl);
    assert.equal(replay.body.order.queueLabel, created.body.order.queueLabel);
    assert.deepEqual(replay.body.order.items, created.body.order.items);
    assert.equal(await stock(pool), 5);
    assert.equal(await counter(pool), 1);
    assert.equal((await pool.query("SELECT status FROM orders")).rows[0].status, "dibatalkan");
  });

  test("16 concurrent stock addition retries return one result and apply one addition", async () => {
    const { inventory, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=10");
    const body = { id: firstProduct.id, delta: 3, requestId: crypto.randomUUID() };
    const handler = stockHandler(inventory);
    const results = await Promise.all(Array.from({ length: 16 }, () => call(handler, body, "PATCH")));
    assert.ok(results.every(result => result.statusCode === 200));
    for (const result of results) assert.deepEqual(result.body, results[0].body);
    assert.equal(results[0].body.product.stock, 13);
    assert.equal(await stock(pool), 13);
    await inventory.adjustStock(firstProduct.id, 2, crypto.randomUUID());
    const replay = await call(handler, body, "PATCH");
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.product.stock, 13);
    assert.equal(await stock(pool), 15);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests WHERE scope='stock'")).rows[0].count, 2);
  });

  test("stock request keys reject changes to quantity, product and operation type", async () => {
    const { inventory, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=10");
    const handler = stockHandler(inventory);
    const body = { id: firstProduct.id, delta: 3, requestId: crypto.randomUUID() };
    assert.equal((await call(handler, body, "PATCH")).statusCode, 200);
    for (const changed of [
      { ...body, delta: 1 }, { ...body, id: secondProduct.id },
      { id: firstProduct.id, stock: 12, expectedStock: 13, requestId: body.requestId }
    ]) {
      const result = await call(handler, changed, "PATCH");
      assert.equal(result.statusCode, 409);
      assert.equal(result.body.code, "REQUEST_CONFLICT");
    }
    assert.equal(await stock(pool), 13);
    assert.equal(await stock(pool, secondProduct), 10);
  });

  test("stock set replay keeps its original result and cannot erase a later checkout reservation", async () => {
    const { db, inventory, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=10");
    const requestId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => inventory.setStock(firstProduct.id, 20, 10, requestId)));
    assert.ok(results.every(product => product.stock === 20));
    assert.equal(await stock(pool), 20);
    await db.saveOrder(purchase([[firstProduct, 2]]));
    const replay = await inventory.setStock(firstProduct.id, 20, 10, requestId);
    assert.equal(replay.stock, 20);
    assert.equal(await stock(pool), 18);
  });

  test("a failed stock CAS or underflow does not consume the request key", async () => {
    const { inventory, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=5");
    const requestId = crypto.randomUUID();
    await assert.rejects(() => inventory.setStock(firstProduct.id, 20, 4, requestId), error => error.code === "STOCK_CONFLICT");
    assert.equal(await stock(pool), 5);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests")).rows[0].count, 0);
    assert.equal((await inventory.setStock(firstProduct.id, 20, 5, requestId)).stock, 20);
    const underflowId = crypto.randomUUID();
    await assert.rejects(() => inventory.adjustStock(firstProduct.id, -21, underflowId), error => error.code === "INSUFFICIENT_STOCK");
    assert.equal(await stock(pool), 20);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests WHERE request_id=$1::uuid", [underflowId])).rows[0].count, 0);
    assert.equal((await inventory.adjustStock(firstProduct.id, -2, underflowId)).stock, 18);
  });

  test("independent concurrent stock additions all survive with correct sum", async () => {
    const { inventory, pool } = await fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => inventory.adjustStock(firstProduct.id, 2, crypto.randomUUID())));
    assert.equal(results.length, 20);
    assert.equal(await stock(pool), 40);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests WHERE scope='stock'")).rows[0].count, 20);
  });

  test("a stock ceiling failure rolls back its key so a later valid retry is still possible", async () => {
    const { inventory, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=1000000");
    const requestId = crypto.randomUUID();
    await assert.rejects(() => inventory.adjustStock(firstProduct.id, 1, requestId), error => error.code === "INVALID_STOCK_ADJUSTMENT");
    assert.equal(await stock(pool), 1000000);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests")).rows[0].count, 0);
    await inventory.adjustStock(firstProduct.id, -2, crypto.randomUUID());
    assert.equal((await inventory.adjustStock(firstProduct.id, 1, requestId)).stock, 999999);
    assert.equal(await stock(pool), 999999);
  });

  test("checkout and stock operations can independently reuse the same UUID without crossing responses", async () => {
    const { db, inventory, pool } = await fixture();
    const requestId = crypto.randomUUID();
    const stocked = await inventory.adjustStock(firstProduct.id, 5, requestId);
    assert.equal(stocked.stock, 5);
    const body = checkoutBody([[firstProduct, 2]], { requestId });
    const handler = orderHandler(db);
    const created = await call(handler, body);
    assert.equal(created.statusCode, 200);
    assert.equal(await stock(pool), 3);
    assert.equal((await inventory.adjustStock(firstProduct.id, 5, requestId)).stock, 5);
    assert.deepEqual((await call(handler, body)).body, created.body);
    assert.equal(await stock(pool), 3);
    assert.deepEqual((await pool.query("SELECT scope FROM operation_requests WHERE request_id=$1::uuid ORDER BY scope", [requestId])).rows,
      [{ scope: "checkout" }, { scope: "stock" }]);
  });

  test("concurrent cold schema checks preserve live retried checkout and stock changes", async () => {
    const { db, inventory, pool, sql } = await fixture();
    await pool.query("UPDATE inventory SET stock=30");
    const body = checkoutBody([[firstProduct, 2], [secondProduct, 3]]);
    const handler = orderHandler(db);
    const coldInstances = Array.from({ length: 5 }, () => loadWithMocks("../api/_lib/db", { "@neondatabase/serverless": { neon: () => sql } }));
    const results = await Promise.allSettled([
      ...coldInstances.map(instance => instance.ensureSchema()),
      ...Array.from({ length: 12 }, () => call(handler, body)),
      inventory.adjustStock(firstProduct.id, 7, crypto.randomUUID())
    ]);
    for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.message);
    const checkouts = results.slice(coldInstances.length, coldInstances.length + 12).map(result => result.value);
    assert.ok(checkouts.every(result => result.statusCode === 200));
    for (const result of checkouts) assert.deepEqual(result.body, checkouts[0].body);
    assert.equal(await stock(pool), 35);
    assert.equal(await stock(pool, secondProduct), 27);
    assert.equal(await orderCount(pool), 1);
    assert.equal(await counter(pool), 1);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM operation_requests")).rows[0].count, 2);
  });

  test("competing status changes using one observed microsecond version produce one success and one conflict", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=5");
    const order = purchase();
    await db.saveOrder(order);
    await pool.query("UPDATE orders SET updated_at='2026-01-02T03:04:05.123456Z' WHERE id=$1", [order.id]);
    const expectedUpdatedAt = await version(pool, order.id);
    assert.equal(expectedUpdatedAt, "2026-01-02T03:04:05.123456Z");
    const handler = statusHandler(db);
    const results = await Promise.all(["diproses", "dibatalkan"].map(status => call(handler,
      { id: order.id, status, expectedStatus: "baru", expectedUpdatedAt }, "PATCH")));
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
    assert.equal(results.find(result => result.statusCode === 409).body.code, "ORDER_CONFLICT");
    const winner = results.find(result => result.statusCode === 200).body.order;
    const current = (await pool.query("SELECT status FROM orders WHERE id=$1", [order.id])).rows[0];
    assert.equal(current.status, winner.status);
    assert.equal(await stock(pool), winner.status === "dibatalkan" ? 5 : 4);
    assert.notEqual(await version(pool, order.id), expectedUpdatedAt);
  });

  test("exact concurrent status replays are idempotent and stale transitions cannot erase the next step", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=5");
    const order = purchase();
    await db.saveOrder(order);
    const expectedUpdatedAt = await version(pool, order.id);
    const expectation = { expectedStatus: "baru", expectedUpdatedAt };
    const results = await Promise.all(Array.from({ length: 12 }, () => db.updateOrderStatus(order.id, "diproses", expectation)));
    for (const result of results) assert.deepEqual(result, results[0]);
    const nextVersion = await version(pool, order.id);
    await db.updateOrderStatus(order.id, "dikirim", { expectedStatus: "diproses", expectedUpdatedAt: nextVersion });
    await assert.rejects(() => db.updateOrderStatus(order.id, "diproses", expectation), error => error.code === "ORDER_CONFLICT");
    assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [order.id])).rows[0].status, "dikirim");
    assert.equal(await stock(pool), 4);
  });

  test("cancelled pending orders restore stock once while shipped and completed orders cannot invent returned stock", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=10");
    const cancellable = purchase([[firstProduct, 2]]);
    await db.saveOrder(cancellable);
    await db.updateOrderStatus(cancellable.id, "diproses");
    const expectation = { expectedStatus: "diproses", expectedUpdatedAt: await version(pool, cancellable.id) };
    await Promise.all(Array.from({ length: 8 }, () => db.updateOrderStatus(cancellable.id, "dibatalkan", expectation)));
    assert.equal(await stock(pool), 10);
    await assert.rejects(() => db.updateOrderStatus(cancellable.id, "baru"), error => error.code === "ORDER_CANCELLED");
    for (const finalStatus of ["dikirim", "selesai"]) {
      const order = purchase();
      await db.saveOrder(order);
      await db.updateOrderStatus(order.id, "diproses");
      await db.updateOrderStatus(order.id, "dikirim");
      if (finalStatus === "selesai") await db.updateOrderStatus(order.id, "selesai");
      const before = await stock(pool);
      await assert.rejects(() => db.updateOrderStatus(order.id, "dibatalkan"), error => error.code === "CANCELLATION_NOT_ALLOWED");
      assert.equal(await stock(pool), before);
      assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [order.id])).rows[0].status, finalStatus);
      await assert.rejects(() => db.updateOrderStatus(order.id, "baru"), error => error.code === "INVALID_STATUS_TRANSITION");
    }
  });

  test("checked status updates preserve microseconds and advance even when an imported version is in the future", async () => {
    const { db, pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=5");
    const order = purchase();
    await db.saveOrder(order);
    await pool.query("UPDATE orders SET updated_at='2099-01-02T03:04:05.123456Z' WHERE id=$1", [order.id]);
    const result = await db.updateOrderStatus(order.id, "diproses", {
      expectedStatus: "baru", expectedUpdatedAt: "2099-01-02T03:04:05.123456Z"
    });
    assert.match(result.updated_at, /\.\d{6}(?:Z|\+00:00)$/);
    assert.equal(result.updated_at.replace(/\+00:00$/, "Z"), "2099-01-02T03:04:05.123457Z");
    assert.equal(await version(pool, order.id), result.updated_at.replace(/\+00:00$/, "Z"));
    const history = await db.listOrdersByDate({ date: order.queueDate });
    assert.equal(history.orders[0].updated_at, result.updated_at);
    assert.equal(result.updatedAt,result.updated_at,"Legacy and CAS clients receive the same precise timestamp");
  });

  test("legacy SQL save and status signatures stay callable and obey the improved cancellation policy", async () => {
    const { pool } = await fixture();
    await pool.query("UPDATE inventory SET stock=5");
    const order = purchase();
    const parameters = [order.id, order.customer.name, order.customer.phone, order.customer.address,
      order.customer.notes, order.customer.paymentMethod, JSON.stringify(order.items), order.total, order.trackingToken];
    assert.equal((await pool.query("SELECT dapoer_save_order($1,$2,$3,$4,$5,$6,$7::jsonb,$8::bigint,$9) AS saved", parameters)).rows[0].saved, true);
    assert.equal(await stock(pool), 4);
    const cancelled = (await pool.query("SELECT dapoer_update_order_status($1,$2) AS saved", [order.id, "dibatalkan"])).rows[0].saved;
    assert.equal(cancelled.status, "dibatalkan");
    assert.equal(await stock(pool), 5);
    await pool.query("SELECT dapoer_update_order_status($1,$2)", [order.id, "dibatalkan"]);
    assert.equal(await stock(pool), 5);
    await assert.rejects(() => pool.query("SELECT dapoer_update_order_status($1,$2)", [order.id, "selesai"]), /ORDER_CANCELLED/);
    assert.equal((await pool.query("SELECT queue_number FROM orders WHERE id=$1", [order.id])).rows[0].queue_number, 1);
  });
});
