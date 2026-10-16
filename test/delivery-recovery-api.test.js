const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createRequestGuard } = require("../api/_lib/security");
const { PRODUCTS } = require("../api/_lib/catalog");
const { publicOrder, additionWhatsAppUrl } = require("../api/_lib/order-additions");

const UUID = "72aa51a8-523e-4c97-a158-df8530e34747";
const CHALLENGE = "b".repeat(48);
const TOKEN = "a".repeat(48);
const VERSION = "2026-10-16T01:02:03.123456Z";
const customer = { name: "Local customer", phone: "081234567890", address: "Local private address", notes: "Private note", paymentMethod: "Transfer Bank" };
const item = { ...PRODUCTS[0], quantity: 1, subtotal: PRODUCTS[0].price };
const order = (extra = {}) => ({ id: "DP-DELIVERY-TEST", status: "baru", items: [item], total: item.price,
  delivery_method: "delivery", shipping_fee: null, payment_method: "Transfer Bank", customer_name: "PRIVATE_NAME",
  customer_phone: "PRIVATE_PHONE", address: "PRIVATE_ADDRESS", notes: "PRIVATE_NOTES", tracking_token: TOKEN,
  queue_number: 9, queue_date: "2026-10-16", updated_at: VERSION, created_at: VERSION, ...extra });
const checkout = (extra = {}) => ({ requestId: UUID, expectedTotal: item.price,
  customer: { ...customer }, items: [{ id: item.id, quantity: 1 }], ...extra });
const shipping = (extra = {}) => ({ action: "set-shipping", id: "DP-DELIVERY-TEST", shippingFee: 12000,
  requestId: UUID, expectedStatus: "baru", expectedUpdatedAt: VERSION, ...extra });
function request(body, overrides = {}) {
  return { method: "POST", body, query: {}, socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "shop.example.test", origin: "http://shop.example.test", "content-type": "application/json" }, ...overrides };
}
function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function handler(name, { database = {}, recovery = {}, session = true, guard } = {}) {
  const target = require.resolve(`../api/${name}`);
  delete require.cache[target];
  const fixtureGuard = guard || createRequestGuard({ getSql: () => null, environment: {} });
  const original = Module._load;
  Module._load = function (path, parent, isMain) {
    if (parent?.filename === target && path.endsWith("/_lib/db")) return database;
    if (parent?.filename === target && path.endsWith("/_lib/customer-recovery-db")) return recovery;
    if (parent?.filename === target && path.endsWith("/_lib/auth")) return { verifySession: () => session };
    if (parent?.filename === target && path.endsWith("/_lib/security")) return { guardRequest: fixtureGuard };
    return original.call(this, path, parent, isMain);
  };
  try { return require(target); } finally { Module._load = original; }
}

test("legacy checkout remains delivery and cannot inject a shipping charge", async () => {
  const calls = [];
  const api = handler("order", { database: { saveOrder: async value => { calls.push(value); return true; } } });
  const res = response();
  await api(request(checkout({ shippingFee: 1, grandTotal: 1, customer: { ...customer, shippingFee: 1 } })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].deliveryMethod, "delivery");
  assert.equal(calls[0].customer.deliveryMethod, "delivery");
  assert.equal(calls[0].shippingFee, undefined);
  assert.equal(res.body.order.shippingFee, null);
  assert.equal(res.body.order.grandTotal, null);
  assert.equal(res.body.order.itemsSubtotal, item.price);
  const text = new URL(res.body.whatsappUrl).searchParams.get("text");
  assert.match(text, /Penerimaan: Diantar/);
  assert.match(text, /Ongkir: menunggu konfirmasi admin/);
  assert.match(text, /belum termasuk ongkir/);
});

