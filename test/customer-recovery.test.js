const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const recovery = require("../api/_lib/customer-recovery");
const secret = "local-recovery-unit-secret-with-at-least-32-characters";
const id = "12".repeat(24);
for (const [supplied, canonical] of [["081234567890", "6281234567890"], ["+62 812-3456-7890", "6281234567890"],
  ["6281234567890", "6281234567890"], ["(0812) 3456.7890", "6281234567890"]]) {
  test(`canonical Indonesian recovery phone: ${supplied}`, () => assert.equal(recovery.normalizePhone(supplied), canonical));
}
test("recovery refuses malformed, foreign and non-mobile numbers without silently redirecting", () => {
  for (const value of [null, 81234567890, "", "0812", "+181234567890", "006281234567890", "62+81234567890",
    "++6281234567890", "0812x34567890", "6280234567890", "628123456789012345", "081234567890\nhttps://attacker.test"]) {
    assert.throws(() => recovery.normalizePhone(value), error => error.code === "INVALID_PHONE");
  }
});
test("challenge and UUID identities are distinct, canonical and bounded", () => {
  assert.equal(recovery.challengeId(id.toUpperCase()), id);
  const request = crypto.randomUUID();
  assert.equal(recovery.requiredRequestId(request.toUpperCase()), request);
  assert.throws(() => recovery.challengeId(request), error => error.code === "INVALID_CHALLENGE");
  assert.throws(() => recovery.requiredRequestId(id), error => error.code === "INVALID_REQUEST_ID");
  assert.throws(() => recovery.requiredRequestId(undefined), error => error.code === "INVALID_REQUEST_ID");
});
test("six digit code and hash use secret and independent HMAC domains", () => {
  const code = recovery.codeForChallenge(id, secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(recovery.codeForChallenge(id, secret), code);
  assert.notEqual(recovery.codeForChallenge(id, `${secret} rotated`), code);
  const hash = recovery.codeDigest(id, code, secret);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, code);
  assert.notEqual(hash, recovery.digest("phone", `${id}:${code}`, secret));
  assert.equal(recovery.phoneDigest("081234567890", secret), recovery.phoneDigest("+6281234567890", secret));
  assert.throws(() => recovery.codeDigest(id, 123456, secret), error => error.code === "INVALID_CODE");
  assert.throws(() => recovery.codeDigest(id, "12345", secret), error => error.code === "INVALID_CODE");
});
test("public challenge allowlist omits all private matching data", () => {
  assert.deepEqual(recovery.publicChallenge({ challenge_id: id, expires_at: "2030-01-01T00:10:00Z", phone: "6281234567890",
    code: "123456", orders: [{ tracking_token: "secret" }], issued_at: "2030-01-01T00:00:00Z" }),
  { challengeId: id, expiresAt: "2030-01-01T00:10:00Z", status: "awaiting-admin" });
});
test("verified order allowlist exposes summaries and tracking links without PII or receipt access", () => {
  const row = { id: "DP-local-1", tracking_token: "ab".repeat(24), status: "baru", total: "30000", customer_name: "PRIVATE",
    customer_phone: "081234567890", address: "PRIVATE ADDRESS", notes: "PRIVATE NOTE", payment_method: "DANA", receiptUrl: "/nota/",
    queue_number: "A001", queue_date: "2030-01-01", created_at: "2030-01-01T00:00:00Z", updated_at: "2030-01-01T00:00:00Z" };
  const result = recovery.recoveredOrder(row);
  assert.equal(result.total, 30000);
  assert.equal(new URL(result.trackingUrl, "https://shop.test").searchParams.get("token"), row.tracking_token);
  for (const field of ["customer_name", "customer_phone", "address", "notes", "receiptUrl", "payment_method", "tracking_token"]) {
    assert(!Object.hasOwn(result, field));
  }
  assert(!JSON.stringify(result).includes("PRIVATE"));
  for (const status of ["selesai", "dibatalkan", "unknown"]) assert.equal(recovery.recoveredOrder({ ...row, status }), null);
  assert.equal(recovery.recoveredOrder({ ...row, id: "<script>" }), null);
  assert.equal(recovery.recoveredOrder({ ...row, tracking_token: "short" }), null);
});
test("private WhatsApp link has canonical recipient and fixed WIB expiry, absent secret fails closed", () => {
  const previous = process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_SESSION_SECRET = secret;
  try {
    const url = new URL(recovery.recoveryWhatsAppUrl({ phone: "081234567890", challengeId: id, expiresAt: "2030-01-01T12:10:00Z" }));
    assert.equal(url.origin, "https://wa.me");
    assert.equal(url.pathname, "/6281234567890");
    const message = url.searchParams.get("text");
    assert(message.includes(recovery.codeForChallenge(id, secret)));
    assert(message.includes("19.10 WIB"));
    assert(message.includes("Jangan bagikan kode"));
    assert(!message.includes("/track/"));
    process.env.ADMIN_SESSION_SECRET = "short";
    assert.throws(() => recovery.codeForChallenge(id), error => error.code === "ADMIN_AUTH_NOT_CONFIGURED");
  } finally { if (previous === undefined) delete process.env.ADMIN_SESSION_SECRET; else process.env.ADMIN_SESSION_SECRET = previous; }
});
