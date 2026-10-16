// Exercise ownership verification in isolated LOCAL PostgreSQL schemas only.
const { describe, test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const recovery = require("../api/_lib/customer-recovery");
const database = require("../api/_lib/customer-recovery-db");
const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const previousSecret = process.env.ADMIN_SESSION_SECRET;
const fixtures = [];
let adminPool, sequence = 0;
const phone = "6281234567890";
const otherPhone = "6289876543210";
const secret = "local-recovery-integration-secret-at-least-32-characters";
const rejection = (action, code) => assert.rejects(action, error => error.code === code);

async function fixture() {
  const schema = `recovery_integration_${process.pid}_${sequence++}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 20,
    options: `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=12000` });
  const sql = async (parts, ...values) => (await pool.query(typeof parts === "string" ? parts :
    parts.reduce((all, part, index) => all + (index ? `$${index}` : "") + part, ""), values)).rows;
  const f = { schema, pool, sql };
  fixtures.push(f);
  await pool.query(`CREATE TABLE orders(id TEXT PRIMARY KEY, customer_phone TEXT, tracking_token TEXT,
    status TEXT NOT NULL DEFAULT 'baru', total BIGINT NOT NULL DEFAULT 30000, queue_number INTEGER,
    queue_date DATE NOT NULL DEFAULT CURRENT_DATE, delivery_method TEXT NOT NULL DEFAULT 'delivery', shipping_fee BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    customer_name TEXT DEFAULT 'PRIVATE NAME',address TEXT DEFAULT 'PRIVATE ADDRESS',notes TEXT DEFAULT 'PRIVATE NOTES')`);
  await database.ensureRecoverySchema(sql);
  return f;
}
async function cleanup() {
  while (fixtures.length) {
    const { pool, schema } = fixtures.pop();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}
async function order(f, fields = {}) {
  const value = { id: `recovery-order-${sequence++}`, phone: "0812 3456-7890", token: crypto.randomBytes(24).toString("hex"),
    status: "baru", total: 30000, deliveryMethod: "delivery", shippingFee: null, age: "0 days", ...fields };
  await f.pool.query(`INSERT INTO orders(id,customer_phone,tracking_token,status,total,delivery_method,shipping_fee,queue_number,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()-$9::interval)`,
  [value.id, value.phone, value.token, value.status, value.total, value.deliveryMethod, value.shippingFee, sequence, value.age]);
  return value;
}
const request = (f, values = {}) => database.requestRecovery({ phone, requestId: crypto.randomUUID(), ...values }, f.sql);
const issue = (f, challenge, values = {}) => database.issueRecoveryCode({ challengeId: challenge.challengeId, requestId: crypto.randomUUID(), ...values }, f.sql);
const verifyInput = (challenge, values = {}) => ({ challengeId: challenge.challengeId,
  code: recovery.codeForChallenge(challenge.challengeId), requestId: crypto.randomUUID(), ...values });
const verify = (f, input) => database.verifyRecoveryCode(input, f.sql);
const stored = async (f, challenge) => (await f.pool.query("SELECT * FROM customer_recovery_challenges WHERE challenge_id=$1", [challenge.challengeId])).rows[0];
const wrongCode = challenge => recovery.codeForChallenge(challenge.challengeId) === "000000" ? "999999" : "000000";

describe("real PostgreSQL secure cross-device order recovery", { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    const url = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only LOCAL scratch database allowed");
    assert.match(url.pathname, /^\/dapoer_stock_test(?:_[a-z0-9_]+)?$/);
    const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    process.env.ADMIN_SESSION_SECRET = secret;
  });
  afterEach(cleanup);
  after(async () => {
    await cleanup(); await adminPool?.end();
    if (previousSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = previousSecret;
  });

  test("known and unknown phones have the same public shape and expose no order or code", async () => {
    const f = await fixture(); await order(f);
    const known = await request(f), unknown = await request(f, { phone: otherPhone });
    assert.deepEqual(Object.keys(known).sort(), ["challengeId", "expiresAt", "status"]);
    assert.deepEqual(Object.keys(unknown).sort(), Object.keys(known).sort());
    assert.equal(known.status, unknown.status);
    for (const result of [known, unknown]) {
      assert.match(result.challengeId, /^[a-f0-9]{48}$/);
      assert.doesNotMatch(JSON.stringify(result), /628123|0812|PRIVATE|tracking|orders|code/);
      const row = await stored(f, result);
      const lifetime = new Date(row.expires_at) - new Date(row.created_at);
      assert(lifetime >= 599990 && lifetime <= 600000);
      assert.equal(row.code_hash, recovery.codeDigest(result.challengeId, recovery.codeForChallenge(result.challengeId)));
      assert.equal(row.code_hash.length, 64);
      assert.equal(row.attempts, 0);
    }
    assert.equal((await database.listRecoveryRequests(f.sql)).length, 1);
    await rejection(() => issue(f, unknown), "RECOVERY_NOT_FOUND");
    const beforeIssue = await verify(f, verifyInput(unknown));
    assert.deepEqual(beforeIssue, { status: "awaiting-admin" });
    assert.equal((await stored(f, unknown)).attempts, 0);
  });

  test("16 simultaneous request retries create one challenge with a fixed expiry", async () => {
    const f = await fixture(), input = { phone, requestId: crypto.randomUUID() };
    const replies = await Promise.all(Array.from({ length: 16 }, () => request(f, input)));
    replies.forEach(reply => assert.deepEqual(reply, replies[0]));
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM customer_recovery_challenges")).rows[0].n, 1);
    await rejection(() => request(f, { ...input, phone: otherPhone }), "REQUEST_CONFLICT");
    assert.deepEqual(await request(f, input), replies[0]);
  });

  test("durable phone limits serialize one-per-minute and three-per-hour across UUIDs", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => request(f)));
    assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
    results.filter(value => value.status === "rejected").forEach(value => assert.equal(value.reason.code, "RECOVERY_RATE_LIMIT"));
    for (let index = 0; index < 2; index++) {
      await f.pool.query("UPDATE customer_recovery_challenges SET created_at=created_at-INTERVAL '2 minutes'");
      await request(f);
    }
    await f.pool.query("UPDATE customer_recovery_challenges SET created_at=created_at-INTERVAL '2 minutes'");
    await rejection(() => request(f), "RECOVERY_RATE_LIMIT");
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM customer_recovery_challenges")).rows[0].n, 3);
  });

  test("admin issuance pins the saved canonical recipient and returns a link without sending a message", async () => {
    const f = await fixture(); await order(f);
    const challenge = await request(f), input = { requestId: crypto.randomUUID(), phone: otherPhone, code: "111111" };
    const replies = await Promise.all(Array.from({ length: 12 }, () => issue(f, challenge, input)));
    replies.forEach(reply => assert.deepEqual(reply, replies[0]));
    const link = new URL(replies[0].whatsappUrl);
    assert.equal(link.origin, "https://wa.me"); assert.equal(link.pathname, `/${phone}`);
    assert.match(link.searchParams.get("text"), new RegExp(recovery.codeForChallenge(challenge.challengeId)));
    assert.equal(replies[0].expiresAt, challenge.expiresAt);
    const first = await stored(f, challenge);
    const next = await issue(f, challenge);
    assert.equal(next.whatsappUrl, replies[0].whatsappUrl);
    assert.equal((await stored(f, challenge)).issued_at.getTime(), first.issued_at.getTime());
    assert.equal((await stored(f, challenge)).expires_at.getTime(), first.expires_at.getTime());
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM customer_recovery_issues")).rows[0].n, 2);
  });

  test("every issue UUID stays bound to its challenge, including repeated preparations", async () => {
    const f = await fixture(); await order(f); await order(f, { phone: otherPhone });
    const a = await request(f), b = await request(f, { phone: otherPhone });
    const firstId = crypto.randomUUID(), anotherId = crypto.randomUUID();
    await issue(f, a, { requestId: firstId }); await issue(f, a, { requestId: anotherId });
    for (const requestId of [firstId, anotherId]) await rejection(() => issue(f, b, { requestId }), "REQUEST_CONFLICT");
    assert.equal((await stored(f, b)).issued_at, null);
  });

  test("concurrent reuse of an admin issue UUID can prepare only one challenge", async () => {
    const f = await fixture(); await order(f); await order(f, { phone: otherPhone });
    const a = await request(f), b = await request(f, { phone: otherPhone }), requestId = crypto.randomUUID();
    const results = await Promise.allSettled([issue(f, a, { requestId }), issue(f, b, { requestId })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "REQUEST_CONFLICT");
    assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM customer_recovery_challenges WHERE issued_at IS NOT NULL")).rows[0].n, 1);
  });

  test("only matching active orders in the last 30 days can receive codes or be recovered", async () => {
    const f = await fixture();
    const eligible = [];
    for (const status of ["baru", "diproses", "dikirim"]) eligible.push(await order(f, { status }));
    for (const status of ["selesai", "dibatalkan"]) await order(f, { status });
    await order(f, { age: "31 days" }); await order(f, { token: "revoked" }); await order(f, { phone: otherPhone });
    const challenge = await request(f); await issue(f, challenge);
    const result = await verify(f, verifyInput(challenge));
    assert.equal(result.status, "verified");
    assert.deepEqual(result.orders.map(value => value.id).sort(), eligible.map(value => value.id).sort());
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|customer|address|notes|receipt|tracking_token|trackingToken/);
  });

  test("recipient eligibility is rechecked immediately before admin prepares a code", async () => {
    const f = await fixture(), original = await order(f), challenge = await request(f);
    await f.pool.query("UPDATE orders SET customer_phone=$1 WHERE id=$2", [otherPhone, original.id]);
    await rejection(() => issue(f, challenge), "RECOVERY_NOT_FOUND");
    assert.equal((await stored(f, challenge)).issued_at, null);
    assert.equal((await database.listRecoveryRequests(f.sql)).length, 0);
  });

  test("invalid-code retries spend exactly one guess and changing the code conflicts", async () => {
    const f = await fixture(); await order(f);
    const challenge = await request(f); await issue(f, challenge);
    const input = verifyInput(challenge, { code: wrongCode(challenge) });
    const results = await Promise.all(Array.from({ length: 16 }, () => verify(f, input)));
    results.forEach(result => assert.deepEqual(result, { status: "invalid", remainingAttempts: 4 }));
    assert.equal((await stored(f, challenge)).attempts, 1);
    await rejection(() => verify(f, { ...input, code: recovery.codeForChallenge(challenge.challengeId) }), "REQUEST_CONFLICT");
    assert.equal((await stored(f, challenge)).attempts, 1);
  });

  test("parallel guesses cannot exceed five or recover a token after exhaustion", async () => {
    const f = await fixture(); await order(f);
    const challenge = await request(f); await issue(f, challenge);
    const results = await Promise.all(Array.from({ length: 12 }, () => verify(f, verifyInput(challenge, { code: wrongCode(challenge) }))));
    results.forEach(result => { assert.equal(result.status, "invalid"); assert(!Object.hasOwn(result, "orders")); });
    assert.deepEqual(results.map(value => value.remainingAttempts).sort(), [0,0,0,0,0,0,0,0,1,2,3,4]);
    assert.equal((await stored(f, challenge)).attempts, 5);
    assert.deepEqual(await verify(f, verifyInput(challenge)), { status: "invalid", remainingAttempts: 0 });
    await rejection(() => issue(f, challenge), "RECOVERY_CONSUMED");
  });

  test("correct-code retries replay one proof; a different UUID cannot consume it again", async () => {
    const f = await fixture(), original = await order(f), challenge = await request(f); await issue(f, challenge);
    const input = verifyInput(challenge);
    const results = await Promise.all(Array.from({ length: 16 }, () => verify(f, input)));
    results.forEach(result => assert.deepEqual(result, results[0]));
    assert.equal(results[0].orders[0].id, original.id); assert.equal((await stored(f, challenge)).attempts, 1);
    assert.deepEqual(await verify(f, verifyInput(challenge)), { status: "invalid", remainingAttempts: 0 });
    await rejection(() => issue(f, challenge), "RECOVERY_CONSUMED");
  });

  test("the same verification UUID cannot be rebound concurrently to another challenge", async () => {
    const f = await fixture(); await order(f); await order(f, { phone: otherPhone });
    const a = await request(f), b = await request(f, { phone: otherPhone }); await issue(f, a); await issue(f, b);
    const requestId = crypto.randomUUID();
    const results = await Promise.allSettled([verify(f, verifyInput(a, { requestId })), verify(f, verifyInput(b, { requestId }))]);
    assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(results.find(value => value.status === "rejected").reason.code, "REQUEST_CONFLICT");
    assert.equal((await stored(f, a)).attempts + (await stored(f, b)).attempts, 1);
  });

  test("fixed expiry blocks successful proof replay, new guesses and admin reissuance", async () => {
    const f = await fixture(); await order(f);
    const requestId = crypto.randomUUID(), challenge = await request(f, { requestId }); await issue(f, challenge);
    const input = verifyInput(challenge), success = await verify(f, input);
    assert.equal(success.status, "verified");
    await f.pool.query("UPDATE customer_recovery_challenges SET created_at=clock_timestamp()-INTERVAL '20 minutes',expires_at=clock_timestamp()-INTERVAL '10 minutes' WHERE challenge_id=$1", [challenge.challengeId]);
    assert.deepEqual(await verify(f, input), { status: "expired" });
    assert.deepEqual(await verify(f, verifyInput(challenge)), { status: "expired" });
    const before = await stored(f, challenge), replay = await request(f, { requestId });
    assert.equal(replay.challengeId, challenge.challengeId); assert.equal(new Date(replay.expiresAt).getTime(), before.expires_at.getTime());
    await rejection(() => issue(f, challenge), "RECOVERY_EXPIRED");
    assert.equal((await stored(f, challenge)).attempts, 1);
  });

  test("verification replay omits revoked, terminal and changed-phone orders without adding later orders", async () => {
    const f = await fixture(), originals = [];
    for (let index = 0; index < 4; index++) originals.push(await order(f));
    const challenge = await request(f); await issue(f, challenge); const input = verifyInput(challenge);
    assert.equal((await verify(f, input)).orders.length, 4);
    await f.pool.query("UPDATE orders SET tracking_token=$1 WHERE id=$2", [crypto.randomBytes(24).toString("hex"), originals[0].id]);
    await f.pool.query("UPDATE orders SET status='selesai' WHERE id=$1", [originals[1].id]);
    await f.pool.query("UPDATE orders SET customer_phone=$1 WHERE id=$2", [otherPhone, originals[2].id]);
    const later = await order(f);
    const result = await verify(f, input);
    assert.deepEqual(result.orders.map(value => value.id), [originals[3].id]);
    assert(!JSON.stringify(result).includes(later.id));
    assert(!JSON.stringify(result).includes(originals[0].token));
    assert.equal((await stored(f, challenge)).attempts, 1);
  });

  test("recovered order summaries retain confirmed shipping and pickup totals without customer forms", async () => {
    const f = await fixture();
    const delivery = await order(f, { total: 42000, shippingFee: 12000 });
    const pickup = await order(f, { deliveryMethod: "pickup", shippingFee: 0 });
    const challenge = await request(f); await issue(f, challenge);
    const result = await verify(f, verifyInput(challenge));
    const shipped = result.orders.find(value => value.id === delivery.id), collected = result.orders.find(value => value.id === pickup.id);
    assert.deepEqual([shipped.itemsSubtotal, shipped.shippingFee, shipped.grandTotal, shipped.shippingConfirmed], [30000,12000,42000,true]);
    assert.deepEqual([collected.deliveryMethod, collected.shippingFee, collected.grandTotal, collected.shippingConfirmed], ["pickup",0,30000,true]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|customer|address|notes/);
  });

  test("bounded expiry cleanup cascades verification and issue records without deleting live requests", async () => {
    const f = await fixture(); await order(f);
    const old = await request(f); await issue(f, old); await verify(f, verifyInput(old));
    await f.pool.query("UPDATE customer_recovery_challenges SET created_at=clock_timestamp()-INTERVAL '3 hours',expires_at=clock_timestamp()-INTERVAL '2 hours' WHERE challenge_id=$1", [old.challengeId]);
    const live = await request(f, { phone: otherPhone });
    assert.equal(await stored(f, old), undefined); assert(await stored(f, live));
    for (const table of ["customer_recovery_attempts", "customer_recovery_issues"]) assert.equal((await f.pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    assert.deepEqual(await verify(f, verifyInput(old)), { status: "expired" });
  });
});
