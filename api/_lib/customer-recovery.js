const crypto = require("node:crypto");
const { operationError, requestId } = require("./operations");
const { fulfillmentMetadata } = require("./fulfillment");

const RECOVERY_TTL_MS = 10 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 5;

function normalizePhone(value) {
  if (typeof value !== "string" || value.length > 40 || !/^[+0-9()\s.-]+$/.test(value)) {
    throw operationError("INVALID_PHONE");
  }
  let phone = value.replace(/[\s().-]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("08")) phone = `62${phone.slice(1)}`;
  if (!/^628[1-9][0-9]{7,10}$/.test(phone)) throw operationError("INVALID_PHONE");
  return phone;
}

function requiredRequestId(value) {
  const id = requestId(value);
  if (!id) throw operationError("INVALID_REQUEST_ID");
  return id;
}

function challengeId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{48}$/i.test(value)) throw operationError("INVALID_CHALLENGE");
  return value.toLowerCase();
}

function recoverySecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32 || !secret.trim()) {
    throw operationError("ADMIN_AUTH_NOT_CONFIGURED");
  }
  return secret;
}

function digest(domain, value, secret = recoverySecret()) {
  return crypto.createHmac("sha256", secret).update(`dapoer-recovery-v1:${domain}\0${value}`).digest("hex");
}

function codeForChallenge(value, secret = recoverySecret()) {
  const id = challengeId(value);
  // Six bytes keep the conversion within the exact integer range. The keyed,
  // random 192-bit challenge prevents client-controlled code prediction.
  const number = Number.parseInt(digest("code", id, secret).slice(0, 12), 16) % 1000000;
  return String(number).padStart(6, "0");
}

function codeDigest(id, value, secret = recoverySecret()) {
  const checked = challengeId(id);
  if (typeof value !== "string" || !/^[0-9]{6}$/.test(value)) throw operationError("INVALID_CODE");
  return digest("code-hash", `${checked}:${value}`, secret);
}

function phoneDigest(value, secret = recoverySecret()) {
  return digest("phone", normalizePhone(value), secret);
}

function maskPhone(value) {
  const phone = normalizePhone(value);
  return `+${phone.slice(0, 4)}${"•".repeat(Math.max(4, phone.length - 7))}${phone.slice(-3)}`;
}

function publicChallenge(row) {
  return { challengeId: challengeId(row.challengeId || row.challenge_id),
    expiresAt: row.expiresAt || row.expires_at, status: "awaiting-admin" };
}

function recoveredOrder(row) {
  const id = row?.id;
  const token = row?.trackingToken ?? row?.tracking_token;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
      typeof token !== "string" || !/^[a-f0-9]{48}$/i.test(token) ||
      !["baru", "diproses", "dikirim"].includes(row.status) ||
      !Number.isSafeInteger(Number(row.total)) || Number(row.total) < 1) return null;
  // This explicit allowlist must stay independent of order/customer objects.
  return { id, status: row.status, total: Number(row.total),
    ...fulfillmentMetadata(row),
    queueNumber: row.queueNumber ?? row.queue_number ?? null,
    queueDate: row.queueDate ?? row.queue_date ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    trackingUrl: `/track/?${new URLSearchParams({ id, token: token.toLowerCase() })}` };
}

function recoveryWhatsAppUrl({ phone, challengeId: id, expiresAt }) {
  const recipient = normalizePhone(phone);
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw operationError("INVALID_CHALLENGE");
  const time = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(expiry);
  const message = `Dapoer Pasta — pemulihan pesanan\n\nKode verifikasi Anda: ${codeForChallenge(id)}\nBerlaku hingga ${time} WIB (10 menit sejak permintaan).\n\nMasukkan kode hanya di website Dapoer Pasta. Jangan bagikan kode ini kepada orang lain.\nJika Anda tidak meminta pemulihan pesanan, abaikan pesan ini.`;
  return `https://wa.me/${recipient}?text=${encodeURIComponent(message)}`;
}

module.exports = { RECOVERY_TTL_MS, RECOVERY_MAX_ATTEMPTS, normalizePhone, requiredRequestId,
  challengeId, recoverySecret, digest, codeForChallenge, codeDigest, phoneDigest, maskPhone,
  publicChallenge, recoveredOrder, recoveryWhatsAppUrl };
