const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const auth = require("../api/_lib/auth");

// In-process fixtures only; these values never configure a deployment.
const fixture = {
  ADMIN_EMAIL: "admin@example.test",
  ADMIN_PASSWORD: "test-only-password",
  ADMIN_SESSION_SECRET: "test-only-session-secret-at-least-32-characters"
};
const originalEnv = Object.fromEntries(Object.keys(fixture).map(key => [key, process.env[key]]));

test.beforeEach(() => Object.assign(process.env, fixture));
test.afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function sessionRequest(token) {
  return { headers: { cookie: `dp_admin_session=${encodeURIComponent(token)}` } };
}

function signedPayload(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const signature = crypto.createHmac("sha256", fixture.ADMIN_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function loadHandler(name, guard = async () => true, updateOrderStatus = async () => null) {
  const target = require.resolve(`../api/admin/${name}`);
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "../_lib/security" && parent?.filename === target) return { guardRequest: guard };
    if (request === "../_lib/db" && parent?.filename === target) return { updateOrderStatus };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(target); }
  finally { Module._load = originalLoad; }
}

test("configured credentials normalize email and reject invalid password types", () => {
  assert.equal(auth.isAuthConfigured(), true);
  assert.equal(auth.validCredentials(" ADMIN@EXAMPLE.TEST ", fixture.ADMIN_PASSWORD), true);
  assert.equal(auth.validCredentials(fixture.ADMIN_EMAIL, "incorrect-password"), false);
  assert.equal(auth.validCredentials("other@example.test", fixture.ADMIN_PASSWORD), false);
  assert.equal(auth.validCredentials(fixture.ADMIN_EMAIL, { toString: () => fixture.ADMIN_PASSWORD }), false);
});

test("missing or weak admin configuration fails closed for credentials, signing, and verification", () => {
  const token = auth.createSession(fixture.ADMIN_EMAIL);
  const cases = [
    ["ADMIN_EMAIL", ""], ["ADMIN_EMAIL", "invalid-account"],
    ["ADMIN_PASSWORD", ""], ["ADMIN_PASSWORD", "short"],
    ["ADMIN_SESSION_SECRET", ""], ["ADMIN_SESSION_SECRET", "short"]
  ];
  for (const [name, value] of cases) {
    Object.assign(process.env, fixture, { [name]: value });
    assert.equal(auth.isAuthConfigured(), false, name);
    assert.equal(auth.validCredentials(fixture.ADMIN_EMAIL, fixture.ADMIN_PASSWORD), false, name);
    assert.throws(() => auth.createSession(fixture.ADMIN_EMAIL), /ADMIN_AUTH_NOT_CONFIGURED/);
    assert.equal(auth.verifySession(sessionRequest(token)), null, name);
  }
});

test("session uses configured identity, eight-hour expiration, and existing secure cookie", () => {
  const before = Date.now();
  const token = auth.createSession(" ADMIN@EXAMPLE.TEST ");
  const data = auth.verifySession(sessionRequest(token));
  assert.equal(data.email, fixture.ADMIN_EMAIL);
  assert.ok(data.exp >= before + 8 * 60 * 60 * 1000);
  assert.ok(data.exp <= Date.now() + 8 * 60 * 60 * 1000);
  assert.throws(() => auth.createSession("other@example.test"), /ADMIN_IDENTITY_MISMATCH/);
  assert.match(auth.sessionCookie(token), /^dp_admin_session=/);
  assert.match(auth.sessionCookie(token), /; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$/);
  assert.match(auth.clearSessionCookie(), /^dp_admin_session=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0$/);
});

test("session rejects tampering, extra segments, noncanonical base64url, and malformed cookies", () => {
  const token = auth.createSession(fixture.ADMIN_EMAIL);
  const [payload, signature] = token.split(".");
  const invalidTokens = [
    `${token}.extra`, `${payload}=.${signature}`, `${payload}+x.${signature}`,
    `${payload}.${signature.slice(0, -1)}`, `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`
  ];
  for (const value of invalidTokens) assert.equal(auth.verifySession(sessionRequest(value)), null);
  for (const cookie of [
    `dp_admin_session=${token}; dp_admin_session=${token}`,
    `dp_admin_session=${token}; malformed`,
    "dp_admin_session=%E0%A4%A", "dp_admin_session=%00", "dp_admin_session =value"
  ]) assert.equal(auth.verifySession({ headers: { cookie } }), null);
  assert.equal(auth.verifySession({ headers: { cookie: [token] } }), null);
  assert.equal(auth.verifySession({ headers: { cookie: "x".repeat(16385) } }), null);
  assert.equal(auth.verifySession({ headers: {} }), null);
});

