const crypto = require("node:crypto");

const COOKIE_NAME = "dp_admin_session";
const MAX_AGE = 60 * 60 * 8;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function secret() {
  return process.env.ADMIN_SESSION_SECRET || "";
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function createSession(email) {
  if (!secret()) throw new Error("ADMIN_SESSION_SECRET_MISSING");
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Date.now() + MAX_AGE * 1000
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function parseCookies(req) {
  const header = req.headers?.cookie || "";
  return Object.fromEntries(
    header.split(";").map(v => v.trim()).filter(Boolean).map(v => {
      const i = v.indexOf("=");
      return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
    })
  );
}

function verifySession(req) {
  try {
    if (!secret()) return null;
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.email || !data.exp || Date.now() > data.exp) return null;
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
  const expectedEmail = process.env.ADMIN_EMAIL || "";
  const expectedPassword = process.env.ADMIN_PASSWORD || "";
  return Boolean(expectedEmail && expectedPassword) &&
    safeEqual(String(email || "").trim().toLowerCase(), expectedEmail.trim().toLowerCase()) &&
    safeEqual(password, expectedPassword);
}

module.exports = {
  createSession, verifySession, sessionCookie, clearSessionCookie, validCredentials
};
