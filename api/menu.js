const { STORE } = require("./_lib/catalog");
const { listInventory } = require("./_lib/inventory");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const products = await listInventory();
    return res.status(200).json({ store: STORE, products });
  } catch {
    return res.status(503).json({ error: "Menu dan stok belum dapat dimuat. Silakan coba lagi." });
  }
};
