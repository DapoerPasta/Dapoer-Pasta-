const crypto = require("node:crypto");

const COOKIE_NAME = "dp_admin_session";
const MAX_AGE = 60 * 60 * 8;
const MAX_COOKIE_HEADER_LENGTH = 16384;
const MAX_TOKEN_LENGTH = 2048;

function safeEqual(a, b) {
  // Fixed-size digests allow the comparison itself to run for every input length.
  const aa = crypto.createHash("sha256").update(a).digest();
  const bb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(aa, bb);
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function authConfiguration() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD || "";
  const secret = process.env.ADMIN_SESSION_SECRET || "";
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email) ||
      password.length < 12 || !password.trim() ||
      secret.length < 32 || !secret.trim()) return null;
  return { email, password, secret };
}

function isAuthConfigured() {
  return Boolean(authConfiguration());
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function createSession(email) {
  const config = authConfiguration();
  if (!config) throw new Error("ADMIN_AUTH_NOT_CONFIGURED");
  if (!safeEqual(normalizeEmail(email), config.email)) throw new Error("ADMIN_IDENTITY_MISMATCH");
  const payload = Buffer.from(JSON.stringify({
    email: config.email,
    exp: Date.now() + MAX_AGE * 1000
  })).toString("base64url");
  return `${payload}.${sign(payload, config.secret)}`;
}

function parseCookies(req) {
  const header = req.headers?.cookie || "";
  if (typeof header !== "string" || header.length > MAX_COOKIE_HEADER_LENGTH) throw new Error("INVALID_COOKIE");
  const cookies = Object.create(null);
  for (const part of header.split(";")) {
    const pair = part.trim();
    if (!pair) continue;
    const i = pair.indexOf("=");
    const name = pair.slice(0, i);
    if (i < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        Object.hasOwn(cookies, name)) throw new Error("INVALID_COOKIE");
    const value = decodeURIComponent(pair.slice(i + 1));
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("INVALID_COOKIE");
    cookies[name] = value;
  }
  return cookies;
}

function verifySession(req) {
  try {
    const config = authConfiguration();
    if (!config) return null;
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
        Buffer.from(payload, "base64url").toString("base64url") !== payload ||
        !safeEqual(sign(payload, config.secret), signature)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        typeof data.email !== "string" || !safeEqual(data.email, config.email) ||
        typeof data.exp !== "number" || !Number.isSafeInteger(data.exp) ||
        data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function validCredentials(email, password) {
  const config = authConfiguration();
  if (!config) return false;
  const emailMatches = safeEqual(normalizeEmail(email), config.email);
  const passwordMatches = safeEqual(typeof password === "string" ? password : "", config.password);
  return emailMatches && passwordMatches;
}

module.exports = {
  createSession, verifySession, sessionCookie, clearSessionCookie, validCredentials, isAuthConfigured
};
