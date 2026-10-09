const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const query = { id: "DP-TEST-1234", token: "a".repeat(48) };
const savedOrder = {
  id: query.id,
  customer_name: "Nama pelanggan privat",
  customer_phone: "081234567899",
  address: "Alamat pelanggan privat",
  notes: "Catatan pelanggan privat",
  items: [{
    id: "pasta", name: "Pasta", price: 37000, quantity: 2, subtotal: 74000,
    customer_phone: "Nomor terselip privat", metadata: { address: "Alamat terselip privat" }
  }],
  total: "74000",
  status: "baru",
  payment_method: "OVO",
  tracking_token: query.token,
  queue_number: 12,
  queue_date: "2026-10-06",
  created_at: "2026-10-06T00:00:00.000Z",
  updated_at: "2026-10-06T00:00:00.000Z"
};

// Load only the handler under test with isolated database/auth/guard substitutes.
// These tests never connect to a database or require production credentials.
function handlerFor(endpoint, options = {}) {
  const calls = { database: [], auth: [], guard: [] };
  const dependencies = {
    "./_lib/db": {
      async getPublicOrderStatus(id, token) {
        calls.database.push({ id, token });
        if (options.error) throw options.error;
        return options.order === undefined ? savedOrder : options.order;
      },
      async getOrderById(id) {
        calls.database.push({ id, adminOnly: true });
        if (options.error) throw options.error;
        return options.order === undefined ? savedOrder : options.order;
      }
    },
    "./_lib/order-queue": require("../api/_lib/order-queue"),
    "./_lib/auth": {
      verifySession(req) {
        calls.auth.push(req);
        return req.headers.cookie === "test_admin=valid" ? { email: "admin@example.invalid" } : null;
      }
    },
    "./_lib/security": {
      async guardRequest(req, res, policy) {
        calls.guard.push(policy);
        res.setHeader("Cache-Control", "private, no-store");
        if (options.blocked) {
          res.setHeader("Retry-After", "60");
          res.status(429).json({ error: "Terlalu banyak permintaan." });
          return false;
        }
        return true;
      }
    }
  };
  const filename = path.join(__dirname, "..", "api", `${endpoint}.js`);
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function (require, module, exports, console) {\n${fs.readFileSync(filename, "utf8")}\n})`, { filename });
  load(name => {
    assert(dependencies[name], `Unexpected handler dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, { error() {} });
  return { handler: module.exports, calls };
}

async function invoke(endpoint, options = {}, request = {}) {
  const { handler, calls } = handlerFor(endpoint, options);
  const req = { method: "GET", query: { ...query }, headers: {}, ...request };
  const res = {
    headers: {}, statusCode: 200, finished: false,
    setHeader(name, value) {
      assert(!this.finished, "Headers must be set before the response is sent");
      this.headers[name.toLowerCase()] = value;
    },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; }
  };
  await handler(req, res);
  return { res, calls };
}

function assertPrivateHeaders(res) {
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
}

function assertNoCustomerData(order) {
  for (const key of ["customerName", "customerPhone", "customer_name", "customer_phone", "address", "notes", "tracking_token"]) {
    assert(!Object.hasOwn(order, key), `Public payload includes ${key}`);
  }
  const body = JSON.stringify(order);
  for (const value of [savedOrder.customer_name, savedOrder.customer_phone, savedOrder.address, savedOrder.notes, "Nomor terselip privat", "Alamat terselip privat"]) {
    assert(!body.includes(value), `Public payload leaks ${value}`);
  }
}

test("existing token receipt exposes items and status without customer data", async () => {
  const { res, calls } = await invoke("receipt");
  assert.equal(res.statusCode, 200);
  assertPrivateHeaders(res);
  assert.equal(res.headers.vary, "Cookie");
  assertNoCustomerData(res.body.order);
  assert.deepEqual(Object.keys(res.body.order).sort(), ["id", "items", "total", "status", "paymentMethod", "createdAt", "updatedAt", "customerDataProtected", "queueNumber", "queueDate", "queueLabel"].sort());
  assert.equal(res.body.order.customerDataProtected, true);
  assert.equal(res.body.order.total, 74000);
  assert.equal(res.body.order.status, "baru");
  assert.equal(res.body.order.queueNumber, 12);
  assert.equal(res.body.order.queueDate, "2026-10-06");
  assert.equal(res.body.order.queueLabel, "A012");
  assert.deepEqual(res.body.order.items, [{ id: "pasta", name: "Pasta", price: 37000, quantity: 2, subtotal: 74000 }]);
  assert.deepEqual(calls.database, [query]);
  assert.deepEqual(calls.guard, [{ scope: "receipt", methods: ["GET"] }]);
  assert.equal(calls.auth.length, 1);
});

test("a verified admin can see customer details through the same receipt link", async () => {
  const { res, calls } = await invoke("receipt", {}, { headers: { cookie: "test_admin=valid" } });
  assert.equal(res.statusCode, 200);
  assertPrivateHeaders(res);
  assert.equal(res.body.order.customerDataProtected, false);
  assert.equal(res.body.order.customerName, savedOrder.customer_name);
  assert.equal(res.body.order.customerPhone, savedOrder.customer_phone);
  assert.equal(res.body.order.address, savedOrder.address);
  assert.equal(res.body.order.notes, savedOrder.notes);
  assert.deepEqual(calls.database, [query]);
  assert.equal(calls.auth.length, 1);
});

