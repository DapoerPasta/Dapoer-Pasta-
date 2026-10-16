const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createRequestGuard } = require("../api/_lib/security");
const { createSession } = require("../api/_lib/auth");
const { PRODUCTS, STORE } = require("../api/_lib/catalog");
const { additionRequest, publicAddition, publicOrder, ADDITION_CONFLICTS } = require("../api/_lib/order-additions");

const fixture = {
  ADMIN_EMAIL: "addition-admin@example.test",
  ADMIN_PASSWORD: "test-only-addition-password",
  ADMIN_SESSION_SECRET: "test-only-addition-session-secret-with-more-than-32-characters"
};
const originalEnv = Object.fromEntries(Object.keys(fixture).map(name => [name, process.env[name]]));
test.beforeEach(() => Object.assign(process.env, fixture));
test.afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const UUID = "24825369-2e8e-4a97-9bd7-c9a6cfc79c47";
const REVIEW_UUID = "ec829cd8-1448-4e4a-9d48-bb461a0793b6";
const TOKEN = "a".repeat(48);
const VERSION = "2026-10-16T01:02:03.123456Z";
const ID = "DP-EXISTING-ORDER";
const product = PRODUCTS[0];
const item = (quantity = 1) => ({ id: product.id, name: product.name, price: product.price,
  quantity, subtotal: product.price * quantity });

function addition(status = "applied") {
  return { id: UUID, status, items: [item()], total: product.price,
    createdAt: VERSION, updatedAt: VERSION, fingerprint: "PRIVATE_FINGERPRINT",
    customer: { name: "PRIVATE_CUSTOMER" }, token: "PRIVATE_TOKEN" };
}

function order(status = "baru") {
  return { id: ID, status, items: [item(2)], total: product.price * 2, payment_method: "Transfer Bank",
    queue_number: 7, queue_date: "2026-10-16", created_at: VERSION, updated_at: VERSION,
    stock_reserved: true, customer_name: "PRIVATE_CUSTOMER", customer_phone: "PRIVATE_PHONE",
    address: "PRIVATE_ADDRESS", notes: "PRIVATE_NOTES", tracking_token: "PRIVATE_TOKEN",
    additions: [addition(status === "diproses" ? "pending" : "applied")] };
}

function body(overrides = {}) {
  return { action: "add-items", id: ID, token: TOKEN, requestId: UUID,
    items: [{ id: product.id, quantity: 1 }], expectedTotal: product.price, ...overrides };
}

function review(overrides = {}) {
  return { action: "review-addition", id: ID, additionId: UUID, decision: "approve", requestId: REVIEW_UUID,
    expectedStatus: "diproses", expectedUpdatedAt: VERSION, ...overrides };
}

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}

function request(value = body(), overrides = {}) {
  return { method: "POST", body: value, socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "shop.example.test", origin: "http://shop.example.test", "content-type": "application/json" },
    ...overrides };
}

function adminRequest(value = review(), overrides = {}) {
  const req = request(value, overrides);
  req.headers = { ...req.headers, cookie: `dp_admin_session=${encodeURIComponent(createSession(fixture.ADMIN_EMAIL))}` };
  return req;
}

function handler(name, database = {}, options = {}) {
  const target = require.resolve(`../api/${name}`);
  delete require.cache[target];
  const guard = options.guard || createRequestGuard({ getSql: () => null, environment: {} });
  const original = Module._load;
  Module._load = function (path, parent, isMain) {
    if (parent?.filename === target && path.endsWith("/_lib/db")) return database;
    if (parent?.filename === target && path.endsWith("/_lib/security")) return { guardRequest: guard };
    return original.call(this, path, parent, isMain);
  };
  try { return require(target); } finally { Module._load = original; }
}

function assertPublic(value) {
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|customer|address|notes|fingerprint|tracking_token|trackingToken|receiptUrl/);
}

