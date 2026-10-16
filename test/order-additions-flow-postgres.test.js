// Actual HTTP handlers, auth, guards and financial/receipt reads against an
// isolated LOCAL PostgreSQL schema. Never use an application database here.
const { describe, test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const { PRODUCTS } = require("../api/_lib/catalog");
const { createRequestGuard } = require("../api/_lib/security");
const { createSession } = require("../api/_lib/auth");
const { todayInJakarta } = require("../api/_lib/order-history");
const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const envNames = ["DATABASE_URL", "ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"];
const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const fixtures = [];
let adminPool, sequence = 0;
const first = PRODUCTS[0], extra = PRODUCTS.find(product => product.id === "pasta-brulee-oval-2pcs");

function load(targetName, mocks) {
  const target = require.resolve(targetName);
  delete require.cache[target];
  const original = Module._load;
  Module._load = function (name, parent, main) {
    if (parent?.filename === target && Object.hasOwn(mocks, name)) return mocks[name];
    return original.call(this, name, parent, main);
  };
  try { return require(target); } finally { Module._load = original; }
}

async function fixture() {
  const schema = `addition_flow_${process.pid}_${sequence++}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 8,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=12000` });
  const sql = async (parts, ...values) => {
    const text = typeof parts === "string" ? parts : parts.reduce((result, part, index) => result + (index ? `$${index}` : "") + part, "");
    return (await pool.query(text, values)).rows;
  };
  sql.query = async (text, values = []) => (await pool.query(text, values)).rows;
  const db = load("../api/_lib/db", { "@neondatabase/serverless": { neon: () => sql } });
  const guard = createRequestGuard({ getSql: () => sql, environment: {} });
  const handlers = {};
  for (const name of ["order", "track", "receipt", "admin/orders", "admin/status"]) {
    const prefix = name.startsWith("admin/") ? "../_lib/" : "./_lib/";
    handlers[name] = load(`../api/${name}`, { [prefix + "db"]: db, [prefix + "security"]: { guardRequest: guard } });
  }
  const finance = load("../api/_lib/finance-db", { "./db": db });
  const result = { schema, pool, db, handlers, finance };
  fixtures.push(result);
  await db.ensureSchema();
  await pool.query("UPDATE inventory SET stock=10");
  return result;
}

async function clean() {
  while (fixtures.length) {
    const { pool, schema } = fixtures.pop();
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}
async function call(handler, { body, query = {}, admin = false, origin = "http://shop.example.test", method = body ? "POST" : "GET" } = {}) {
  const headers = { host: "shop.example.test", "content-type": "application/json", origin };
  if (admin) headers.cookie = `dp_admin_session=${encodeURIComponent(createSession(process.env.ADMIN_EMAIL))}`;
  const response = { headers: {}, statusCode: 200,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; } };
  await handler({ method, body, query, headers, socket: { remoteAddress: "127.0.0.1" } }, response);
  return response;
}
async function purchase(handlers) {
  const created = await call(handlers.order, { body: { requestId: crypto.randomUUID(), expectedTotal: first.price,
    items: [{ id: first.id, quantity: 1 }], customer: { name: "Local private buyer", phone: "081234567899",
      address: "Local private shipping address", notes: "Private note", paymentMethod: "Transfer Bank" } } });
  assert.equal(created.statusCode, 200);
  const url = new URL(created.body.trackingUrl);
  return { order: created.body.order, id: created.body.order.id, token: url.searchParams.get("token") };
}
const additionBody = ({ id, token }) => ({ action: "add-items", id, token,
  requestId: crypto.randomUUID(), expectedTotal: extra.price, items: [{ id: extra.id, quantity: 1 }] });
async function version(pool, id) {
  return (await pool.query("SELECT status, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS version FROM orders WHERE id=$1", [id])).rows[0];
}
async function stocks(pool) {
  return Object.fromEntries((await pool.query("SELECT product_id,stock FROM inventory")).rows.map(row => [row.product_id, row.stock]));
}

