const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createRequestGuard } = require("../api/_lib/security");

const originalFetch = global.fetch;
const originalKey = process.env.GEMINI_API_KEY;
const originalVercel = process.env.VERCEL;
test.afterEach(() => {
  global.fetch = originalFetch;
  for (const [name, value] of [["GEMINI_API_KEY", originalKey], ["VERCEL", originalVercel]]) {
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

function request(body, headers = {}) {
  return {
    method: "POST", socket: { remoteAddress: "127.0.0.1" }, body,
    headers: { host: "shop.example.test", "content-type": "application/json", ...headers }
  };
}

function loadHandler(name, { saveOrder = async () => true, guard = createRequestGuard({ getSql: () => null, environment: {} }) } = {}) {
  const target = require.resolve(`../api/${name}`);
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function (path, parent, isMain) {
    if (parent?.filename === target && path === "./_lib/security") return { guardRequest: guard };
    if (parent?.filename === target && path === "./_lib/db") return { saveOrder };
    return originalLoad.call(this, path, parent, isMain);
  };
  try { return require(target); }
  finally { Module._load = originalLoad; }
}

function checkout() {
  return {
    items: [{ id: "chicken-pop-corn-250gr", quantity: 2, price: 1 }],
    customer: { name: "Test customer", phone: "081234567890", address: "Test address", notes: "Test note", paymentMethod: "OVO" }
  };
}

test("checkout recalculates prices and preserves the existing tracking/WhatsApp link formats", async () => {
  let saved;
  const handler = loadHandler("order", { saveOrder: async order => { saved = order; return true; } });
  const res = response();
  await handler(request(checkout()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order.total, 74000);
  assert.equal(saved.total, 74000);
  assert.match(saved.trackingToken, /^[a-f0-9]{48}$/);
  const tracking = new URL(res.body.trackingUrl);
  assert.equal(tracking.origin, "https://shop.example.test");
  assert.equal(tracking.pathname, "/track/");
  assert.equal(tracking.searchParams.get("id"), saved.id);
  assert.equal(tracking.searchParams.get("token"), saved.trackingToken);
  assert.deepEqual([...tracking.searchParams.keys()], ["id", "token"]);
  const whatsapp = new URL(res.body.whatsappUrl);
  assert.equal(whatsapp.origin, "https://api.whatsapp.com");
  assert.equal(whatsapp.pathname, "/send");
  assert.match(whatsapp.searchParams.get("text"), /TOTAL PESANAN: Rp 74\.000/);
});

test("checkout cannot write orders from foreign origins, oversized bodies, or exhausted limits", async () => {
  let writes = 0;
  const handler = loadHandler("order", { saveOrder: async () => { writes++; return true; } });
  const crossSite = response();
  await handler(request(checkout(), { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }), crossSite);
  assert.equal(crossSite.statusCode, 403);
  const oversized = response();
  await handler(request(checkout(), { "content-length": "20000" }), oversized);
  assert.equal(oversized.statusCode, 413);
  for (let index = 0; index < 10; index++) {
    const res = response();
    await handler(request(checkout()), res);
    assert.equal(res.statusCode, 200);
  }
  const limited = response();
  await handler(request(checkout()), limited);
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(writes, 10);
});

test("invalid checkout and unavailable persistence do not generate successful order links", async () => {
  let writes = 0;
  const handler = loadHandler("order", { saveOrder: async () => { writes++; return false; } });
  const invalid = response();
  await handler(request({ ...checkout(), items: [{ id: "not-a-product", quantity: 1 }] }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(writes, 0);
  const unavailable = response();
  await handler(request(checkout()), unavailable);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.trackingUrl, undefined);
  assert.equal(unavailable.body.whatsappUrl, undefined);
  assert.equal(writes, 1);
});

test("insufficient checkout stock returns a recoverable conflict without successful order links", async () => {
  const handler = loadHandler("order", { saveOrder: async () => {
    const error = new Error("INSUFFICIENT_STOCK");
    error.code = "INSUFFICIENT_STOCK";
    throw error;
  } });
  const res = response();
  await handler(request(checkout()), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "INSUFFICIENT_STOCK");
  assert.equal(res.body.order, undefined);
  assert.equal(res.body.trackingUrl, undefined);
  assert.equal(res.body.whatsappUrl, undefined);
});

test("production checkout fails closed when the shared limiter is unavailable", async () => {
  let writes = 0;
  const guard = createRequestGuard({ getSql: () => null, environment: { NODE_ENV: "production", VERCEL: "1" } });
  const handler = loadHandler("order", { guard, saveOrder: async () => { writes++; return true; } });
  const res = response();
  await handler(request(checkout(), { "x-real-ip": "203.0.113.10", origin: "https://shop.example.test" }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(writes, 0);
});

test("Vercel tracking links enforce HTTPS while keeping their host/path/query unchanged", async () => {
  process.env.VERCEL = "1";
  const handler = loadHandler("order");
  const res = response();
  await handler(request(checkout(), { "x-forwarded-proto": "javascript" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(new URL(res.body.trackingUrl).origin, "https://shop.example.test");
});

test("chat limits requests before making upstream calls and preserves the API response contract", async () => {
  process.env.GEMINI_API_KEY = "test-only-key-not-a-production-credential";
  let requests = 0;
  global.fetch = async (url, options) => {
    requests++;
    assert.equal(new URL(url).hostname, "generativelanguage.googleapis.com");
    assert.equal(options.method, "POST");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "Menu tersedia." }] } }] }) };
  };
  const handler = loadHandler("chat");
  for (let index = 0; index < 15; index++) {
    const res = response();
    await handler(request({ message: "Menu?" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.reply, "Menu tersedia.");
  }
  const limited = response();
  await handler(request({ message: "Menu?" }), limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(typeof limited.body.reply, "string");
  assert.equal(requests, 15);
});

test("chat rejects cross-origin/empty messages and preserves its missing-key fallback", async () => {
  delete process.env.GEMINI_API_KEY;
  global.fetch = async () => { throw new Error("Unexpected external request"); };
  const handler = loadHandler("chat");
  const crossSite = response();
  await handler(request({ message: "Menu?" }, { origin: "https://attacker.example" }), crossSite);
  assert.equal(crossSite.statusCode, 403);
  const empty = response();
  await handler(request({ message: "" }), empty);
  assert.equal(empty.statusCode, 400);
  const missingKey = response();
  await handler(request({ message: "Menu?" }), missingKey);
  assert.equal(missingKey.statusCode, 503);
  assert.match(missingKey.body.reply, /Chatbot belum diaktifkan/);
});