test("addition normalization merges quantities, uses catalog values and canonicalizes item order", () => {
  const second = PRODUCTS[1];
  const input = additionRequest(body({ requestId: UUID.toUpperCase(), items: [
    { id: second.id, quantity: 1, name: "Wrong", price: 1 },
    { id: product.id, quantity: 2, price: 1 }, { id: product.id, quantity: 3 }
  ] }));
  assert.equal(input.requestId, UUID);
  assert.equal(input.trackingToken, TOKEN);
  assert.equal(input.expectedTotal, product.price);
  assert.deepEqual(input.items.map(({ id }) => id), [product.id, second.id].sort());
  assert.deepEqual(input.items.find(({ id }) => id === product.id), item(5));
  assert.equal(input.total, product.price * 5 + second.price);
  assert.equal(input.customer, undefined);
});

test("public summaries whitelist every nested addition and item and expose stock eligibility safely", () => {
  const source = order();
  source.items[0].customer = "PRIVATE_CUSTOMER";
  source.additions[0].items[0].notes = "PRIVATE_NOTES";
  const value = publicOrder(source);
  assertPublic(value);
  assert.equal(value.queueLabel, "A007");
  assert.equal(value.canAddItems, true);
  assert.equal(publicOrder({ ...source, stock_reserved: false }).canAddItems, false);
  for (const status of ["dikirim", "selesai", "dibatalkan"]) {
    assert.equal(publicOrder({ ...source, status, canAddItems: true }).canAddItems, false);
  }
  assert.equal(publicAddition({ ...addition(), status: "unrecognized" }).status, "expired");
});

test("add-items is dispatched to the existing-order mutation only and response has no customer fields", async () => {
  const calls = [];
  const api = handler("order", { saveOrder: async () => assert.fail("must not create an order"),
    requestOrderAddition: async input => { calls.push(input); return { addition: addition(), order: order() }; } });
  const res = response();
  await api(request(body({ customer: { name: "PRIVATE_INPUT" } })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.persisted, true);
  assert.equal(res.body.order.id, ID);
  assert.equal(res.body.order.queueNumber, 7);
  assert.equal(res.body.order.additions.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], additionRequest(body()));
  assertPublic(res.body.order);
  assertPublic(res.body.addition);
  const tracking = new URL(res.body.trackingUrl);
  assert.equal(tracking.pathname, "/track/");
  assert.equal(tracking.searchParams.get("id"), ID);
  assert.equal(tracking.searchParams.get("token"), TOKEN);
  const whatsapp = new URL(res.body.whatsappUrl);
  assert.equal(whatsapp.origin, "https://api.whatsapp.com");
  assert.equal(whatsapp.searchParams.get("phone"), STORE.whatsapp);
  assert.match(whatsapp.searchParams.get("text"), /TOTAL PESANAN TERBARU/);
  assert.doesNotMatch(whatsapp.searchParams.get("text"), /PRIVATE_/);
  assert.match(res.headers["cache-control"], /no-store/);
});

test("pending additions preserve the existing total and explain that approval and payment are outstanding", async () => {
  const source = order("diproses");
  const api = handler("order", { requestOrderAddition: async () => ({ addition: addition("pending"), order: source }) });
  const res = response(); await api(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.addition.status, "pending");
  assert.equal(res.body.order.total, source.total);
  const text = new URL(res.body.whatsappUrl).searchParams.get("text");
  assert.match(text, /MENUNGGU PERSETUJUAN ADMIN/);
  assert.match(text, /belum termasuk tambahan/);
  assert.match(text, /belum perlu dibayar/);
  assert.doesNotMatch(text, /TOTAL PESANAN TERBARU/);
});

test("add-items forwards identical retry identity and never generates a replacement checkout UUID", async () => {
  const calls = [];
  const api = handler("order", { saveOrder: async () => assert.fail("must not create a second checkout"),
    requestOrderAddition: async input => { calls.push(input); return { addition: addition(), order: order() }; } });
  const first = response(); const replay = response();
  await api(request(), first); await api(request(), replay);
  assert.equal(first.statusCode, 200); assert.equal(replay.statusCode, 200);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].requestId, UUID);
  assert.deepEqual(first.body, replay.body);
});

