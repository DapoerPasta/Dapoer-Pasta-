const { verifySession } = require("../_lib/auth");
const { updateOrderStatus } = require("../_lib/db");
const { guardRequest } = require("../_lib/security");

const ALLOWED = new Set(["baru", "diproses", "dikirim", "selesai", "dibatalkan"]);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!(await guardRequest(req, res, { scope: "admin", methods: ["PATCH", "POST"] }))) return;
  if (!verifySession(req)) return res.status(401).json({ error: "Unauthorized" });
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const status = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
  if (!id || !ALLOWED.has(status)) return res.status(400).json({ error: "Status tidak valid." });
  try {
    const order = await updateOrderStatus(id, status);
    if (!order) return res.status(404).json({ error: "Pesanan tidak ditemukan." });
    return res.status(200).json({ order });
  } catch (error) {
    console.error("Update order status failed");
    return res.status(500).json({ error: "Status belum dapat diperbarui." });
  }
};
