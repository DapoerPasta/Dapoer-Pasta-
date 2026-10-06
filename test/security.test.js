const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequestGuard } = require("../api/_lib/security");

function request(overrides = {}) {
  return {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", ...overrides.headers },
    socket: { remoteAddress: "127.0.0.1", ...overrides.socket },
    body: { message: "menu" },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["headers", "socket"].includes(key)))
  };
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function localGuard(overrides = {}) {
  return createRequestGuard({ getSql: () => null, environment: {}, ...overrides });
}

async function run(guard, req = request(), options = { scope: "order" }) {
  const res = response();
  const allowed = await guard(req, res, options);
  return { allowed, res };
}

// This shared fake performs each upsert atomically, like Postgres' row lock.
// Independent guard instances share its counters, simulating warm serverless
// functions rather than testing a single instance's in-memory state.
function sharedSql(clock = () => 0) {
  const buckets = new Map();
  const calls = [];
  const sql = async (parts, ...values) => {
    const text = parts.join("?");
    calls.push({ text, values });
    if (!text.includes("INSERT INTO security_rate_limits")) return [];
    assert.match(text, /ON CONFLICT \(scope, key_hash\) DO UPDATE/);
    assert.match(text, /requests = CASE WHEN security_rate_limits\.expires_at <= NOW\(\)/);
    assert.match(text, /expires_at = CASE WHEN security_rate_limits\.expires_at <= NOW\(\)/);
    assert.match(text, /NOW\(\) \+ \? \* INTERVAL '1 second'/);
    const [, , scope, hash, seconds] = values;
    assert.equal(scope, values[0]);
    assert.equal(hash, values[1]);
    assert.match(hash, /^[a-f0-9]{64}$/);
    const key = `${scope}:${hash}`;
    let bucket = buckets.get(key);
    const timestamp = clock();
    if (!bucket || bucket.expires <= timestamp) {
      bucket = { count: 0, expires: timestamp + seconds * 1000 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return [{ requests: String(bucket.count), retry_after: Math.ceil((bucket.expires - timestamp) / 1000) }];
  };
  return { sql, buckets, calls };
}

test("same-origin mutations and non-browser clients pass; sensitive responses stay private", async () => {
  const guard = localGuard();
  for (const headers of [{ origin: "http://localhost:3000" }, {}]) {
    const { allowed, res } = await run(guard, request({ headers }));
    assert.equal(allowed, true);
    assert.equal(res.headers["cache-control"], "private, no-store");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  }
});

test("cross-site, opaque, malformed and foreign origins are rejected before storage", async () => {
  const guard = localGuard({ getSql: () => { throw new Error("must not query"); } });
  for (const headers of [
    { "sec-fetch-site": "cross-site" },
    { origin: "null" },
    { origin: "https://attacker.example" },
    { origin: "http://localhost:3000/foreign" },
    { origin: "http://user@localhost:3000" },
    { origin: "invalid" },
    { origin: ["http://localhost:3000"] }
  ]) {
    const { allowed, res } = await run(guard, request({ headers }));
    assert.equal(allowed, false);
    assert.equal(res.statusCode, 403);
  }
});

test("unsupported methods include Allow and security headers", async () => {
  const { allowed, res } = await run(localGuard(), request({ method: "PUT" }), { scope: "order", methods: ["POST"] });
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "POST");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});

test("mutations require JSON and enforce both declared and decoded byte limits", async () => {
  const guard = localGuard();
  const cases = [
    [request({ headers: { "content-type": "text/plain" } }), 415],
    [request({ headers: { "content-length": "16385" } }), 413],
    [request({ headers: { "content-length": "-1" } }), 400],
    [request({ body: { text: "🍝".repeat(5000) } }), 413],
    [request({ body: "{" }), 400],
    [request({ body: "[]" }), 400],
    [request({ body: "null" }), 400]
  ];
  for (const [req, expected] of cases) {
    const { allowed, res } = await run(guard, req);
    assert.equal(allowed, false);
    assert.equal(res.statusCode, expected);
  }
  const req = request({ headers: { "content-type": "application/json; charset=utf-8" }, body: '{"message":"menu"}' });
  assert.equal((await run(guard, req)).allowed, true);
  assert.deepEqual(req.body, { message: "menu" });
});

test("bodyless logout is explicitly supported and retains origin checks", async () => {
  const guard = localGuard();
  const options = { scope: "logout", allowEmptyBody: true };
  const req = request({ body: undefined, headers: { "content-type": undefined } });
  assert.equal((await run(guard, req, options)).allowed, true);
  const crossSite = request({ body: undefined, headers: { "content-type": undefined, "sec-fetch-site": "cross-site" } });
  assert.equal((await run(guard, crossSite, options)).res.statusCode, 403);
  const plainText = request({ body: "", headers: { "content-type": "text/plain" } });
  assert.equal((await run(guard, plainText, options)).res.statusCode, 415);
});

test("local forwarding-header spoofing cannot escape socket-based limits", async () => {
  const guard = localGuard();
  const options = { scope: "order", limit: 1, windowSeconds: 60 };
  assert.equal((await run(guard, request({ headers: { "x-forwarded-for": "1.2.3.4" } }), options)).allowed, true);
  const limited = await run(guard, request({ headers: { "x-forwarded-for": "4.3.2.1", "x-real-ip": "8.8.8.8" } }), options);
  assert.equal(limited.res.statusCode, 429);
  assert.equal(limited.res.headers["retry-after"], "60");
  assert.equal(limited.res.body.error, limited.res.body.reply);
});

test("Vercel uses its documented x-real-ip, ignoring alternate forwarding headers", async () => {
  const { sql } = sharedSql();
  const guard = createRequestGuard({ getSql: () => sql, environment: { VERCEL: "1" } });
  const options = { scope: "order", limit: 1, windowSeconds: 60 };
  const headers = { host: "shop.vercel.app", origin: "https://shop.vercel.app", "x-real-ip": "192.0.2.1", "x-forwarded-for": "1.2.3.4" };
  assert.equal((await run(guard, request({ headers }), options)).allowed, true);
  const limited = await run(guard, request({ headers: { ...headers, "x-forwarded-for": "4.3.2.1", "x-vercel-forwarded-for": "8.8.8.8" } }), options);
  assert.equal(limited.res.statusCode, 429);
  for (const value of [undefined, "garbage", "192.0.2.1, 192.0.2.2"]) {
    const unavailable = await run(guard, request({ headers: { ...headers, "x-real-ip": value } }), options);
    assert.equal(unavailable.res.statusCode, 503);
  }
});

test("equivalent IPv6 socket addresses share one quota", async () => {
  const guard = localGuard();
  const options = { scope: "track", methods: ["GET"], limit: 1 };
  assert.equal((await run(guard, request({ method: "GET", socket: { remoteAddress: "2001:db8::1" } }), options)).allowed, true);
  assert.equal((await run(guard, request({ method: "GET", socket: { remoteAddress: "2001:0db8:0000:0000:0000:0000:0000:0001" } }), options)).res.statusCode, 429);
});

test("in-memory quotas expire at their boundary, without extending on denied requests", async () => {
  let timestamp = 1000;
  const guard = localGuard({ now: () => timestamp });
  const options = { scope: "order", limit: 1, windowSeconds: 10 };
  assert.equal((await run(guard, request(), options)).allowed, true);
  timestamp = 10_000;
  assert.equal((await run(guard, request(), options)).res.headers["retry-after"], "1");
  timestamp = 11_000;
  assert.equal((await run(guard, request(), options)).allowed, true);
});

test("bounded local map fails safely under capacity pressure and reuses expired entries", async () => {
  let timestamp = 0;
  const guard = localGuard({ now: () => timestamp, maxMemoryKeys: 1 });
  const options = { scope: "track", methods: ["GET"], limit: 1, windowSeconds: 1 };
  assert.equal((await run(guard, request({ method: "GET" }), options)).allowed, true);
  const second = request({ method: "GET", socket: { remoteAddress: "127.0.0.2" } });
  assert.equal((await run(guard, second, options)).res.statusCode, 503);
  timestamp = 1000;
  assert.equal((await run(guard, second, options)).allowed, true);
});

test("production and Vercel never fall back to process-local quotas without a database", async () => {
  for (const environment of [{ NODE_ENV: "production" }, { VERCEL: "1" }, { VERCEL: "true" }]) {
    const guard = localGuard({ environment });
    const result = await run(guard, request({ headers: { "x-real-ip": "192.0.2.1" } }));
    assert.equal(result.allowed, false);
    assert.equal(result.res.statusCode, 503);
  }
});

test("database failures fail closed instead of silently switching to memory", async () => {
  const guard = localGuard({ getSql: () => async () => { throw new Error("sensitive connection detail"); } });
  const { allowed, res } = await run(guard);
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.body), /sensitive/);
});