test("unknown action values cannot fall through to checkout or addition persistence", async () => {
  let writes = 0;
  for (const action of ["", "add-item", "checkout", "review-addition", null, false, 0, {}, []]) {
    const api = handler("order", { saveOrder: async () => { writes++; }, requestOrderAddition: async () => { writes++; } });
    const res = response(); await api(request(body({ action })), res);
    assert.equal(res.statusCode, 400, JSON.stringify(action));
    assert.equal(res.body.code, "INVALID_ACTION");
    assert.equal(res.body.order, undefined);
  }
  assert.equal(writes, 0);
});

test("malformed addition credentials, retry identity, expected totals and quantities fail before persistence", async () => {
  const cases = [
    { id: "" }, { id: "../order" }, { id: [ID] }, { id: "x".repeat(101) },
    ...[undefined, null, "", "a".repeat(47), "a".repeat(49), "z".repeat(48), [TOKEN], 123].map(token => ({ token })),
    ...[undefined, null, "", "not-a-uuid", 12].map(requestId => ({ requestId })),
    ...[undefined, null, 0, -1, "37000", 1.5, Number.MAX_SAFE_INTEGER + 1].map(expectedTotal => ({ expectedTotal })),
    ...[null, [], {}, [{ id: "unknown", quantity: 1 }], [{ id: product.id, quantity: 0 }],
      [{ id: product.id, quantity: -1 }], [{ id: product.id, quantity: "1" }],
      [{ id: product.id, quantity: 1.1 }], [{ id: product.id, quantity: 1000001 }],
      [{ id: product.id, quantity: 1000000 }, { id: product.id, quantity: 1 }],
      Array.from({ length: 21 }, () => ({ id: product.id, quantity: 1 }))].map(items => ({ items }))
  ];
  let writes = 0;
  for (const invalid of cases) {
    const api = handler("order", { saveOrder: async () => { writes++; }, requestOrderAddition: async () => { writes++; } });
    const res = response(); await api(request(body(invalid)), res);
    assert.equal(res.statusCode, 400, JSON.stringify(invalid));
    assert.equal(res.body.order, undefined);
    assert.equal(res.body.whatsappUrl, undefined);
  }
  assert.equal(writes, 0);
});

test("a well-formed incorrect order token is indistinguishable from an unknown order", async () => {
  const calls = [];
  const api = handler("order", { requestOrderAddition: async input => { calls.push(input); return null; } });
  for (const input of [body(), body({ id: "DP-DOES-NOT-EXIST", token: "b".repeat(48) })]) {
    const res = response(); await api(request(input), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "Pesanan tidak ditemukan." });
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[1].trackingToken, "b".repeat(48));
});

test("addition conflicts have stable codes and never return successful links or customer details", async () => {
  for (const code of Object.keys(ADDITION_CONFLICTS)) {
    const api = handler("order", { requestOrderAddition: async () => { throw Object.assign(new Error("PRIVATE_DATABASE"), { code }); } });
    const res = response(); await api(request(), res);
    assert.equal(res.statusCode, 409, code);
    assert.equal(res.body.code, code);
    assert.equal(res.body.order, undefined);
    assert.equal(res.body.trackingUrl, undefined);
    assert.equal(res.body.whatsappUrl, undefined);
    assertPublic(res.body);
    if (code === "PRICE_CHANGED") {
      assert.deepEqual(res.body.items, [item()]);
      assert.equal(res.body.total, product.price);
    }
  }
});

test("addition missing-record and infrastructure errors remain private and do not report persistence", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    for (const [code, expected] of [["ADDITION_NOT_FOUND", 404], ["DATABASE_NOT_CONFIGURED", 503], ["PRIVATE_DATABASE_CREDENTIAL", 503]]) {
      const api = handler("order", { requestOrderAddition: async () => { throw Object.assign(new Error(code), { code }); } });
      const res = response(); await api(request(), res);
      assert.equal(res.statusCode, expected);
      assert.equal(res.body.persisted, undefined);
      assert.equal(res.body.whatsappUrl, undefined);
      assertPublic(res.body);
    }
  } finally { console.error = original; }
});