test("pickup checkout needs no address and confirms a zero shipping fee", async () => {
  let saved;
  const api = handler("order", { database: { saveOrder: async value => { saved = value; return true; } } });
  const res = response(); await api(request(checkout({ customer: { ...customer, deliveryMethod: "pickup", address: undefined } })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(saved.customer.address, "");
  assert.equal(saved.deliveryMethod, "pickup");
  assert.equal(res.body.order.shippingFee, 0);
  assert.equal(res.body.order.shippingConfirmed, true);
  assert.equal(res.body.order.grandTotal, item.price);
  const text = new URL(res.body.whatsappUrl).searchParams.get("text");
  assert.match(text, /Penerimaan: Ambil sendiri/);
  assert.match(text, /waktu pengambilan/);
  assert.doesNotMatch(text, /Alamat:|belum termasuk ongkir/);
});

test("delivery requires an address and rejects unknown or non-string fulfillment modes before saving", async () => {
  let calls = 0;
  const api = handler("order", { database: { saveOrder: async () => { calls++; return true; } } });
  for (const extra of [{ address: "" }, { deliveryMethod: null }, { deliveryMethod: "PICKUP" },
    { deliveryMethod: "courier" }, { deliveryMethod: {} }, { deliveryMethod: false }]) {
    const res = response(); await api(request(checkout({ customer: { ...customer, ...extra } })), res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test("public tracking whitelists fulfillment amounts without disclosing customer information", async () => {
  const api = handler("track", { database: { getPublicOrderStatus: async () => order({ total: item.price + 12000, shipping_fee: "12000" }) } });
  const res = response(); await api(request(undefined, { method: "GET", query: { id: "DP-DELIVERY-TEST", token: TOKEN } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.shippingFee, 12000);
  assert.equal(res.body.order.itemsSubtotal, item.price);
  assert.equal(res.body.order.grandTotal, item.price + 12000);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|customer|address|notes|tracking_token|trackingToken/);
});

test("addition WhatsApp totals preserve a confirmed shipping fee exactly once", () => {
  const source = publicOrder(order({ total: item.price + 12000, shipping_fee: 12000 }));
  const text = new URL(additionWhatsAppUrl(source, { id: UUID, status: "approved", items: [item], total: item.price }, "https://shop.example.test/track/")).searchParams.get("text");
  assert.match(text, new RegExp(`Subtotal menu saat ini: Rp ${item.price.toLocaleString("id-ID").replaceAll(".", "\\.")}`));
  assert.match(text, /Ongkir: Rp 12\.000/);
  assert.match(text, /TOTAL PESANAN TERBARU: Rp 49\.000/);
});

test("admin shipping carries exact concurrency observations and returns safe updated totals", async () => {
  const calls = [];
  const api = handler("admin/orders", { database: { updateOrderShipping: async value => {
    calls.push(value); return order({ total: item.price + value.shippingFee, shipping_fee: value.shippingFee });
  } } });
  const res = response(); await api(request(shipping()), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{ id: "DP-DELIVERY-TEST", shippingFee: 12000, requestId: UUID,
    expectedStatus: "baru", expectedUpdatedAt: VERSION }]);
  assert.equal(res.body.order.total, item.price + 12000);
  assert.equal(res.body.order.itemsSubtotal, item.price);
  assert.equal(res.body.order.shippingConfirmed, true);
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_|customer|address|notes|tracking_token/);
});

test("shipping rejects malformed fees, missing UUIDs and incomplete versions without writes", async () => {
  let calls = 0;
  const api = handler("admin/orders", { guard: createRequestGuard({ getSql: () => null, environment: {} }),
    database: { updateOrderShipping: async () => { calls++; } } });
  const samples = [-1, 1.5, "12000", null, true, 100000001].map(shippingFee => ({ shippingFee }));
  samples.push({ requestId: undefined }, { requestId: "not-a-uuid" },
    { expectedUpdatedAt: undefined }, { expectedStatus: "unknown" });
  // Separate guards keep this test about data validation rather than admin rate limiting.
  for (const extra of samples) {
    const res = response(); await api(request(shipping(extra)), res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test("admin shipping reports conflicts without successful snapshots", async () => {
  for (const code of ["SHIPPING_NOT_ALLOWED", "ORDER_CONFLICT", "REQUEST_CONFLICT"]) {
    const api = handler("admin/orders", { database: { updateOrderShipping: async () => { throw Object.assign(new Error(code), { code }); } } });
    const res = response(); await api(request(shipping()), res);
    assert.equal(res.statusCode, 409); assert.equal(res.body.code, code); assert.equal(res.body.order, undefined);
  }
});

test("every admin recovery and shipping action authenticates before guards or persistence", async () => {
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error("unexpected"); };
  const api = handler("admin/orders", { session: false, guard: unexpected,
    database: { updateOrderShipping: unexpected }, recovery: { listRecoveryRequests: unexpected, issueRecoveryCode: unexpected } });
  for (const req of [request(shipping()), request({ action: "send-recovery-code", challengeId: CHALLENGE, requestId: UUID }),
    request(undefined, { method: "GET", query: { view: "recovery-requests" } })]) {
    const res = response(); await api(req, res); assert.equal(res.statusCode, 401);
  }
  assert.equal(calls, 0);
});

test("public recovery normalizes the account, whitelists fields and never echoes phone or tokens", async () => {
  const calls = [];
  const accepted = { challengeId: CHALLENGE, expiresAt: "2026-10-16T01:12:03Z", status: "awaiting-admin" };
  const api = handler("track", { recovery: { requestRecovery: async value => { calls.push(value); return accepted; } } });
  const res = response(); await api(request({ action: "request-recovery", phone: "0812 3456 7890", requestId: UUID, id: "INJECTED", token: TOKEN }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, accepted);
  assert.deepEqual(calls, [{ phone: "6281234567890", requestId: UUID }]);
  assert.doesNotMatch(JSON.stringify(res.body), /628123|0812|tracking|PRIVATE|orders/);
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});

test("public recovery rejects cross-origin, non-JSON and oversized mutations before any database access", async () => {
  let calls = 0;
  const api = handler("track", { recovery: { requestRecovery: async () => { calls++; } } });
  for (const [headers, status] of [[{ host: "shop.example.test", origin: "https://attacker.test", "content-type": "application/json" }, 403],
    [{ host: "shop.example.test", "content-type": "text/plain" }, 415],
    [{ host: "shop.example.test", "content-type": "application/json", "content-length": "20000" }, 413]]) {
    const res = response(); await api(request({ action: "request-recovery", phone: customer.phone, requestId: UUID }, { headers }), res);
    assert.equal(res.statusCode, status);
  }
  assert.equal(calls, 0);
});

test("public recovery malformed actions, phones, challenges and codes never reach challenge persistence", async () => {
  let calls = 0;
  const api = handler("track", { recovery: { requestRecovery: async () => { calls++; }, verifyRecoveryCode: async () => { calls++; } } });
  for (const body of [{ action: "request-recovery", phone: "123", requestId: UUID },
    { action: "request-recovery", phone: customer.phone, requestId: undefined },
    { action: "verify-recovery", challengeId: UUID, code: "123456", requestId: UUID },
    { action: "verify-recovery", challengeId: CHALLENGE, code: 123456, requestId: UUID },
    { action: "verify-recovery", challengeId: CHALLENGE, code: "12345", requestId: UUID }, { action: "save-order" }]) {
    const res = response(); await api(request(body), res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test("public recovery cannot bypass durable IP limits using new phones or request UUIDs", async () => {
  let calls = 0;
  const api = handler("track", { recovery: { requestRecovery: async () => { calls++; return { status: "awaiting-admin" }; } } });
  for (let index = 0; index < 7; index++) {
    const res = response(); await api(request({ action: "request-recovery", phone: `0812345678${index}`, requestId: UUID }), res);
    assert.equal(res.statusCode, index < 6 ? 200 : 429);
  }
  assert.equal(calls, 6);
});

test("verification forwards a 48-hex challenge and stable UUID; consumed challenges disclose no orders", async () => {
  const calls = [];
  const api = handler("track", { recovery: { verifyRecoveryCode: async value => { calls.push(value); return { status: "invalid", remainingAttempts: 4 }; } } });
  const res = response(); await api(request({ action: "verify-recovery", challengeId: CHALLENGE.toUpperCase(), requestId: UUID, code: "123456", phone: customer.phone }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { status: "invalid", remainingAttempts: 4 });
  assert.deepEqual(calls, [{ challengeId: CHALLENGE, requestId: UUID, code: "123456" }]);
  const consumed = handler("track", { recovery: { verifyRecoveryCode: async () => { throw Object.assign(new Error("RECOVERY_CONSUMED"), { code: "RECOVERY_CONSUMED" }); } } });
  const expired = response(); await consumed(request({ action: "verify-recovery", challengeId: CHALLENGE, requestId: UUID, code: "123456" }), expired);
  assert.equal(expired.statusCode, 200); assert.deepEqual(expired.body, { status: "expired" });
});

test("admin lists verification requests and issues only server-pinned WhatsApp links", async () => {
  const calls = [];
  const records = [{ challengeId: CHALLENGE, maskedPhone: "62812••7890", status: "awaiting-admin", orderCount: 1 }];
  const sent = { challengeId: CHALLENGE, expiresAt: VERSION, status: "issued", whatsappUrl: "https://api.whatsapp.com/send?phone=6281234567890&text=Kode" };
  const api = handler("admin/orders", { recovery: { listRecoveryRequests: async () => records,
    issueRecoveryCode: async value => { calls.push(value); return sent; } } });
  const list = response(); await api(request(undefined, { method: "GET", query: { view: "recovery-requests" } }), list);
  assert.equal(list.statusCode, 200); assert.deepEqual(list.body, { requests: records });
  const res = response(); await api(request({ action: "send-recovery-code", challengeId: CHALLENGE, requestId: UUID, phone: "629999999999", code: "111111" }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, sent);
  assert.deepEqual(calls, [{ challengeId: CHALLENGE, requestId: UUID }]);
});

test("unknown admin actions cannot fall through to shipping, review, or OTP generation", async () => {
  let calls = 0;
  const unexpected = async () => { calls++; };
  const api = handler("admin/orders", { database: { reviewOrderAddition: unexpected, updateOrderShipping: unexpected }, recovery: { issueRecoveryCode: unexpected } });
  for (const action of ["", null, "shipping", "request-recovery", "verify-recovery", "send-code"]) {
    const res = response(); await api(request({ ...shipping(), action }), res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test("a confirmed free delivery remains different from an unconfirmed shipping fee", async () => {
  const api = handler("admin/orders", { database: { updateOrderShipping: async value => {
    assert.equal(value.shippingFee, 0);
    return order({ shipping_fee: 0 });
  } } });
  const res = response(); await api(request(shipping({ shippingFee: 0 })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.shippingFee, 0);
  assert.equal(res.body.order.shippingConfirmed, true);
  assert.equal(res.body.order.grandTotal, item.price);
  assert.equal(publicOrder(order()).grandTotal, null);
});

test("checkout retries return the persisted fulfillment snapshot and never add shipping twice", async () => {
  const api = handler("order", { database: { saveOrder: async value => {
    Object.assign(value, { id: "DP-PERSISTED", total: item.price + 12000, deliveryMethod: "delivery", shippingFee: 12000,
      queueNumber: 9, queueDate: "2026-10-16", queueLabel: "A009" });
    return true;
  } } });
  const res = response(); await api(request(checkout()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.id, "DP-PERSISTED");
  assert.equal(res.body.order.itemsSubtotal, item.price);
  assert.equal(res.body.order.grandTotal, item.price + 12000);
  const text = new URL(res.body.whatsappUrl).searchParams.get("text");
  assert.match(text, /Ongkir: Rp 12\.000/);
  assert.match(text, /TOTAL AKHIR: Rp 49\.000/);
  assert.doesNotMatch(text, /belum termasuk ongkir|menunggu konfirmasi admin/);
});

test("shipping errors preserve not-found, validation and unavailable semantics without leaking exceptions", async () => {
  for (const [result, status, expectedCode] of [[null, 404, undefined], ["INVALID_SHIPPING_FEE", 400, "INVALID_SHIPPING_FEE"],
    ["DATABASE_NOT_CONFIGURED", 503, undefined], ["postgres://PRIVATE_SECRET", 503, undefined]]) {
    const api = handler("admin/orders", { database: { updateOrderShipping: async () => {
      if (result === null) return null;
      throw Object.assign(new Error(result), { code: result });
    } } });
    const res = response(); await api(request(shipping()), res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.code, expectedCode);
    assert.equal(res.body.order, undefined);
    assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_SECRET|postgres:|DATABASE_NOT_CONFIGURED/);
  }
});

test("admin mutations reject cross-origin and non-JSON requests before shipping or recovery writes", async () => {
  let calls = 0;
  const unexpected = async () => { calls++; };
  const api = handler("admin/orders", { database: { updateOrderShipping: unexpected }, recovery: { issueRecoveryCode: unexpected } });
  for (const body of [shipping(), { action: "send-recovery-code", challengeId: CHALLENGE, requestId: UUID }]) {
    for (const [headers, status] of [[{ host: "shop.example.test", origin: "https://attacker.test", "content-type": "application/json" }, 403],
      [{ host: "shop.example.test", "content-type": "text/plain" }, 415]]) {
      const res = response(); await api(request(body, { headers }), res); assert.equal(res.statusCode, status);
    }
  }
  assert.equal(calls, 0);
});

test("recovery can parse a JSON request body but malformed and array bodies never reach persistence", async () => {
  let calls = 0;
  const api = handler("track", { recovery: { requestRecovery: async () => {
    calls++; return { challengeId: CHALLENGE, status: "awaiting-admin" };
  } } });
  const valid = response(); await api(request(JSON.stringify({ action: "request-recovery", phone: customer.phone, requestId: UUID })), valid);
  assert.equal(valid.statusCode, 200);
  for (const body of ["{invalid", "[]", "null", ["request-recovery"]]) {
    const res = response(); await api(request(body), res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 1);
});

test("public recovery replies are identical for known and unknown phone numbers before verification", async () => {
  const api = handler("track", { recovery: { requestRecovery: async () => ({
    challengeId: CHALLENGE, expiresAt: VERSION, status: "awaiting-admin"
  }) } });
  const known = response(); const unknown = response();
  await api(request({ action: "request-recovery", phone: customer.phone, requestId: UUID }), known);
  await api(request({ action: "request-recovery", phone: "089999999999", requestId: UUID }), unknown);
  assert.equal(known.statusCode, 200); assert.equal(unknown.statusCode, 200);
  assert.deepEqual(known.body, unknown.body);
  assert.doesNotMatch(JSON.stringify(known.body), /phone|orders|tracking|token|customer|address/);
});

test("verification accepts a verified safe order list only after forwarding the supplied code", async () => {
  const verified = { status: "verified", orders: [{ id: "DP-DELIVERY-TEST", status: "baru", total: item.price,
    queueNumber: 9, queueDate: "2026-10-16", createdAt: VERSION, updatedAt: VERSION,
    trackingUrl: `/track/?id=DP-DELIVERY-TEST&token=${TOKEN}` }] };
  const api = handler("track", { recovery: { verifyRecoveryCode: async value => {
    assert.deepEqual(value, { challengeId: CHALLENGE, requestId: UUID, code: "123456" });
    return verified;
  } } });
  const res = response(); await api(request({ action: "verify-recovery", challengeId: CHALLENGE, requestId: UUID, code: "123456" }), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body, verified);
  assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.doesNotMatch(JSON.stringify(res.body), /customer|address|notes|phone/);
});

test("verification account limits span changing client IPs and preserve challenge attempt budgets", async () => {
  let calls = 0;
  const api = handler("track", { recovery: { verifyRecoveryCode: async () => {
    calls++; return { status: "invalid", remainingAttempts: 1 };
  } } });
  for (let index = 0; index < 9; index++) {
    const res = response(); await api(request({ action: "verify-recovery", challengeId: CHALLENGE, requestId: UUID, code: "123456" },
      { socket: { remoteAddress: `127.0.0.${index + 1}` } }), res);
    assert.equal(res.statusCode, index < 8 ? 200 : 429);
  }
  assert.equal(calls, 8);
});

test("public recovery errors map to generic safe statuses and a bounded retry delay", async () => {
  for (const [code, status, result] of [["RECOVERY_RATE_LIMIT", 429, undefined], ["REQUEST_CONFLICT", 409, undefined],
    ["INVALID_PHONE", 400, undefined], ["RECOVERY_NOT_FOUND", 200, "expired"], ["RECOVERY_EXPIRED", 200, "expired"],
    ["RECOVERY_CONSUMED", 200, "expired"], ["DATABASE_NOT_CONFIGURED", 503, undefined], ["PRIVATE_DATABASE_SECRET", 503, undefined]]) {
    const api = handler("track", { recovery: { requestRecovery: async () => { throw Object.assign(new Error(code), { code }); } } });
    const res = response(); await api(request({ action: "request-recovery", phone: customer.phone, requestId: UUID }), res);
    assert.equal(res.statusCode, status); assert.equal(res.body.status, result);
    if (code === "RECOVERY_RATE_LIMIT") assert.equal(res.headers["retry-after"], "900");
    assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_DATABASE_SECRET|DATABASE_NOT_CONFIGURED|628123|tracking|orders/);
  }
});

test("admin code generation rejects malformed challenges and UUIDs without changing issued state", async () => {
  let calls = 0;
  const api = handler("admin/orders", { recovery: { issueRecoveryCode: async () => { calls++; } } });
  for (const extra of [{ challengeId: UUID }, { challengeId: undefined }, { challengeId: {} },
    { requestId: undefined }, { requestId: "bad-uuid" }]) {
    const res = response(); await api(request({ action: "send-recovery-code", challengeId: CHALLENGE, requestId: UUID, ...extra }), res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test("admin recovery errors never expose generated codes, stored phones or database diagnostics", async () => {
  for (const [code, status] of [["RECOVERY_NOT_FOUND", 404], ["RECOVERY_EXPIRED", 409], ["RECOVERY_CONSUMED", 409],
    ["REQUEST_CONFLICT", 409], ["RECOVERY_RATE_LIMIT", 429], ["PRIVATE_DATABASE_SECRET", 503]]) {
    const api = handler("admin/orders", { recovery: { issueRecoveryCode: async () => {
      throw Object.assign(new Error(code), { code });
    } } });
    const res = response(); await api(request({ action: "send-recovery-code", challengeId: CHALLENGE, requestId: UUID }), res);
    assert.equal(res.statusCode, status);
    assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_DATABASE_SECRET|whatsappUrl|phone|123456|628123/);
  }
});

test("admin recovery listing validates its view and handles an unavailable database privately", async () => {
  let calls = 0;
  const api = handler("admin/orders", { recovery: { listRecoveryRequests: async () => { calls++; throw new Error("PRIVATE_DATABASE_SECRET"); } } });
  const bad = response(); await api(request(undefined, { method: "GET", query: { view: "phones" } }), bad);
  assert.equal(bad.statusCode, 400); assert.equal(calls, 0);
  const res = response(); await api(request(undefined, { method: "GET", query: { view: "recovery-requests" } }), res);
  assert.equal(res.statusCode, 503); assert.equal(calls, 1);
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE_DATABASE_SECRET|phone|123456|628123/);
});

test("unsupported track and admin methods advertise the existing GET and new POST methods", async () => {
  for (const name of ["track", "admin/orders"]) {
    const api = handler(name);
    const res = response(); await api(request(undefined, { method: "DELETE" }), res);
    assert.equal(res.statusCode, 405); assert.equal(res.headers.allow, "GET, POST");
  }
});