test("atomic database quota is shared across independent concurrent serverless guards", async () => {
  const database = sharedSql();
  const options = { scope: "order", limit: 7, windowSeconds: 60 };
  const guards = Array.from({ length: 4 }, () => createRequestGuard({ getSql: () => database.sql, environment: { NODE_ENV: "production" } }));
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => run(guards[i % guards.length], request(), options)));
  assert.equal(results.filter(result => result.allowed).length, 7);
  assert.equal(results.filter(result => result.res.statusCode === 429).length, 33);
  const boundValues = database.calls.flatMap(call => call.values);
  assert.equal(boundValues.includes("127.0.0.1"), false);
  assert.equal(database.buckets.size, 1);
});

test("database expiry resets counts at the same boundary across instances", async () => {
  let timestamp = 0;
  const { sql } = sharedSql(() => timestamp);
  const create = () => createRequestGuard({ getSql: () => sql, environment: { NODE_ENV: "production" } });
  const options = { scope: "receipt", methods: ["GET"], limit: 1, windowSeconds: 5 };
  const req = request({ method: "GET" });
  assert.equal((await run(create(), req, options)).allowed, true);
  timestamp = 4999;
  assert.equal((await run(create(), req, options)).res.statusCode, 429);
  timestamp = 5000;
  assert.equal((await run(create(), req, options)).allowed, true);
});

