const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const auth = require("../api/_lib/auth");
const { createRequestGuard } = require("../api/_lib/security");

const fixture = {
  ADMIN_EMAIL: "finance-admin@example.test",
  ADMIN_PASSWORD: "finance-test-only-password",
  ADMIN_SESSION_SECRET: "finance-test-only-secret-at-least-32-characters"
};
const previous = Object.fromEntries(Object.keys(fixture).map(name => [name, process.env[name]]));
test.beforeEach(() => Object.assign(process.env, fixture));
test.afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const expense = {
  id: "353d18a7-9c62-4b59-a959-d94b42bfb8ca", date: "2026-01-02", category: "bahan_baku",
  description: "Bahan pasta", amount: 125000
};
const timestamp = "2026-01-02T03:04:05.123456Z";

function response() {
  return {
    headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }
  };
}

function request(method, body, headers = {}, url = "/api/admin/finance") {
  return {
    method, body, url, socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "shop.example.test", cookie: `dp_admin_session=${auth.createSession(fixture.ADMIN_EMAIL)}`,
      ...(method === "GET" ? {} : { "content-type": "application/json" }), ...headers
    }
  };
}

function loadHandler(overrides = {}, guardOverride) {
  const target = require.resolve("../api/admin/finance");
  delete require.cache[target];
  const guard = guardOverride || createRequestGuard({ getSql: () => null, environment: {} });
  const originalLoad = Module._load;
  Module._load = function (path, parent, isMain) {
    if (parent?.filename === target && path === "../_lib/security") return { guardRequest: guard };
    if (parent?.filename === target && path === "../_lib/finance-db") return {
      getFinanceReport: async () => ({}), createExpense: async () => ({}),
      updateExpense: async () => ({}), deleteExpense: async () => ({}), ...overrides
    };
    return originalLoad.call(this, path, parent, isMain);
  };
  try { return require(target); }
  finally { Module._load = originalLoad; }
}

test("financial reads and writes require signed admin authentication before any guard or data query", async () => {
  let queries = 0;
  const query = async () => { queries++; };
  const handler = loadHandler({ getFinanceReport: query, createExpense: query, updateExpense: query, deleteExpense: query }, query);
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const res = response();
    await handler(request(method, expense, { cookie: "" }), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
    assert.equal(res.headers["cache-control"], "private, no-store");
  }
  assert.equal(queries, 0);
});

test("calendar reports pass validated WIB period and bounded expense pagination to the full report", async () => {
  const calls = [];
  const report = { summary: { completedSales: 37000, expenseTotal: 12000, recordedBalance: 25000 } };
  const handler = loadHandler({ getFinanceReport: async options => { calls.push(options); return report; } });
  const res = response();
  await handler(request("GET", undefined, {}, "/api/admin/finance?period=weekly&date=2026-01-01&expensePage=2&expensePageSize=100"), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, report);
  assert.equal(calls[0].startDate, "2025-12-29");
  assert.equal(calls[0].endDate, "2026-01-04");
  assert.equal(calls[0].expenseOffset, 100);
  assert.equal(res.headers["cache-control"], "private, no-store");
});

test("new expenses are created once and retries return the existing result without a second creation status", async () => {
  let calls = 0;
  const handler = loadHandler({ createExpense: async value => {
    assert.deepEqual(value, expense);
    return { expense: { ...expense, createdAt: timestamp, updatedAt: timestamp }, created: ++calls === 1 };
  } });
  for (const expectedStatus of [201, 200]) {
    const res = response();
    await handler(request("POST", expense), res);
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(res.body.expense.amount, 125000);
    assert.equal(res.body.created, expectedStatus === 201);
  }
});

