const { verifySession } = require("../_lib/auth");
const { listOrders } = require("../_lib/db");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!verifySession(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }
  try {
    const rows = await listOrders(150);
    return res.status(200).json({ orders: rows });
  } catch (error) {
    if (error?.message === "DATABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Database belum dikonfigurasi." });
    }
    console.error("List orders failed", error);
    return res.status(500).json({ error: "Pesanan belum dapat dimuat." });
  }
};
