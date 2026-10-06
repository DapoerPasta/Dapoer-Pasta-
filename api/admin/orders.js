const { verifySession } = require("../_lib/auth");
const { listOrdersByDate } = require("../_lib/db");
const { HistoryQueryError, parseHistoryQuery } = require("../_lib/order-history");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!verifySession(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }
  try {
    const options = parseHistoryQuery(req);
    const history = await listOrdersByDate(options);
    return res.status(200).json(history);
  } catch (error) {
    if (error instanceof HistoryQueryError) {
      return res.status(400).json({ error: error.message });
    }
    if (error?.message === "DATABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Database belum dikonfigurasi." });
    }
    console.error("List orders failed");
    return res.status(500).json({ error: "Pesanan belum dapat dimuat." });
  }
};