test("an invalid session does not reveal receipt customer details", async () => {
  const { res } = await invoke("receipt", {}, { headers: { cookie: "test_admin=forged" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.customerDataProtected, true);
  assertNoCustomerData(res.body.order);
});

test("an authenticated admin can print legacy orders using only their id", async () => {
  const { res, calls } = await invoke("receipt", { order: { ...savedOrder, tracking_token: null } }, {
    query: { id: query.id }, headers: { cookie: "test_admin=valid" }
  });
  assert.equal(res.statusCode, 200);
  assertPrivateHeaders(res);
  assert.equal(res.headers.vary, "Cookie");
  assert.equal(res.body.order.customerDataProtected, false);
  assert.equal(res.body.order.customerName, savedOrder.customer_name);
  assert.equal(res.body.order.queueLabel, "A012");
  assert.deepEqual(calls.database, [{ id: query.id, adminOnly: true }]);
  assert.equal(calls.auth.length, 1);
});

test("id-only receipts require a valid session before lookup or rate-limit queries", async () => {
  for (const id of [query.id, "DP-NOT-FOUND"]) {
    for (const headers of [{}, { cookie: "test_admin=forged" }]) {
      const { res, calls } = await invoke("receipt", {}, { query: { id }, headers });
      assert.equal(res.statusCode, 401);
      assertPrivateHeaders(res);
      assert.equal(res.headers.vary, "Cookie");
      assert.deepEqual(calls.database, []);
      assert.deepEqual(calls.guard, []);
      assert(!Object.hasOwn(res.body, "order"));
    }
  }
});

test("a private id-only not-found receipt returns no customer data", async () => {
  const { res, calls } = await invoke("receipt", { order: null }, {
    query: { id: query.id }, headers: { cookie: "test_admin=valid" }
  });
  assert.equal(res.statusCode, 404);
  assertPrivateHeaders(res);
  assert(!Object.hasOwn(res.body, "order"));
  assert.deepEqual(calls.database, [{ id: query.id, adminOnly: true }]);
});

test("tracking uses a public allowlist even for an authenticated admin", async () => {
  const { res, calls } = await invoke("track", {}, { headers: { cookie: "test_admin=valid" } });
  assert.equal(res.statusCode, 200);
  assertPrivateHeaders(res);
  assertNoCustomerData(res.body.order);
  assert.deepEqual(Object.keys(res.body.order).sort(), ["id", "items", "total", "status", "paymentMethod", "createdAt", "updatedAt", "queueNumber", "queueDate", "queueLabel"].sort());
  assert.equal(res.body.order.queueLabel, "A012");
  assert.deepEqual(res.body.order.items, [{ id: "pasta", name: "Pasta", price: 37000, quantity: 2, subtotal: 74000 }]);
  assert.deepEqual(calls.guard, [{ scope: "track", methods: ["GET"] }]);
});

for (const endpoint of ["receipt", "track"]) {
  test(`${endpoint}: missing or short token is rejected before database/limiter access`, async () => {
    const invalidQueries = [{ ...query, token: "short" }, { token: query.token }, { ...query, token: [query.token] }, { ...query, id: [query.id] }];
    if (endpoint === "track") invalidQueries.push({ id: query.id });
    for (const invalidQuery of invalidQueries) {
      const { res, calls } = await invoke(endpoint, {}, { query: invalidQuery });
      assert.equal(res.statusCode, 400);
      assertPrivateHeaders(res);
      assert.deepEqual(calls.database, []);
      assert.deepEqual(calls.guard, []);
    }
  });

  test(`${endpoint}: a nonmatching token returns no order data`, async () => {
    const { res, calls } = await invoke(endpoint, { order: null }, { query: { ...query, token: "b".repeat(48) } });
    assert.equal(res.statusCode, 404);
    assertPrivateHeaders(res);
    assert(!Object.hasOwn(res.body, "order"));
    assert.equal(calls.database[0].token, "b".repeat(48));
  });

  test(`${endpoint}: an admin session still requires a matching tracking token`, async () => {
    const { res } = await invoke(endpoint, { order: null }, { headers: { cookie: "test_admin=valid" } });
    assert.equal(res.statusCode, 404);
    assertPrivateHeaders(res);
    assert(!Object.hasOwn(res.body, "order"));
  });

  test(`${endpoint}: unsupported method keeps privacy headers`, async () => {
    const { res, calls } = await invoke(endpoint, {}, { method: "POST" });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "GET");
    assertPrivateHeaders(res);
    assert.deepEqual(calls.database, []);
  });

  test(`${endpoint}: unavailable database returns a private 503`, async () => {
    const { res } = await invoke(endpoint, { error: new Error("DATABASE_NOT_CONFIGURED") });
    assert.equal(res.statusCode, 503);
    assertPrivateHeaders(res);
    assert(!Object.hasOwn(res.body, "order"));
  });

  test(`${endpoint}: database failure returns a private generic error`, async () => {
    const { res } = await invoke(endpoint, { error: new Error("sensitive database error") });
    assert.equal(res.statusCode, 500);
    assertPrivateHeaders(res);
    assert(!JSON.stringify(res.body).includes("sensitive database error"));
  });

  test(`${endpoint}: a rate-limited response has privacy headers and never loads the order`, async () => {
    const { res, calls } = await invoke(endpoint, { blocked: true });
    assert.equal(res.statusCode, 429);
    assertPrivateHeaders(res);
    assert.equal(res.headers["retry-after"], "60");
    assert.deepEqual(calls.database, []);
  });
}
