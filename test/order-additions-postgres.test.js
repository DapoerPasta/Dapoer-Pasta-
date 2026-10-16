// Real transactions against an isolated LOCAL scratch schema only.
// STOCK_TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55432/dapoer_stock_test \
// STOCK_TEST_PG_MODULE=/workspace/.dapoer-postgres/node_modules/pg \
// NODE_PATH=/workspace/.dapoer-cloud/node_modules node --test test/order-additions-postgres.test.js
const { describe, test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const { PRODUCTS } = require("../api/_lib/catalog");
const { ensureOrderAdditionsSchema } = require("../api/_lib/order-additions-db");

const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const previousDatabaseUrl = process.env.DATABASE_URL;
const [first, second] = [...PRODUCTS].sort((a, b) => a.id.localeCompare(b.id));
const fixtures = [];
let adminPool, sequence = 0;

function loadWithMocks(name, mocks) {
  const target = require.resolve(name);
  const cached = require.cache[target];
  delete require.cache[target];
  const original = Module._load;
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

async function fixture(stock = 50) {
  const schema = `addition_integration_${process.pid}_${sequence++}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 20,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=12000` });
  const sql = async (parts, ...values) => {
    const text = typeof parts === "string" ? parts : parts.reduce((all, part, i) => all + (i ? `$${i}` : "") + part, "");
    return (await pool.query(text, values)).rows;
  };
  const db = loadWithMocks("../api/_lib/db", { "@neondatabase/serverless": { neon: () => sql } });
  const f = { pool, schema, sql, db };
  fixtures.push(f);
  await db.ensureSchema();
  await pool.query("UPDATE inventory SET stock=$1", [stock]);
  return f;
}

