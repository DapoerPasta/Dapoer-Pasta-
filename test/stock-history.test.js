const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { PRODUCTS } = require("../api/_lib/catalog");
const { createStockHistoryOptions, parseStockHistoryQuery, stockReason } = require("../api/_lib/stock-history");
const { validateStockAdjustment, validateStockSet } = require("../api/_lib/inventory");
const snapshot = "f5d09811-87ef-4c23-8458-1552da94d2f7";

test("stock report periods use Jakarta calendar days, ISO Monday weeks, months and leap years", () => {
  const day = createStockHistoryOptions({}, Date.parse("2026-10-14T18:00:00Z"));
  assert.equal(day.period.date, "2026-10-15");
  assert.equal(day.period.start, "2026-10-14T17:00:00.000Z");
  assert.equal(day.period.end, "2026-10-15T17:00:00.000Z");
  const week = createStockHistoryOptions({ period: "week", date: "2027-01-03" });
  assert.equal(week.period.startDate, "2026-12-28");
  assert.equal(week.period.endDate, "2027-01-03");
  const month = createStockHistoryOptions({ period: "month", date: "2024-02-29" });
  assert.equal(month.period.startDate, "2024-02-01");
  assert.equal(month.period.endDate, "2024-02-29");
  const year = createStockHistoryOptions({ period: "year", date: "2024-06-01" });
  assert.equal(year.period.start, "2023-12-31T17:00:00.000Z");
  assert.equal(year.period.end, "2024-12-31T17:00:00.000Z");
});

test("snapshot pagination cannot silently change dates, products or period", () => {
  assert.deepEqual(createStockHistoryOptions({ snapshot, cursor: 100, pageSize: 1000 }), { snapshot, cursor: 100, pageSize: 1000 });
  for (const input of [
    { snapshot: "bad" }, { snapshot, period: "week" }, { snapshot, date: "2026-10-15" },
    { snapshot, productId: PRODUCTS[0].id }, { cursor: 1 }, { cursor: 2147483648 }, { cursor: -1 },
    { pageSize: 0 }, { pageSize: 1001 }, { period: "daily" }, { period: "__proto__" },
    { date: "2026-02-29" }, { productId: "does-not-exist" }
  ]) assert.throws(() => createStockHistoryOptions(input), { code: "INVALID_STOCK_HISTORY" });
});

test("duplicate, contradictory, array and unknown report parameters are rejected", () => {
  const valid = parseStockHistoryQuery({ url: "/api/admin/stock?view=history&period=week&date=2026-10-15", query: { view: "history", period: "week", date: "2026-10-15" } });
  assert.equal(valid.period.startDate, "2026-10-12");
  for (const req of [
    { url: "/api/admin/stock?view=history&period=week&period=year" },
    { url: "/api/admin/stock?view=history&date=2026-10-15", query: { date: "2026-10-16" } },
    { query: { view: "history", date: ["2026-10-15"] } },
    { url: "/api/admin/stock?view=history&cursor=1e2" },
    { url: "/api/admin/stock?view=history&source=all" },
    { url: "/api/admin/stock?view=history&snapshot=" + snapshot + "&period=day" }
  ]) assert.throws(() => parseStockHistoryQuery(req), { code: "INVALID_STOCK_HISTORY" });
});

test("manual stock reasons accept useful multiline text, remain plain text and are bounded", () => {
  assert.equal(stockReason(undefined), "");
  assert.equal(stockReason("  Restok\nproduk\tbaru\r\ndatang  "), "Restok produk baru datang");
  assert.equal(stockReason("=SUM(A1:A5) <script>"), "=SUM(A1:A5) <script>");
  assert.equal(stockReason("x".repeat(200)).length, 200);
  for (const reason of [null, 12, {}, "x".repeat(201), "rusak\u0000", "rusak\u001b"]) {
    assert.throws(() => stockReason(reason), { code: "INVALID_STOCK_REASON" });
  }
});

function handler(overrides = {}, authenticated = true) {
  const target = require.resolve("../api/admin/stock");
  delete require.cache[target];
  const original = Module._load;
  const actualHistory = require("../api/_lib/stock-history");
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === target && name === "../_lib/security") return { guardRequest: async () => true };
    if (parent?.filename === target && name === "../_lib/auth") return { verifySession: () => authenticated };
    if (parent?.filename === target && name === "../_lib/inventory") return {
      validateStockAdjustment, validateStockSet, listInventory: async () => [], adjustStock: async () => ({}), setStock: async () => ({}), ...overrides
    };
    if (parent?.filename === target && name === "../_lib/stock-history") return { ...actualHistory, ...overrides };
    return original.call(this, name, parent, isMain);
  };
  try { return require(target); } finally { Module._load = original; }
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}
async function invoke(fn, req) { const res = response(); await fn(req, res); return res; }

test("history API remains administrator-only and passes calendar filters to the report store", async () => {
  let calls = 0;
  let received;
  const report = { movements: [], products: [], summary: { movementCount: 0 } };
  const overrides = { listStockHistory: async options => { calls++; received = options; return report; } };
  const req = { method: "GET", url: "/api/admin/stock?view=history&period=month&date=2026-10-15&productId=" + PRODUCTS[0].id };
  const unauthorized = await invoke(handler(overrides, false), req);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls, 0);
  const result = await invoke(handler(overrides), req);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "private, no-store");
  assert.equal(result.body, report);
  assert.equal(received.period.startDate, "2026-10-01");
  assert.equal(received.productId, PRODUCTS[0].id);
});

test("stock API sends a normalized optional reason without changing legacy call arguments", async () => {
  const calls = [];
  const fn = handler({ adjustStock: async (...args) => { calls.push(args); return {}; } });
  assert.equal((await invoke(fn, { method: "PATCH", body: { id: PRODUCTS[0].id, delta: 3, reason: " produk\nbaru " } })).statusCode, 200);
  assert.deepEqual(calls[0], [PRODUCTS[0].id, 3, undefined, "produk baru"]);
  assert.equal((await invoke(fn, { method: "PATCH", body: { id: PRODUCTS[0].id, delta: 1 } })).statusCode, 200);
  assert.deepEqual(calls[1], [PRODUCTS[0].id, 1, undefined]);
  assert.equal((await invoke(fn, { method: "PATCH", body: { id: PRODUCTS[0].id, delta: 1, reason: "x".repeat(201) } })).statusCode, 400);
  assert.equal(calls.length, 2);
});

test("expired report copies, bounded storage and invalid query failures are actionable", async () => {
  for (const [code, status] of [["STOCK_HISTORY_EXPIRED", 410], ["STOCK_HISTORY_BUSY", 429]]) {
    const fn = handler({ listStockHistory: async () => { throw Object.assign(new Error("Muat ulang laporan."), { code }); } });
    const result = await invoke(fn, { method: "GET", url: "/api/admin/stock?view=history" });
    assert.equal(result.statusCode, status);
    assert.equal(result.body.code, code);
    if (status === 429) assert.equal(result.headers["retry-after"], "60");
  }
  for (const url of ["/api/admin/stock?view=other", "/api/admin/stock?view=history&date=bad", "/api/admin/stock?view=history&snapshot=" + snapshot + "&period=year"]) {
    const result = await invoke(handler(), { method: "GET", url });
    assert.equal(result.statusCode, 400);
  }
});
