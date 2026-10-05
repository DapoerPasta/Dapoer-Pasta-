const { verifySession } = require("../_lib/auth");
const { updatePaymentStatus } = require("../_lib/db");

const ALLOWED = new Set(["belum_bayar", "lunas"]);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!verifySession(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "PATCH" && req.method !== "POST") {
    res.setHeader("Allow", "PATCH, POST");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const paymentStatus = typeof req.body?.paymentStatus === "string" ? req.body.paymentStatus.trim().toLowerCase() : "";
  if (!id || !ALLOWED.has(paymentStatus)) {
    return res.status(400).json({ error: "Status pembayaran tidak valid." });
  }

  try {
    const order = await updatePaymentStatus(id, paymentStatus);
    if (!order) return res.status(404).json({ error: "Pesanan tidak ditemukan." });
    return res.status(200).json({ order });
  } catch (error) {
    console.error("Update payment status failed", error);
    return res.status(500).json({ error: "Status pembayaran belum dapat diperbarui." });
  }
};
