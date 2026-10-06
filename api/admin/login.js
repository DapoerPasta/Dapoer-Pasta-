const { createSession, sessionCookie, validCredentials, isAuthConfigured } = require("../_lib/auth");
const { guardRequest } = require("../_lib/security");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!(await guardRequest(req, res, { scope: "login", methods: ["POST"] }))) return;
  if (!isAuthConfigured()) {
    return res.status(503).json({ error: "Login admin belum dikonfigurasi." });
  }
  const email = typeof req.body?.email === "string" ? req.body.email : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!validCredentials(email, password)) {
    return res.status(401).json({ error: "Email atau password salah." });
  }
  try {
    const token = createSession(email.trim().toLowerCase());
    res.setHeader("Set-Cookie", sessionCookie(token));
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Login admin belum dikonfigurasi." });
  }
};
