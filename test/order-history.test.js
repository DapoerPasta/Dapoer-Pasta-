const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createSession } = require("../api/_lib/auth");
const { todayInJakarta, dayRange, createHistoryOptions, parseHistoryQuery, HistoryQueryError } = require("../api/_lib/order-history");

const fixture = {
  ADMIN_EMAIL: "history-admin@example.test",
  ADMIN_PASSWORD: "test-only-history-password",
  ADMIN_SESSION_SECRET: "test-only-history-session-secret-at-least-32-characters"
};
const originalEnv = Object.fromEntries(Object.keys(fixture).map(name => [name, process.env[name]]));
test.beforeEach(() => Object.assign(process.env, fixture));
test.afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function authenticatedRequest(overrides = {}) {
  const token = createSession(fixture.ADMIN_EMAIL);
  return {
    method: "GET", url: "/api/admin/orders", query: {},
    headers: { cookie: `dp_admin_session=${encodeURIComponent(token)}` },
    ...overrides
  };
}

function loadHandler(listOrdersByDate) {
  const target = require.resolve("../api/admin/orders");
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === target && name === "../_lib/db") return { listOrdersByDate };
    return originalLoad.call(this, name, parent, isMain);
  };
  try { return require(target); }
  finally { Module._load = originalLoad; }
}

test("the default day changes at midnight in Jakarta even while the UTC day stays unchanged", () => {
  const before = Date.parse("2026-10-05T16:59:59.999Z");
  const after = Date.parse("2026-10-05T17:00:00.000Z");
  assert.equal(todayInJakarta(before), "2026-10-05");
  assert.equal(todayInJakarta(after), "2026-10-06");
  assert.equal(parseHistoryQuery({ query: {} }, after).date, "2026-10-06");
  assert.deepEqual(dayRange("2026-10-06"), {
    start: "2026-10-05T17:00:00.000Z", end: "2026-10-06T17:00:00.000Z"
  });
});

test("daily ranges span month/year boundaries and accept actual Gregorian leap days", () => {
  assert.deepEqual(dayRange("2026-01-01"), {
    start: "2025-12-31T17:00:00.000Z", end: "2026-01-01T17:00:00.000Z"
  });
  assert.deepEqual(dayRange("2024-02-29"), {
    start: "2024-02-28T17:00:00.000Z", end: "2024-02-29T17:00:00.000Z"
  });
  assert.deepEqual(dayRange("2000-02-29"), {
    start: "2000-02-28T17:00:00.000Z", end: "2000-02-29T17:00:00.000Z"
  });
  assert.deepEqual(dayRange("0001-01-01"), {
    start: "0001-12-31T17:00:00.000Z BC", end: "0001-01-01T17:00:00.000Z"
  });
  for (const date of ["2023-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "0000-01-01", "2026-1-01", "2026-01-1", "", " 2026-10-06", "2026-10-06T00:00:00Z", null, ["2026-10-06"]]) {
    assert.throws(() => dayRange(date), HistoryQueryError, String(date));
  }
});

test("strict query parsing accepts bounded pagination and rejects malformed or repeated parameters", () => {
  const options = parseHistoryQuery({
    url: "/api/admin/orders?date=2026-10-06&page=3&pageSize=200",
    query: { date: "2026-10-06", page: "3", pageSize: "200" }
  });
  assert.equal(options.page, 3);
  assert.equal(options.pageSize, 200);
  assert.equal(options.offset, 400);
  assert.equal(createHistoryOptions({ date: "2026-10-06" }).pageSize, 100);
  for (const value of ["0", "-1", "1.5", "1e2", "Infinity", "NaN", "+1", "01", " 1", "1 ", "", "9007199254740992", [], ["1", "2"], 1, null, {}]) {
    for (const name of ["page", "pageSize"]) {
      assert.throws(() => parseHistoryQuery({ query: { [name]: value } }), HistoryQueryError);
    }
  }
  for (const req of [
    { query: { pageSize: "201" } },
    { query: { date: ["2026-10-06"] } },
    { query: { page: "9007199254740991", pageSize: "200" } },
    { query: [], url: "/api/admin/orders" },
    { query: { date: "2026-10-06" }, url: "/api/admin/orders?date=2026-10-07" },
    { query: { date: "2026-10-06" }, url: "/api/admin/orders?date=2026-10-06&date=2026-10-06" },
    { query: { page: "1" }, url: "/api/admin/orders?page=1&page=2" },
    { query: { pageSize: "100" }, url: "/api/admin/orders?pageSize=100&pageSize=200" }
  ]) assert.throws(() => parseHistoryQuery(req), HistoryQueryError);
});

test("history access authenticates before query validation or any database read and remains private", async () => {
  let reads = 0;
  const handler = loadHandler(async () => { reads++; throw new Error("unexpected read"); });
  const denied = response();
  await handler({ method: "GET", headers: {}, query: { date: "invalid" } }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers["cache-control"], "private, no-store");
  assert.equal(reads, 0);
  const unsupported = response();
  await handler(authenticatedRequest({ method: "POST" }), unsupported);
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.headers.allow, "GET");
  assert.equal(reads, 0);
});

test("invalid authenticated dates and pagination return 400 without executing SQL", async () => {
  let reads = 0;
  const handler = loadHandler(async () => { reads++; return {}; });
  for (const query of [{ date: "2026-02-30" }, { page: "0" }, { pageSize: "201" }, { date: ["2026-10-06"] }]) {
    const res = response();
    await handler(authenticatedRequest({ query }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.orders, undefined);
  }
  assert.equal(reads, 0);
});

test("authenticated history returns the selected day and full-day totals without changing the API path", async () => {
  const history = {
    orders: [{ id: "DP-test", status: "baru" }], date: "2026-10-06", timeZone: "Asia/Jakarta",
    pagination: { page: 2, pageSize: 100, total: 201, totalPages: 3, hasMore: true },
    summary: { totalOrders: 201, newOrders: 20, processingOrders: 50, orderValue: 10000000 }
  };
  const handler = loadHandler(async options => {
    assert.equal(options.date, history.date);
    assert.equal(options.page, 2);
    assert.equal(options.start, "2026-10-05T17:00:00.000Z");
    assert.equal(options.end, "2026-10-06T17:00:00.000Z");
    return history;
  });
  const res = response();
  await handler(authenticatedRequest({ query: { date: history.date, page: "2" } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, history);
  assert.equal(res.headers["cache-control"], "private, no-store");
});

test("history gracefully reports missing database or query failure without exposing connection details", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const [message, status] of [["DATABASE_NOT_CONFIGURED", 503], ["secret connection detail", 500]]) {
      const handler = loadHandler(async () => { throw new Error(message); });
      const res = response();
      await handler(authenticatedRequest(), res);
      assert.equal(res.statusCode, status);
      assert.doesNotMatch(JSON.stringify(res.body), /secret connection detail/);
    }
  } finally { console.error = originalError; }
});