test("expense edit and deletion preserve the exact microsecond compare-and-set token", async () => {
  const calls = [];
  const handler = loadHandler({
    updateExpense: async value => { calls.push(value); return { expense: { ...value, updatedAt: "2026-01-02T03:04:05.123457Z" } }; },
    deleteExpense: async value => { calls.push(value); return { deleted: true, id: value.id }; }
  });
  const edit = response();
  await handler(request("PATCH", { ...expense, expectedUpdatedAt: timestamp }), edit);
  assert.equal(edit.statusCode, 200);
  assert.equal(edit.body.expense.updatedAt, "2026-01-02T03:04:05.123457Z");
  const deletion = response();
  await handler(request("DELETE", { id: expense.id, expectedUpdatedAt: timestamp }), deletion);
  assert.equal(deletion.statusCode, 200);
  assert.deepEqual(deletion.body, { deleted: true, id: expense.id });
  assert.equal(calls[0].expectedUpdatedAt, timestamp);
  assert.equal(calls[1].expectedUpdatedAt, timestamp);
});

test("invalid expense and report inputs fail before financial persistence", async () => {
  let calls = 0;
  const query = async () => { calls++; };
  const handler = loadHandler({ getFinanceReport: query, createExpense: query, updateExpense: query, deleteExpense: query });
  const cases = [
    ["GET", undefined, "/api/admin/finance?period=weekly&period=monthly"],
    ["GET", undefined, "/api/admin/finance?date=2026-02-30"],
    ["GET", undefined, "/api/admin/finance?expensePageSize=101"],
    ["POST", { ...expense, amount: -1 }],
    ["POST", { ...expense, amount: "125000" }],
    ["POST", { ...expense, date: "2100-01-01" }],
    ["POST", { ...expense, description: " " }],
    ["POST", { ...expense, category: "untrusted" }],
    ["PATCH", expense],
    ["DELETE", { id: expense.id }]
  ];
  for (const [method, body, url] of cases) {
    const res = response();
    await handler(request(method, body, {}, url), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_FINANCE_INPUT");
  }
  assert.equal(calls, 0);
});

test("financial writes retain same-origin, JSON, size and method protections", async () => {
  let calls = 0;
  const query = async () => { calls++; };
  const handler = loadHandler({ createExpense: query, updateExpense: query, deleteExpense: query });
  for (const method of ["POST", "PATCH", "DELETE"]) {
    for (const [headers, expectedStatus] of [
      [{ origin: "https://attacker.example", "sec-fetch-site": "cross-site" }, 403],
      [{ "content-type": "text/plain" }, 415],
      [{ "content-length": "20000" }, 413]
    ]) {
      const res = response();
      await handler(request(method, { ...expense, expectedUpdatedAt: timestamp }, headers), res);
      assert.equal(res.statusCode, expectedStatus);
    }
  }
  const unsupported = response();
  await handler(request("PUT", expense), unsupported);
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.headers.allow, "GET, POST, PATCH, DELETE");
  assert.equal(calls, 0);
});

test("financial report requests are bounded by the existing admin rate limit", async () => {
  let calls = 0;
  const handler = loadHandler({ getFinanceReport: async () => { calls++; return {}; } });
  for (let count = 0; count < 60; count++) {
    const res = response();
    await handler(request("GET"), res);
    assert.equal(res.statusCode, 200);
  }
  const res = response();
  await handler(request("GET"), res);
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers["retry-after"]) > 0);
  assert.equal(calls, 60);
});

test("stale, missing and unavailable financial operations expose actionable status without database details", async () => {
  for (const [code, status] of [["EXPENSE_CONFLICT", 409], ["EXPENSE_NOT_FOUND", 404], ["DATABASE_NOT_CONFIGURED", 503], ["INTERNAL", 503]]) {
    const handler = loadHandler({ updateExpense: async () => {
      throw Object.assign(new Error("Sensitive database detail"), { code });
    } });
    const res = response();
    await handler(request("PATCH", { ...expense, expectedUpdatedAt: timestamp }), res);
    assert.equal(res.statusCode, status);
    assert.doesNotMatch(res.body.error, /Sensitive database detail/);
  }
});
