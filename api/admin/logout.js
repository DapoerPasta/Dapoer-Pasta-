const { clearSessionCookie } = require("../_lib/auth");
const { guardRequest } = require("../_lib/security");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!(await guardRequest(req, res, { scope: "admin", methods: ["POST"], allowEmptyBody: true }))) return;
  res.setHeader("Set-Cookie", clearSessionCookie());
  return res.status(200).json({ ok: true });
};
