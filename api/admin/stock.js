const { verifySession } = require("../_lib/auth");
const { guardRequest } = require("../_lib/security");
const { listInventory, adjustStock, setStock, validateStockAdjustment, validateStockSet } = require("../_lib/inventory");
const { requestId } = require("../_lib/operations");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!(await guardRequest(req, res, { scope: "admin", methods: ["GET", "PATCH"] }))) return;
  if (!verifySession(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    if (req.method === "GET") return res.status(200).json({ products: await listInventory() });
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    const operationId = requestId(req.body?.requestId);
    const hasDelta = Object.prototype.hasOwnProperty.call(req.body || {}, "delta");
    const hasStock = Object.prototype.hasOwnProperty.call(req.body || {}, "stock");
    if (hasDelta && hasStock) {
      return res.status(400).json({ code: "INVALID_STOCK_SET", error: "Pilih satu tindakan: tambah/kurangi stok atau atur jumlah stok akhir." });
    }
    let product;
    if (hasStock) {
      validateStockSet(id, req.body.stock, req.body.expectedStock);
      product = await setStock(id, req.body.stock, req.body.expectedStock, operationId || undefined);
    } else {
      const delta = req.body?.delta;
      validateStockAdjustment(id, delta);
      product = await adjustStock(id, delta, operationId || undefined);
    }
    return res.status(200).json({ product });
  } catch (error) {
    if (error?.code === "INVALID_REQUEST_ID") {
      return res.status(400).json({ code: error.code, error: "Identitas pembaruan stok tidak valid. Muat ulang halaman." });
    }
    if (error?.code === "REQUEST_CONFLICT") {
      return res.status(409).json({ code: error.code, error: "Permintaan ini sudah digunakan untuk perubahan stok berbeda. Muat ulang stok dan periksa pembaruan sebelumnya." });
    }
    if (error?.code === "INVALID_STOCK_SET") {
      return res.status(400).json({ code: error.code, error: "Pilih produk, jumlah stok akhir, dan stok saat ini yang valid (0–1.000.000)." });
    }
    if (error?.code === "INVALID_STOCK_ADJUSTMENT") {
      return res.status(400).json({ code: error.code, error: "Pilih produk dan jumlah stok yang valid (1–1.000.000)." });
    }
    if (error?.code === "INSUFFICIENT_STOCK") {
      return res.status(409).json({ code: error.code, error: "Stok tidak cukup untuk pengurangan tersebut. Muat ulang stok dan coba lagi." });
    }
    if (error?.code === "STOCK_CONFLICT") {
      return res.status(409).json({ code: error.code, error: "Stok berubah sejak terakhir dimuat, mungkin karena pesanan atau pembaruan admin lain. Muat ulang stok dan periksa jumlah terbaru sebelum mencoba lagi." });
    }
    if (error?.code === "DATABASE_NOT_CONFIGURED" || error?.message === "DATABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Database belum dikonfigurasi." });
    }
    console.error("Stock request failed");
    return res.status(503).json({ error: "Stok belum dapat diperbarui atau dimuat. Silakan coba lagi." });
  }
};
