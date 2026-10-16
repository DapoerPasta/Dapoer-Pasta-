// Real atomic checkout/shipping/addition transactions in isolated LOCAL schemas.
// Run with the same STOCK_TEST_DATABASE_URL / STOCK_TEST_PG_MODULE as inventory tests.
const { describe, test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const { PRODUCTS } = require("../api/_lib/catalog");
const { ensureFulfillmentSchema } = require("../api/_lib/fulfillment-db");
const { fulfillmentMetadata } = require("../api/_lib/fulfillment");
const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const previousDatabaseUrl = process.env.DATABASE_URL;
const product = PRODUCTS[0];
const fixtures = [];
let adminPool, sequence = 0;

function loadWithMocks(name, mocks) {
  const target = require.resolve(name), cached = require.cache[target], original = Module._load;
  delete require.cache[target];
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === target && Object.hasOwn(mocks, request)) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(target); } finally {
    Module._load = original;
    if (cached) require.cache[target] = cached;
    else delete require.cache[target];
  }
}
async function fixture() {
  const schema = `fulfillment_integration_${process.pid}_${sequence++}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 20,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=12000` });
  const sql = async (parts, ...values) => (await pool.query(typeof parts === "string" ? parts :
    parts.reduce((all, part, i) => all + (i ? `$${i}` : "") + part, ""), values)).rows;
  const db = loadWithMocks("../api/_lib/db", { "@neondatabase/serverless": { neon: () => sql } });
  const f = { schema, pool, sql, db };
  fixtures.push(f);
  await db.ensureSchema();
  await pool.query("UPDATE inventory SET stock=50");
  return f;
}
async function cleanup() {
  while (fixtures.length) {
    const { pool, schema } = fixtures.pop();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}
function checkout(overrides = {}) {
  return { id: `shipping-order-${sequence++}`, trackingToken: crypto.randomBytes(24).toString("hex"),
    requestId: crypto.randomUUID(), expectedTotal: product.price,
    customer: { name: "Local customer", phone: "081234567890", address: "Local address", notes: "Original notes", paymentMethod: "Transfer Bank" },
    items: [{ id: product.id, name: product.name, price: product.price, quantity: 1, subtotal: product.price }], total: product.price, ...overrides };
}
async function stored(f, id) {
  return (await f.pool.query("SELECT *,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS version FROM orders WHERE id=$1", [id])).rows[0];
}
async function feeInput(f, id, shippingFee = 12000) {
  const order = await stored(f, id);
  return { id, shippingFee, requestId: crypto.randomUUID(), expectedStatus: order.status, expectedUpdatedAt: order.version };
}
function addInput(order, quantity = 1) {
  return { id: order.id, trackingToken: order.trackingToken, requestId: crypto.randomUUID(), expectedTotal: quantity * product.price,
    items: [{ id: product.id, quantity }] };
}
const rejects = (action, code) => assert.rejects(action, error => error.code === code);

describe("real PostgreSQL delivery and pickup", { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    const url = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only LOCAL scratch database allowed");
    assert.match(url.pathname, /^\/dapoer_stock_test(?:_[a-z0-9_]+)?$/);
    const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    process.env.DATABASE_URL = databaseUrl;
  });
  afterEach(cleanup);
  after(async () => {
    await cleanup();
    await adminPool?.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  test("pickup persists atomically with empty address, zero fee and immutable checkout replay", async () => {
    const f = await fixture(), initial = checkout({ deliveryMethod: "pickup" });
    initial.customer.address = "";
    const order = structuredClone(initial);
    await f.db.saveOrder(order);
    assert.deepEqual(fulfillmentMetadata(order), { deliveryMethod: "pickup", shippingFee: 0, itemsSubtotal: product.price,
      grandTotal: product.price, shippingConfirmed: true });
    const row = await stored(f, order.id);
    assert.equal(row.address, "");
    assert.equal(row.delivery_method, "pickup");
    assert.equal(Number(row.shipping_fee), 0);
    await f.db.requestOrderAddition(addInput(order));
    const replay = { ...structuredClone(initial), id: "fresh-unused-id", trackingToken: crypto.randomBytes(24).toString("hex") };
    await f.db.saveOrder(replay);
    assert.equal(replay.id, order.id);
    assert.equal(replay.total, product.price);
    assert.equal(replay.queueNumber, order.queueNumber);
    assert.equal(replay.deliveryMethod, "pickup");
    await rejects(() => f.db.saveOrder({ ...structuredClone(initial), deliveryMethod: "delivery" }), "REQUEST_CONFLICT");
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM orders")).rows[0].n, 1);
    assert.equal((await f.pool.query("SELECT stock FROM inventory WHERE product_id=$1", [product.id])).rows[0].stock, 48);
  });

  test("legacy checkout replay never changes mode, historical snapshot or current shipping", async () => {
    const f = await fixture(), initial = checkout(), order = structuredClone(initial);
    await f.db.saveOrder(order);
    // Emulate immutable result persisted by the prior release before fee fields existed.
    await f.pool.query("UPDATE operation_requests SET result=result-'deliveryMethod'-'shippingFee'-'itemsSubtotal'-'grandTotal'-'shippingConfirmed' WHERE scope='checkout' AND request_id=$1", [order.requestId]);
    const update = await f.db.updateOrderShipping(await feeInput(f, order.id, 18000));
    assert.equal(update.grandTotal, product.price + 18000);
    const replay = { ...structuredClone(initial), id: "unused-replay", deliveryMethod: "delivery" };
    await f.db.saveOrder(replay);
    assert.equal(replay.total, product.price);
    assert.equal(replay.shippingFee, null);
    assert.equal(Number((await stored(f, order.id)).shipping_fee), 18000);
    assert.equal((await stored(f, order.id)).delivery_method, "delivery");
  });

  test("16 simultaneous fee retries apply once without stock, form or queue mutation", async () => {
    const f = await fixture(), order = checkout();
    await f.db.saveOrder(order);
    assert.equal(order.grandTotal, null);
    const before = await stored(f, order.id), input = await feeInput(f, order.id);
    const results = await Promise.all(Array.from({ length: 16 }, () => f.db.updateOrderShipping(input)));
    results.forEach(result => assert.deepEqual(result, results[0]));
    assert.equal(results[0].total, product.price + 12000);
    assert.equal(results[0].itemsSubtotal, product.price);
    assert.equal(results[0].shippingConfirmed, true);
    const after = await stored(f, order.id);
    for (const key of ["customer_name", "customer_phone", "address", "notes", "payment_method", "tracking_token", "queue_number"])
      assert.equal(after[key], before[key]);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM inventory_movements WHERE order_id=$1", [order.id])).rows[0].n, 1);
    await rejects(() => f.db.updateOrderShipping({ ...input, shippingFee: 14000 }), "REQUEST_CONFLICT");
    assert.deepEqual(await f.db.updateOrderShipping(input), results[0]);
  });

  test("fee replacement subtracts the previous fee and zero explicitly confirms free delivery", async () => {
    const f = await fixture(), order = checkout();
    await f.db.saveOrder(order);
    await f.db.updateOrderShipping(await feeInput(f, order.id, 12000));
    const reduced = await f.db.updateOrderShipping(await feeInput(f, order.id, 8000));
    assert.equal(reduced.total, product.price + 8000);
    assert.equal(reduced.itemsSubtotal, product.price);
    const free = await f.db.updateOrderShipping(await feeInput(f, order.id, 0));
    assert.equal(free.total, product.price);
    assert.equal(free.shippingFee, 0);
    assert.equal(free.shippingConfirmed, true);
    assert.equal(free.grandTotal, product.price);
  });

  test("fresh and processed menu additions preserve confirmed shipping and finance totals", async () => {
    const f = await fixture(), order = checkout();
    await f.db.saveOrder(order);
    await f.db.updateOrderShipping(await feeInput(f, order.id));
    const applied = await f.db.requestOrderAddition(addInput(order));
    assert.equal(applied.order.shippingFee, 12000);
    assert.equal(applied.order.itemsSubtotal, product.price * 2);
    assert.equal(applied.order.grandTotal, product.price * 2 + 12000);
    await f.db.updateOrderStatus(order.id, "diproses");
    const pending = await f.db.requestOrderAddition(addInput(order));
    assert.equal(pending.order.total, product.price * 2 + 12000);
    const approved = await f.db.reviewOrderAddition({ id: order.id, additionId: pending.addition.id, decision: "approve", requestId: crypto.randomUUID(),
      expectedStatus: pending.order.status, expectedUpdatedAt: pending.order.updatedAt });
    assert.equal(approved.order.shippingFee, 12000);
    assert.equal(approved.order.itemsSubtotal, product.price * 3);
    assert.equal(approved.order.grandTotal, product.price * 3 + 12000);
    await f.db.updateOrderStatus(order.id, "selesai");
    const finance = loadWithMocks("../api/_lib/finance-db", { "./db": f.db });
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const report = await finance.getFinanceReport({ period: "daily", date });
    assert.equal(report.summary.completedSales, product.price * 3 + 12000);
    assert.equal(report.summary.totalOrders, 1);
  });

  test("concurrent additional menus and fee updates either serialize or return a stale-version conflict", async () => {
    const f = await fixture(), order = checkout();
    await f.db.saveOrder(order);
    const input = await feeInput(f, order.id);
    const results = await Promise.allSettled([f.db.updateOrderShipping(input), f.db.requestOrderAddition(addInput(order))]);
    assert.equal(results[1].status, "fulfilled");
    if (results[0].status === "rejected") {
      assert.equal(results[0].reason.code, "ORDER_CONFLICT");
      await f.db.updateOrderShipping(await feeInput(f, order.id));
    }
    const row = await stored(f, order.id);
    assert.equal(Number(row.total), product.price * 2 + 12000);
    assert.equal(row.items[0].quantity, 2);
    assert.equal((await f.pool.query("SELECT stock FROM inventory WHERE product_id=$1", [product.id])).rows[0].stock, 48);
  });

  test("concurrent cancellation and shipping leave one total and return stock exactly once", async () => {
    const f = await fixture(), order = checkout();
    await f.db.saveOrder(order);
    const input = await feeInput(f, order.id);
    const results = await Promise.allSettled([f.db.updateOrderShipping(input), f.db.updateOrderStatus(order.id, "dibatalkan")]);
    assert.equal(results[1].status, "fulfilled");
    const row = await stored(f, order.id);
    assert.equal(row.status, "dibatalkan");
    assert.equal(Number(row.total), product.price + (results[0].status === "fulfilled" ? 12000 : 0));
    if (results[0].status === "rejected") assert.equal(results[0].reason.code, "ORDER_CONFLICT");
    assert.equal((await f.pool.query("SELECT stock FROM inventory WHERE product_id=$1", [product.id])).rows[0].stock, 50);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM inventory_movements WHERE source='cancellation' AND order_id=$1", [order.id])).rows[0].n, 1);
    const terminalInput = await feeInput(f, order.id);
    await rejects(() => f.db.updateOrderShipping(terminalInput), "SHIPPING_NOT_ALLOWED");
  });

  test("CAS, closed statuses and pickup reject incompatible shipping changes without partial writes", async () => {
    const f = await fixture(), order = checkout({ deliveryMethod: "pickup" });
    await f.db.saveOrder(order);
    await rejects(async () => f.db.updateOrderShipping(await feeInput(f, order.id)), "SHIPPING_NOT_ALLOWED");
    const delivered = checkout();
    await f.db.saveOrder(delivered);
    const stale = await feeInput(f, delivered.id);
    await f.db.updateOrderStatus(delivered.id, "diproses");
    await rejects(() => f.db.updateOrderShipping(stale), "ORDER_CONFLICT");
    await f.db.updateOrderStatus(delivered.id, "dikirim");
    await rejects(async () => f.db.updateOrderShipping(await feeInput(f, delivered.id)), "SHIPPING_NOT_ALLOWED");
    assert.equal((await stored(f, delivered.id)).shipping_fee, null);
    const unknown = await feeInput(f, order.id, 0);
    assert.equal(await f.db.updateOrderShipping({ ...unknown, id: "not-found" }), null);
  });

  test("concurrent cold fulfillment setup retains delivery mode, charges and checkout result", async () => {
    const f = await fixture(), order = checkout();
    await f.db.saveOrder(order);
    await f.db.updateOrderShipping(await feeInput(f, order.id));
    const before = await stored(f, order.id);
    await Promise.all(Array.from({ length: 6 }, () => ensureFulfillmentSchema(f.sql)));
    const after = await stored(f, order.id);
    assert.equal(after.delivery_method, before.delivery_method);
    assert.equal(after.shipping_fee, before.shipping_fee);
    assert.equal(after.total, before.total);
    assert.equal(after.version, before.version);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM operation_requests WHERE scope='checkout'", [])).rows[0].n, 1);
  });
});
