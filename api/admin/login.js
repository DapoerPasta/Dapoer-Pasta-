const { createSession, sessionCookie, validCredentials } = require("../_lib/auth");

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
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