test("real public request guard rejects cross-origin, non-JSON and oversized additions before writes", async () => {
  let writes = 0;
  const cases = [
    [{ origin: "https://attacker.example" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ "content-type": "text/plain" }, 415],
    [{ "content-length": "16385" }, 413]
  ];
  for (const [headers, expected] of cases) {
    const api = handler("order", { requestOrderAddition: async () => { writes++; } });
    const req = request(); req.headers = { ...req.headers, ...headers };
    const res = response(); await api(req, res);
    assert.equal(res.statusCode, expected);
  }
  const api = handler("order", { requestOrderAddition: async () => { writes++; } });
  const unsupported = response(); await api(request(undefined, { method: "PATCH" }), unsupported);
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.headers.allow, "POST");
  assert.equal(writes, 0);
});

test("the additions mutation uses the existing order rate limit and cannot bypass it with a fresh UUID", async () => {
  let writes = 0;
  const api = handler("order", { requestOrderAddition: async () => { writes++; return { addition: addition(), order: order() }; } });
  for (let n = 0; n < 10; n++) {
    const res = response(); await api(request(), res); assert.equal(res.statusCode, 200);
  }
  const denied = response(); await api(request(body({ requestId: REVIEW_UUID })), denied);
  assert.equal(denied.statusCode, 429);
  assert.equal(writes, 10);
  assert.ok(Number(denied.headers["retry-after"]) > 0);
});

test("tracking includes safe addition history while withholding all customer fields and tracking credentials", async () => {
  const calls = [];
  const api = handler("track", { getPublicOrderStatus: async (...args) => { calls.push(args); return order("diproses"); } });
  const res = response();
  await api(request(undefined, { method: "GET", query: { id: ID, token: TOKEN } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [[ID, TOKEN]]);
  assertPublic(res.body);
  assert.equal(res.body.order.additions[0].status, "pending");
  assert.equal(res.body.order.canAddItems, true);
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
});

test("tracking null credentials or lookup never expose addition metadata", async () => {
  let reads = 0;
  const api = handler("track", { getPublicOrderStatus: async () => { reads++; return null; } });
  const invalid = response(); await api(request(undefined, { method: "GET", query: { id: ID } }), invalid);
  assert.equal(invalid.statusCode, 400); assert.equal(reads, 0);
  const unknown = response(); await api(request(undefined, { method: "GET", query: { id: ID, token: TOKEN } }), unknown);
  assert.equal(unknown.statusCode, 404); assert.equal(reads, 1);
  assert.equal(unknown.body.order, undefined);
});

test("admin review requires a valid session before request guarding, body validation or database access", async () => {
  let guarded = 0; let writes = 0;
  const api = handler("admin/orders", { reviewOrderAddition: async () => { writes++; } },
    { guard: async () => { guarded++; return true; } });
  for (const cookie of [undefined, "dp_admin_session=invalid"]) {
    const req = request({ action: "invalid" }); if (cookie) req.headers.cookie = cookie;
    const res = response(); await api(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["cache-control"], "private, no-store");
  }
  assert.equal(guarded, 0); assert.equal(writes, 0);
});

test("admin review carries the exact version and retry IDs and returns safe updated order data", async () => {
  const calls = [];
  const api = handler("admin/orders", { reviewOrderAddition: async input => {
    calls.push(input); return { addition: addition("approved"), order: order("diproses") };
  } });
  const res = response(); await api(adminRequest(review({ additionId: UUID.toUpperCase(), requestId: REVIEW_UUID.toUpperCase() })), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{ id: ID, additionId: UUID, decision: "approve", requestId: REVIEW_UUID,
    expectedStatus: "diproses", expectedUpdatedAt: VERSION }]);
  assert.equal(res.body.addition.status, "approved");
  assertPublic(res.body);
  assert.equal(res.headers["cache-control"], "private, no-store");
});

test("admin review requires complete valid CAS observations and supported action, decision and UUIDs", async () => {
  const cases = [{ action: "add-items" }, { action: undefined }, { decision: "maybe" }, { decision: null },
    { requestId: undefined }, { requestId: null }, { additionId: "not-a-uuid" }, { id: "../invalid" },
    { expectedStatus: undefined }, { expectedUpdatedAt: undefined }, { expectedStatus: "unknown" },
    { expectedStatus: undefined, expectedUpdatedAt: undefined },
    { expectedUpdatedAt: "2026-02-30T00:00:00Z" }, { expectedUpdatedAt: "2026-10-16T24:00:00Z" }];
  let writes = 0;
  for (const invalid of cases) {
    const api = handler("admin/orders", { reviewOrderAddition: async () => { writes++; } });
    const res = response(); await api(adminRequest(review(invalid)), res);
    assert.equal(res.statusCode, 400, JSON.stringify(invalid));
    assert.equal(res.body.order, undefined);
  }
  assert.equal(writes, 0);
});

test("admin rejection and exact retry preserve the review mutation identity", async () => {
  const calls = [];
  const api = handler("admin/orders", { reviewOrderAddition: async input => {
    calls.push(input); return { addition: addition("rejected"), order: order("diproses") };
  } });
  const first = response(); const replay = response();
  await api(adminRequest(review({ decision: "reject" })), first);
  await api(adminRequest(review({ decision: "reject" })), replay);
  assert.equal(first.statusCode, 200); assert.equal(replay.statusCode, 200);
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].decision, "reject");
  assert.equal(replay.body.addition.status, "rejected");
});

