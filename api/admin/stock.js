const { verifySession } = require("../_lib/auth");
const { guardRequest } = require("../_lib/security");
const { listInventory, adjustStock, validateStockAdjustment } = require("../_lib/inventory");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!(await guardRequest(req, res, { scope: "admin", methods: ["GET", "PATCH"] }))) return;
  if (!verifySession(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    if (req.method === "GET") return res.status(200).json({ products: await listInventory() });
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    const delta = req.body?.delta;
    validateStockAdjustment(id, delta);
    const product = await adjustStock(id, delta);
    return res.status(200).json({ product });
  } catch (error) {
    if (error?.code === "INVALID_STOCK_ADJUSTMENT") {
      return res.status(400).json({ code: error.code, error: "Pilih produk dan jumlah stok yang valid (1–1.000.000)." });
    }
    if (error?.code === "INSUFFICIENT_STOCK") {
      return res.status(409).json({ code: error.code, error: "Stok tidak cukup untuk pengurangan tersebut. Muat ulang stok dan coba lagi." });
    }
    if (error?.code === "DATABASE_NOT_CONFIGURED" || error?.message === "DATABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Database belum dikonfigurasi." });
    }
    console.error("Stock request failed");
    return res.status(503).json({ error: "Stok belum dapat diperbarui atau dimuat. Silakan coba lagi." });
  }
};