describe("same-order additions through actual APIs and PostgreSQL", { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    const url = new URL(databaseUrl);
    assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only LOCAL scratch databases are allowed");
    assert.match(url.pathname, /^\/dapoer_stock_test(?:_[a-z0-9_]+)?$/);
    process.env.DATABASE_URL = databaseUrl;
    process.env.ADMIN_EMAIL = "local-additions-admin@example.test";
    process.env.ADMIN_PASSWORD = "local-test-password";
    process.env.ADMIN_SESSION_SECRET = "local-additions-integration-secret-with-at-least-32-characters";
    const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  });
  afterEach(clean);
  after(async () => {
    await clean();
    await adminPool?.end();
    for (const name of envNames) { if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name]; }
  });

  test("direct addition remains one order and reaches tracking, admin receipt, history and completed sales", async () => {
    const { pool, db, handlers, finance } = await fixture();
    const saved = await purchase(handlers), body = additionBody(saved);
    const added = await call(handlers.order, { body });
    assert.equal(added.statusCode, 200);
    assert.equal(added.body.addition.status, "applied");
    assert.equal(added.body.order.id, saved.id);
    assert.equal(added.body.order.queueNumber, saved.order.queueNumber);
    assert.equal(added.body.order.queueDate, saved.order.queueDate);
    assert.equal(added.body.order.total, first.price + extra.price);
    const replay = await call(handlers.order, { body });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.order.total, first.price + extra.price);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count, 1);
    assert.equal((await stocks(pool))[extra.id], 9);
    const tracked = await call(handlers.track, { query: { id: saved.id, token: saved.token } });
    assert.equal(tracked.body.order.additions[0].id, body.requestId);
    for (const privateValue of ["Local private buyer", "081234567899", "Local private shipping address", "Private note"]) assert(!JSON.stringify(tracked.body).includes(privateValue));
    assert.equal((await call(handlers.receipt, { query: { id: saved.id, token: saved.token } })).statusCode, 401);
    const receipt = await call(handlers.receipt, { admin: true, query: { id: saved.id } });
    assert.equal(receipt.statusCode, 200);
    assert.equal(receipt.body.order.total, first.price + extra.price);
    assert.equal(receipt.body.order.customerName, "Local private buyer");
    const history = await call(handlers["admin/orders"], { admin: true, query: { date: todayInJakarta() } });
    assert.equal(history.statusCode, 200);
    assert.equal(history.body.summary.orderValue, first.price + extra.price);
    assert.equal(history.body.orders[0].additions[0].status, "applied");
    await db.updateOrderStatus(saved.id, "selesai");
    const report = await finance.getFinanceReport({ period: "daily", date: todayInJakarta() });
    assert.equal(report.summary.completedCount, 1);
    assert.equal(report.summary.completedSales, first.price + extra.price);
  });

  test("processing additions need authorized approval; replay and cancellation leave stock and ledger consistent", async () => {
    const { pool, db, handlers } = await fixture();
    const saved = await purchase(handlers);
    await db.updateOrderStatus(saved.id, "diproses");
    const body = additionBody(saved), added = await call(handlers.order, { body });
    assert.equal(added.statusCode, 200);
    assert.equal(added.body.addition.status, "pending");
    assert.equal(added.body.order.total, first.price);
    assert.equal((await stocks(pool))[extra.id], 10);
    const observed = await version(pool, saved.id);
    const review = { action: "review-addition", id: saved.id, additionId: body.requestId, decision: "approve",
      requestId: crypto.randomUUID(), expectedStatus: observed.status, expectedUpdatedAt: observed.version };
    assert.equal((await call(handlers["admin/orders"], { body: review })).statusCode, 401);
    assert.equal((await call(handlers["admin/orders"], { body: review, admin: true, origin: "http://attacker.example.test" })).statusCode, 403);
    const approved = await call(handlers["admin/orders"], { body: review, admin: true });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.body.addition.status, "approved");
    assert.equal(approved.body.order.total, first.price + extra.price);
    assert.equal((await call(handlers["admin/orders"], { body: review, admin: true })).statusCode, 200);
    assert.equal((await stocks(pool))[extra.id], 9);
    const pending = await call(handlers.order, { body: additionBody(saved) });
    assert.equal(pending.body.addition.status, "pending");
    await db.updateOrderStatus(saved.id, "dibatalkan");
    assert.equal((await stocks(pool))[first.id], 10);
    assert.equal((await stocks(pool))[extra.id], 10);
    const tracked = await call(handlers.track, { query: { id: saved.id, token: saved.token } });
    assert.equal(tracked.body.order.additions.find(item => item.id === pending.body.addition.id).status, "expired");
    const movements = (await pool.query("SELECT product_id,source,delta,reason FROM inventory_movements WHERE order_id=$1 ORDER BY id", [saved.id])).rows;
    assert.equal(movements.reduce((sum, row) => sum + row.delta, 0), 0);
    assert.equal(movements.filter(row => row.source === "order").length, 2);
    assert(movements.some(row => row.source === "order" && row.reason.includes(body.requestId)));
    assert.equal(movements.filter(row => row.source === "cancellation").length, 2);
  });
});