test("admin review rejects cross-site, invalid JSON and oversized authenticated requests before writes", async () => {
  let writes = 0;
  for (const [headers, expected] of [[{ origin: "https://attacker.example" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403], [{ "content-type": "text/plain" }, 415],
    [{ "content-length": "16385" }, 413]]) {
    const api = handler("admin/orders", { reviewOrderAddition: async () => { writes++; } });
    const req = adminRequest(); req.headers = { ...req.headers, ...headers };
    const res = response(); await api(req, res); assert.equal(res.statusCode, expected);
  }
  assert.equal(writes, 0);
});

test("admin review reports conflicts and missing records without leaking private snapshots or successful links", async () => {
  for (const code of Object.keys(ADDITION_CONFLICTS)) {
    const api = handler("admin/orders", { reviewOrderAddition: async () => { throw Object.assign(new Error("PRIVATE_DATABASE"), { code }); } });
    const res = response(); await api(adminRequest(), res);
    assert.equal(res.statusCode, 409, code); assert.equal(res.body.code, code);
    assert.equal(res.body.order, undefined); assert.equal(res.body.trackingUrl, undefined);
    assertPublic(res.body);
  }
  for (const missing of [null, "ADDITION_NOT_FOUND"]) {
    const api = handler("admin/orders", { reviewOrderAddition: async () => {
      if (missing) throw Object.assign(new Error(missing), { code: missing }); return null;
    } });
    const res = response(); await api(adminRequest(), res);
    assert.equal(res.statusCode, 404); assert.equal(res.body.order, undefined);
  }
});

test("admin review database outages are retryable and keep private connection failures out of the response", async () => {
  const original = console.error; console.error = () => {};
  try {
    for (const code of ["DATABASE_NOT_CONFIGURED", "PRIVATE_DATABASE_CREDENTIAL"]) {
      const api = handler("admin/orders", { reviewOrderAddition: async () => { throw Object.assign(new Error(code), { code }); } });
      const res = response(); await api(adminRequest(), res);
      assert.equal(res.statusCode, 503); assertPublic(res.body);
    }
  } finally { console.error = original; }
});