test("login account quota spans different IPs and stores only normalized account hashes", async () => {
  const database = sharedSql();
  const guard = createRequestGuard({ getSql: () => database.sql, environment: { NODE_ENV: "production" } });
  for (let i = 1; i <= 9; i++) {
    const req = request({ body: { email: i % 2 ? " Admin@Example.com " : "admin@example.com" }, socket: { remoteAddress: `192.0.2.${i}` } });
    const result = await run(guard, req, { scope: "login" });
    assert.equal(result.allowed, i <= 8);
    if (i === 9) assert.equal(result.res.statusCode, 429);
  }
  assert.equal(database.calls.flatMap(call => call.values).some(value => typeof value === "string" && value.includes("example.com")), false);
  assert.equal([...database.buckets.keys()].filter(key => key.startsWith("login:account:")).length, 1);
});

test("chat global daily budget spans IPs and functions, then expires", async () => {
  let timestamp = 0;
  const database = sharedSql(() => timestamp);
  const create = () => createRequestGuard({ getSql: () => database.sql, environment: { NODE_ENV: "production" } });
  const options = { scope: "chat", globalLimit: 2 };
  for (let i = 1; i <= 3; i++) {
    const result = await run(create(), request({ socket: { remoteAddress: `192.0.2.${i}` } }), options);
    assert.equal(result.allowed, i <= 2);
    if (i === 3) assert.equal(result.res.headers["retry-after"], "86400");
  }
  timestamp = 86400 * 1000;
  assert.equal((await run(create(), request(), options)).allowed, true);
});

test("public GET endpoints accept external origins while retaining rate and privacy controls", async () => {
  const guard = localGuard();
  const result = await run(guard, request({ method: "GET", body: undefined, headers: { origin: "https://example.com", "sec-fetch-site": "cross-site", "content-type": undefined } }), { scope: "track", methods: ["GET"] });
  assert.equal(result.allowed, true);
  assert.equal(result.res.headers["cache-control"], "private, no-store");
});