async function cleanFixtures() {
  while (fixtures.length) {
    const { pool, schema } = fixtures.pop();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

async function purchase(f, products = [[first, 1]], status = "baru") {
  const order = {
    id: `addition-order-${sequence++}`, trackingToken: crypto.randomBytes(24).toString("hex"),
    customer: { name: "Local addition customer", phone: "081234567890", address: "Local test address", notes: "Keep original note", paymentMethod: "Transfer Bank" },
    items: products.map(([p, quantity]) => ({ id: p.id, name: p.name, price: p.price, quantity, subtotal: p.price * quantity })),
    total: products.reduce((sum, [p, quantity]) => sum + p.price * quantity, 0)
  };
  await f.db.saveOrder(order);
  if (status !== "baru") await f.db.updateOrderStatus(order.id, status);
  return order;
}

function addition(order, products = [[first, 2]], overrides = {}) {
  return { id: order.id, trackingToken: order.trackingToken, requestId: crypto.randomUUID(),
    items: products.map(([p, quantity]) => ({ id: p.id, quantity })),
    expectedTotal: products.reduce((sum, [p, quantity]) => sum + p.price * quantity, 0), ...overrides };
}

function review(result, decision = "approve", overrides = {}) {
  return { id: result.order.id, additionId: result.addition.id, decision, requestId: crypto.randomUUID(),
    expectedStatus: result.order.status, expectedUpdatedAt: result.order.updatedAt, ...overrides };
}

async function stock(f, p = first) {
  return (await f.pool.query("SELECT stock FROM inventory WHERE product_id=$1", [p.id])).rows[0].stock;
}
async function saved(f, id) {
  return (await f.pool.query("SELECT *, to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS version FROM orders WHERE id=$1", [id])).rows[0];
}
async function ledger(f, id) {
  return (await f.pool.query("SELECT * FROM inventory_movements WHERE order_id=$1 ORDER BY id", [id])).rows;
}
const rejects = (action, code) => assert.rejects(action, error => error.code === code);

describe("real PostgreSQL same-order menu additions", { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    const url = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only a local scratch database is allowed");
    assert.match(url.pathname, /^\/dapoer_stock_test(?:_[a-z0-9_]+)?$/);
    const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    process.env.DATABASE_URL = databaseUrl;
  });
  afterEach(cleanFixtures);
  after(async () => {
    await cleanFixtures();
    await adminPool?.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    for (const path of ["../api/_lib/db", "../api/_lib/finance-db", "../api/_lib/order-additions-db"]) delete require.cache[require.resolve(path)];
  });

  test("baru adds to the same order, queue and form and records referenced stock movements", async () => {
    const f = await fixture(), order = await purchase(f);
    const before = await saved(f, order.id), input = addition(order, [[first, 2], [second, 3]]);
    const result = await f.db.requestOrderAddition(input);
    assert.equal(result.addition.status, "applied");
    assert.equal(result.order.id, order.id);
    assert.equal(result.order.queueNumber, before.queue_number);
    assert.equal(result.order.queueDate, before.queue_date.toISOString().slice(0, 10));
    assert.equal(result.order.total, order.total + input.expectedTotal);
    assert.equal(result.order.canAddItems, true);
    assert.equal(result.order.items.find(p => p.id === first.id).quantity, 3);
    assert.equal(result.order.items.find(p => p.id === second.id).quantity, 3);
    assert.equal(await stock(f), 47);
    assert.equal(await stock(f, second), 47);
    const after = await saved(f, order.id);
    for (const key of ["customer_name", "customer_phone", "address", "notes", "payment_method", "tracking_token"]) assert.equal(after[key], before[key]);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM orders")).rows[0].n, 1);
    assert.equal((await f.pool.query("SELECT SUM(last_number)::int AS n FROM order_queue_counters")).rows[0].n, 1);
    const movements = await ledger(f, order.id);
    assert.deepEqual(movements.map(m => m.delta), [-1, -2, -3]);
    assert.ok(movements.every(m => m.source === "order"));
    assert.ok(movements.slice(1).every(m => m.reason.includes(input.requestId)));
    assert.equal((await f.db.getPublicOrderStatus(order.id, order.trackingToken)).additions.length, 1);
  });

  test("16 simultaneous retries apply once and replay after order cancellation remains read-only", async () => {
    const f = await fixture(), order = await purchase(f), input = addition(order);
    const results = await Promise.all(Array.from({ length: 16 }, () => f.db.requestOrderAddition(input)));
    results.forEach(result => assert.deepEqual(result, results[0]));
    assert.equal(await stock(f), 47);
    assert.equal((await ledger(f, order.id)).length, 2);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM order_additions")).rows[0].n, 1);
    await f.db.updateOrderStatus(order.id, "dibatalkan");
    const replay = await f.db.requestOrderAddition(input);
    assert.equal(replay.addition.status, "applied");
    assert.equal(replay.order.status, "dibatalkan");
    assert.equal(replay.order.canAddItems, false);
    assert.equal(await stock(f), 50);
    assert.equal((await ledger(f, order.id)).filter(m => m.source === "cancellation").length, 1);
  });

  test("token authentication and conflicting request keys never alter another order", async () => {
    const f = await fixture(), order = await purchase(f), other = await purchase(f);
    const input = addition(order);
    assert.equal(await f.db.requestOrderAddition({ ...input, trackingToken: crypto.randomBytes(24).toString("hex") }), null);
    await f.db.requestOrderAddition(input);
    await rejects(() => f.db.requestOrderAddition({ ...input, items: [{ id: first.id, quantity: 3 }] }), "REQUEST_CONFLICT");
    await rejects(() => f.db.requestOrderAddition({ ...addition(other), requestId: input.requestId }), "REQUEST_CONFLICT");
    assert.equal(await stock(f), 46);
    assert.equal((await saved(f, other.id)).total, String(other.total));
  });

  test("revoking a tracking token also revokes authenticated access to committed addition replays", async () => {
    const f = await fixture(), order = await purchase(f), input = addition(order);
    await f.db.requestOrderAddition(input);
    const rowsBefore = await ledger(f, order.id);
    await f.pool.query("UPDATE orders SET tracking_token=$2 WHERE id=$1", [order.id, crypto.randomBytes(24).toString("hex")]);
    assert.equal(await f.db.requestOrderAddition(input), null);
    assert.equal(await stock(f), 47);
    assert.deepEqual(await ledger(f, order.id), rowsBefore);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM order_additions")).rows[0].n, 1);
  });

  test("insufficient multi-product stock rolls back stock, ledger, order and request key", async () => {
    const f = await fixture(), order = await purchase(f);
    await f.pool.query("UPDATE inventory SET stock=0 WHERE product_id=$1", [second.id]);
    const input = addition(order, [[first, 2], [second, 1]]);
    await rejects(() => f.db.requestOrderAddition(input), "INSUFFICIENT_STOCK");
    assert.equal(await stock(f), 49);
    assert.equal((await ledger(f, order.id)).length, 1);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM operation_requests WHERE scope='order-addition'")).rows[0].n, 0);
    assert.equal((await saved(f, order.id)).total, String(order.total));
    await f.pool.query("UPDATE inventory SET stock=2 WHERE product_id=$1", [second.id]);
    assert.equal((await f.db.requestOrderAddition(input)).addition.status, "applied");
    assert.equal(await stock(f), 47);
    assert.equal(await stock(f, second), 1);
  });

  test("stale displayed price fails without reserving and the uncommitted key can be corrected", async () => {
    const f = await fixture(), order = await purchase(f), input = addition(order, [[first, 1]], { expectedTotal: 1 });
    await rejects(() => f.db.requestOrderAddition(input), "PRICE_CHANGED");
    assert.equal(await stock(f), 49);
    assert.equal((await f.db.requestOrderAddition({ ...input, expectedTotal: first.price })).order.total, order.total + first.price);
  });

  test("historical prices retain separate lines and exact retries survive a new catalog price", async () => {
    const f = await fixture(), historical = { ...first, price: first.price - 7000, name: "Historical original name" };
    const order = await purchase(f, [[historical, 1]]), input = addition(order, [[first, 1]]);
    const initial = await f.db.requestOrderAddition(input);
    assert.deepEqual(initial.order.items.map(p => [p.price, p.quantity]), [[historical.price, 1], [first.price, 1]]);
    const changed = loadWithMocks("../api/_lib/order-additions-db", { "./catalog": { PRODUCTS: PRODUCTS.map(p => p.id === first.id ? { ...p, price: p.price + 5000 } : p) } });
    assert.deepEqual(await changed.requestOrderAddition(input, f.sql), initial);
    await rejects(() => changed.requestOrderAddition({ ...input, requestId: crypto.randomUUID() }, f.sql), "PRICE_CHANGED");
    const next = await f.db.requestOrderAddition(addition(order, [[first, 2]]));
    assert.deepEqual(next.order.items.map(p => [p.price, p.quantity]), [[historical.price, 1], [first.price, 3]]);
    assert.equal(next.order.items[0].name, historical.name);
    assert.equal(next.order.items[1].subtotal, first.price * 3);
  });

  test("diproses queues only one pending addition without stock reservation or a total increase", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    await f.pool.query("UPDATE inventory SET stock=0 WHERE product_id=$1", [second.id]);
    const input = addition(order, [[second, 2]]);
    const result = await f.db.requestOrderAddition(input);
    assert.equal(result.addition.status, "pending");
    assert.equal(result.order.total, order.total);
    assert.equal(result.order.items.length, 1);
    assert.equal(await stock(f, second), 0);
    assert.equal((await ledger(f, order.id)).length, 1);
    await rejects(() => f.db.requestOrderAddition(addition(order)), "ADDITION_PENDING");
    assert.deepEqual(await f.db.requestOrderAddition(input), result);
  });

  test("concurrent different pending requests commit one complete winner", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => f.db.requestOrderAddition(addition(order))));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason.code === "ADDITION_PENDING"));
    assert.equal(await stock(f), 49);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM order_additions")).rows[0].n, 1);
  });

  test("admin approval and sixteen retries reserve once and update the original total", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    const input = addition(order), pending = await f.db.requestOrderAddition(input), approval = review(pending);
    const results = await Promise.all(Array.from({ length: 16 }, () => f.db.reviewOrderAddition(approval)));
    results.forEach(result => assert.deepEqual(result, results[0]));
    assert.equal(results[0].addition.status, "approved");
    assert.equal(results[0].order.total, order.total + input.expectedTotal);
    assert.equal(await stock(f), 47);
    assert.equal((await ledger(f, order.id)).length, 2);
    assert.deepEqual(await f.db.requestOrderAddition(input), results[0]);
    await rejects(() => f.db.reviewOrderAddition({ ...approval, decision: "reject" }), "REQUEST_CONFLICT");
    await rejects(() => f.db.reviewOrderAddition({ ...approval, requestId: crypto.randomUUID() }), "ADDITION_ALREADY_REVIEWED");
  });

  test("rejection is idempotent, leaves stock unchanged and permits a later request", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    const pending = await f.db.requestOrderAddition(addition(order)), rejection = review(pending, "reject");
    const result = await f.db.reviewOrderAddition(rejection);
    assert.equal(result.addition.status, "rejected");
    assert.deepEqual(await f.db.reviewOrderAddition(rejection), result);
    assert.equal(await stock(f), 49);
    assert.equal(result.order.total, order.total);
    assert.equal((await f.db.requestOrderAddition(addition(order))).addition.status, "pending");
  });

  test("stale admin state conflicts before review and a fresh version can approve", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses"), before = await saved(f, order.id);
    const pending = await f.db.requestOrderAddition(addition(order));
    await rejects(() => f.db.reviewOrderAddition(review(pending, "approve", { expectedUpdatedAt: before.version })), "ORDER_CONFLICT");
    assert.equal(await stock(f), 49);
    assert.equal((await f.db.reviewOrderAddition(review(pending))).addition.status, "approved");
    await rejects(() => f.db.reviewOrderAddition({ id: order.id, additionId: pending.addition.id, requestId: crypto.randomUUID(), decision: "approve" }), "INVALID_EXPECTED_STATUS");
  });

  test("approval checks current stock atomically and failed approval remains retryable", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    const pending = await f.db.requestOrderAddition(addition(order, [[first, 2], [second, 2]])), input = review(pending);
    await f.pool.query("UPDATE inventory SET stock=0 WHERE product_id=$1", [second.id]);
    await rejects(() => f.db.reviewOrderAddition(input), "INSUFFICIENT_STOCK");
    assert.equal(await stock(f), 49);
    assert.equal((await ledger(f, order.id)).length, 1);
    assert.equal((await f.db.requestOrderAddition(addition(order, [[first, 2], [second, 2]], { requestId: pending.addition.id }))).addition.status, "pending");
    await f.pool.query("UPDATE inventory SET stock=3 WHERE product_id=$1", [second.id]);
    assert.equal((await f.db.reviewOrderAddition(input)).addition.status, "approved");
  });

  test("approval after catalog price change fails, while rejection still works", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    const pending = await f.db.requestOrderAddition(addition(order));
    const changed = loadWithMocks("../api/_lib/order-additions-db", { "./catalog": { PRODUCTS: PRODUCTS.map(p => p.id === first.id ? { ...p, price: p.price + 5000 } : p) } });
    await rejects(() => changed.reviewOrderAddition(review(pending), f.sql), "PRICE_CHANGED");
    assert.equal(await stock(f), 49);
    assert.equal((await changed.reviewOrderAddition(review(pending, "reject"), f.sql)).addition.status, "rejected");
  });

  test("competing approval and rejection decide exactly once", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    const pending = await f.db.requestOrderAddition(addition(order));
    const results = await Promise.allSettled([f.db.reviewOrderAddition(review(pending)), f.db.reviewOrderAddition(review(pending, "reject"))]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.find(r => r.status === "rejected").reason.code, "ADDITION_ALREADY_REVIEWED");
    const winner = results.find(r => r.status === "fulfilled").value.addition.status;
    assert.equal(await stock(f), winner === "approved" ? 47 : 49);
    assert.equal((await ledger(f, order.id)).length, winner === "approved" ? 2 : 1);
  });

  test("approval racing cancellation never oversells or returns inventory twice", async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) {
      const order = await purchase(f, [[first, 1]], "diproses");
      const pending = await f.db.requestOrderAddition(addition(order));
      const results = await Promise.allSettled([f.db.reviewOrderAddition(review(pending)), f.db.updateOrderStatus(order.id, "dibatalkan")]);
      assert.equal(results[1].status, "fulfilled");
      assert.equal(await stock(f), 50);
      assert.equal((await saved(f, order.id)).status, "dibatalkan");
      const additionStatus = (await f.db.getPublicOrderStatus(order.id, order.trackingToken)).additions[0].status;
      assert.ok(["approved", "expired"].includes(additionStatus));
      const movements = await ledger(f, order.id);
      assert.equal(movements.reduce((n, m) => n + m.delta, 0), 0);
      assert.equal(movements.filter(m => m.source === "cancellation").length, 1);
      await f.db.updateOrderStatus(order.id, "dibatalkan");
      assert.equal(await stock(f), 50);
    }
  });

  test("addition racing cancellation either commits before cancellation or leaves no addition", async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) {
      const order = await purchase(f), input = addition(order);
      const results = await Promise.allSettled([f.db.requestOrderAddition(input), f.db.updateOrderStatus(order.id, "dibatalkan")]);
      assert.equal(results[1].status, "fulfilled");
      if (results[0].status === "rejected") assert.equal(results[0].reason.code, "ADDITION_NOT_ALLOWED");
      assert.equal(await stock(f), 50);
      assert.equal((await ledger(f, order.id)).reduce((n, m) => n + m.delta, 0), 0);
    }
  });

  test("shipping, completion and cancellation expire pending requests and disallow new ones", async () => {
    const f = await fixture();
    for (const status of ["dikirim", "selesai", "dibatalkan"]) {
      const order = await purchase(f, [[first, 1]], "diproses"), input = addition(order);
      const pending = await f.db.requestOrderAddition(input);
      await f.db.updateOrderStatus(order.id, status);
      const replay = await f.db.requestOrderAddition(input);
      assert.equal(replay.addition.status, "expired");
      assert.equal(replay.order.canAddItems, false);
      await rejects(() => f.db.requestOrderAddition(addition(order)), "ADDITION_NOT_ALLOWED");
      await rejects(() => f.db.reviewOrderAddition(review(pending)), "ADDITION_ALREADY_REVIEWED");
    }
  });

  test("unreserved legacy orders are never amended and report their ineligibility", async () => {
    const f = await fixture(), order = await purchase(f);
    await f.pool.query("UPDATE orders SET stock_reserved=FALSE WHERE id=$1", [order.id]);
    await rejects(() => f.db.requestOrderAddition(addition(order)), "ADDITION_NOT_ALLOWED");
    assert.equal((await f.db.getPublicOrderStatus(order.id, order.trackingToken)).stock_reserved, false);
    assert.equal(await stock(f), 49);
  });

  test("two different orders competing for insufficient shared inventory have one complete winner", async () => {
    const f = await fixture(5), order = await purchase(f), other = await purchase(f);
    const results = await Promise.allSettled([f.db.requestOrderAddition(addition(order)), f.db.requestOrderAddition(addition(other))]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.find(r => r.status === "rejected").reason.code, "INSUFFICIENT_STOCK");
    assert.equal(await stock(f), 1);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM order_additions")).rows[0].n, 1);
  });

  test("receipt line cap rejects both immediate and pending additions without side effects", async () => {
    const f = await fixture(), order = await purchase(f);
    const lines = Array.from({ length: 100 }, (_, i) => ({ id: first.id, name: "Historical price line", price: i + 1, quantity: 1, subtotal: i + 1 }));
    await f.pool.query("UPDATE orders SET items=$2::jsonb,total=5050 WHERE id=$1", [order.id, JSON.stringify(lines)]);
    for (const status of ["baru", "diproses"]) {
      if (status === "diproses") await f.db.updateOrderStatus(order.id, status);
      await rejects(() => f.db.requestOrderAddition(addition(order)), "ADDITION_LIMIT");
    }
    assert.equal(await stock(f), 49);
    assert.equal((await ledger(f, order.id)).length, 1);
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM order_additions")).rows[0].n, 0);
  });

  test("the hundredth receipt line remains printable and subsequent equal-price units merge", async () => {
    const f = await fixture(), order = await purchase(f);
    const lines = Array.from({ length: 99 }, (_, i) => ({ id: first.id, name: "Historical price line", price: i + 1, quantity: 1, subtotal: i + 1 }));
    await f.pool.query("UPDATE orders SET items=$2::jsonb,total=4950 WHERE id=$1", [order.id, JSON.stringify(lines)]);
    const hundredth = await f.db.requestOrderAddition(addition(order, [[first, 1]]));
    assert.equal(hundredth.order.items.length, 100);
    const merged = await f.db.requestOrderAddition(addition(order, [[first, 2]]));
    assert.equal(merged.order.items.length, 100);
    assert.equal(merged.order.items[99].quantity, 3);
    assert.equal(merged.order.total, 4950 + first.price * 3);
    assert.equal(merged.order.items.reduce((sum, p) => sum + p.subtotal, 0), merged.order.total);
  });

  test("finance and admin receipt data use the amended total only after approval", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    const finance = loadWithMocks("../api/_lib/finance-db", { "./db": f.db });
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const input = addition(order), pending = await f.db.requestOrderAddition(input);
    assert.equal((await finance.getFinanceReport({ period: "daily", date })).summary.orderValue, order.total);
    await f.db.reviewOrderAddition(review(pending));
    const receiptOrder = await f.db.getOrderById(order.id);
    assert.equal(Number(receiptOrder.total), order.total + input.expectedTotal);
    assert.equal(receiptOrder.items.reduce((sum, p) => sum + p.subtotal, 0), Number(receiptOrder.total));
    await f.db.updateOrderStatus(order.id, "selesai");
    const report = await finance.getFinanceReport({ period: "daily", date });
    assert.equal(report.summary.completedSales, order.total + input.expectedTotal);
    assert.equal(report.summary.completedCount, 1);
    assert.equal(report.summary.totalOrders, 1);
    assert.equal((await ledger(f, order.id)).length, 2);
  });

  test("concurrent repeated addition schema setup preserves existing orders and pending decisions", async () => {
    const f = await fixture(), order = await purchase(f, [[first, 1]], "diproses");
    const pending = await f.db.requestOrderAddition(addition(order));
    await Promise.all(Array.from({ length: 6 }, () => ensureOrderAdditionsSchema(f.sql)));
    assert.deepEqual((await f.db.getPublicOrderStatus(order.id, order.trackingToken)).additions[0], pending.addition);
    assert.equal((await f.db.reviewOrderAddition(review(pending))).addition.status, "approved");
  });
});
