const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalDatabaseUrl = process.env.DATABASE_URL;
test.beforeEach(() => { process.env.DATABASE_URL = "postgresql://in-process-test-only.invalid/history"; });
test.afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  delete require.cache[require.resolve("../api/_lib/db")];
});

function loadDatabase(sql) {
  const target = require.resolve("../api/_lib/db");
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === target && name === "@neondatabase/serverless") return { neon: () => sql };
    return originalLoad.call(this, name, parent, isMain);
  };
  try { return require(target); }
  finally { Module._load = originalLoad; }
}

function databaseFixture(result) {
  const calls = [];
  const sql = async (parts, ...values) => {
    const text = parts.join("?");
    calls.push({ text, values });
    return text.includes("WITH day_summary") ? [result] : [];
  };
  return { sql, calls };
}

test("history uses an indexed UTC range and deterministic page order while preserving full-day summaries", async () => {
  const orders = Array.from({ length: 5 }, (_, index) => ({ id: `DP-test-${index}`, status: "selesai", total: 50000 }));
  const fixture = databaseFixture({ orders, total_orders: "205", new_orders: "64", processing_orders: "83", order_value: "5100000" });
  const db = loadDatabase(fixture.sql);
  const history = await db.listOrdersByDate({ date: "2026-10-06", page: 3, pageSize: 100 });
  assert.deepEqual(history, {
    orders, date: "2026-10-06", timeZone: "Asia/Jakarta",
    pagination: { page: 3, pageSize: 100, total: 205, totalPages: 3, hasMore: false },
    summary: { totalOrders: 205, newOrders: 64, processingOrders: 83, orderValue: 5100000 }
  });
  const historyCalls = fixture.calls.filter(call => call.text.includes("WITH day_summary"));
  assert.equal(historyCalls.length, 1);
  const { text, values } = historyCalls[0];
  assert.deepEqual(values, [
    "2026-10-05T17:00:00.000Z", "2026-10-06T17:00:00.000Z",
    "2026-10-05T17:00:00.000Z", "2026-10-06T17:00:00.000Z", 100, 200
  ]);
  assert.match(text, /created_at >= \?::timestamptz AND created_at < \?::timestamptz/);
  assert.match(text, /ORDER BY created_at DESC, id DESC\s+LIMIT \? OFFSET \?/);
  assert.match(text, /status IN \('diproses', 'dikirim'\)/);
  assert.match(text, /SUM\(total\) FILTER \(WHERE status <> 'dibatalkan'\)/);
  assert.doesNotMatch(text, /\bDATE\s*\(created_at\)|created_at::date/i);
  assert.ok(fixture.calls.some(call => /CREATE INDEX IF NOT EXISTS orders_created_at_id_idx ON orders\(created_at DESC, id DESC\)/.test(call.text)));
  assert.ok(fixture.calls.some(call => /CREATE UNIQUE INDEX IF NOT EXISTS orders_tracking_token_idx/.test(call.text)));
  assert.equal(typeof db.listOrders, "function");
});

test("an empty date is distinguishable from an empty page of an existing date", async () => {
  for (const [total, page, expectedPages] of [[0, 1, 0], [205, 4, 3]]) {
    const fixture = databaseFixture({ orders: [], total_orders: String(total), new_orders: "0", processing_orders: "0", order_value: "0" });
    const db = loadDatabase(fixture.sql);
    const history = await db.listOrdersByDate({ date: "2026-10-06", page });
    assert.deepEqual(history.orders, []);
    assert.equal(history.pagination.total, total);
    assert.equal(history.pagination.totalPages, expectedPages);
    assert.equal(history.pagination.hasMore, false);
    assert.equal(history.summary.totalOrders, total);
  }
});

test("a page before the last page reports remaining results", async () => {
  const fixture = databaseFixture({ orders: [{ id: "test-only" }], total_orders: "201", new_orders: "10", processing_orders: "20", order_value: "100000" });
  const history = await loadDatabase(fixture.sql).listOrdersByDate({ date: "2026-10-06", page: 2 });
  assert.equal(history.pagination.hasMore, true);
  assert.equal(history.pagination.totalPages, 3);
  assert.equal(history.summary.newOrders, 10);
});

test("invalid direct history calls perform no schema or data queries", async () => {
  const fixture = databaseFixture({});
  const db = loadDatabase(fixture.sql);
  for (const options of [{ date: "2026-02-30" }, { page: 0 }, { page: 1.5 }, { pageSize: 201 }, { pageSize: 0 }]) {
    await assert.rejects(() => db.listOrdersByDate(options));
  }
  assert.equal(fixture.calls.length, 0);
});

test("missing configuration never falls back to another data source", async () => {
  delete process.env.DATABASE_URL;
  const db = loadDatabase(async () => { throw new Error("Unexpected SQL execution"); });
  await assert.rejects(() => db.listOrdersByDate({ date: "2026-10-06" }), /DATABASE_NOT_CONFIGURED/);
});