test("signed sessions reject expired, non-number, fractional, and unsafe expirations", () => {
  for (const exp of [Date.now() - 1, 0, -1, String(Date.now() + 100000), null, true, Infinity, Date.now() + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const token = signedPayload({ email: fixture.ADMIN_EMAIL, exp });
    assert.equal(auth.verifySession(sessionRequest(token)), null);
  }
  assert.equal(auth.verifySession(sessionRequest(signedPayload({ email: 1, exp: Date.now() + 100000 }))), null);
  assert.equal(auth.verifySession(sessionRequest(signedPayload([fixture.ADMIN_EMAIL, Date.now() + 100000]))), null);
});

test("rotating the configured admin identity or signing secret invalidates prior sessions", () => {
  const token = auth.createSession(fixture.ADMIN_EMAIL);
  process.env.ADMIN_EMAIL = "replacement@example.test";
  assert.equal(auth.verifySession(sessionRequest(token)), null);
  process.env.ADMIN_EMAIL = fixture.ADMIN_EMAIL;
  process.env.ADMIN_SESSION_SECRET = "different-test-only-session-secret-32-characters";
  assert.equal(auth.verifySession(sessionRequest(token)), null);
});

test("login returns 503 for missing configuration, 401 for bad credentials, 200 with secure cookie", async () => {
  const login = loadHandler("login");
  const req = { method: "POST", body: { email: fixture.ADMIN_EMAIL, password: fixture.ADMIN_PASSWORD }, headers: {} };
  process.env.ADMIN_SESSION_SECRET = "";
  const missing = response();
  await login(req, missing);
  assert.equal(missing.statusCode, 503);
  Object.assign(process.env, fixture);
  const invalid = response();
  await login({ ...req, body: { ...req.body, password: "incorrect-password" } }, invalid);
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.headers["set-cookie"], undefined);
  const valid = response();
  await login(req, valid);
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.headers["cache-control"], "no-store");
  assert.match(valid.headers["set-cookie"], /HttpOnly; Secure; SameSite=Strict/);
  const cookie = valid.headers["set-cookie"].split(";")[0];
  assert.equal(auth.verifySession({ headers: { cookie } }).email, fixture.ADMIN_EMAIL);
});

test("admin mutations honor guard rejection without setting cookies or changing orders", async () => {
  let updates = 0;
  for (const name of ["login", "logout", "status"]) {
    const handler = loadHandler(name, async (req, res, options) => {
      assert.deepEqual(options.methods, name === "status" ? ["PATCH", "POST"] : ["POST"]);
      assert.equal(options.scope, name === "login" ? "login" : "admin");
      if (name === "logout") assert.equal(options.allowEmptyBody, true);
      res.status(403).json({ error: "test guard rejected" });
      return false;
    }, async () => { updates++; return { id: "test-order" }; });
    const res = response();
    await handler({ method: "POST", headers: {}, body: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers["set-cookie"], undefined);
  }
  assert.equal(updates, 0);
});

test("status requires a valid session and logout keeps the cookie name", async () => {
  let updates = 0;
  const status = loadHandler("status", async () => true, async (id, next) => {
    updates++;
    return { id, status: next };
  });
  const req = { method: "PATCH", headers: {}, body: { id: "test-order", status: "diproses" } };
  const denied = response();
  await status(req, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(updates, 0);
  const accepted = response();
  await status({ ...req, ...sessionRequest(auth.createSession(fixture.ADMIN_EMAIL)) }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(updates, 1);
  assert.deepEqual(accepted.body, { order: { id: "test-order", status: "diproses" } });
  const logout = loadHandler("logout");
  const cleared = response();
  await logout({ method: "POST", headers: {} }, cleared);
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.headers["set-cookie"], auth.clearSessionCookie());
});
