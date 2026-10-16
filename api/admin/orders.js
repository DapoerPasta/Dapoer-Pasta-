const { verifySession } = require("../_lib/auth");
const { listOrdersByDate, reviewOrderAddition, updateOrderShipping } = require("../_lib/db");
const { HistoryQueryError, parseHistoryQuery } = require("../_lib/order-history");
const { guardRequest } = require("../_lib/security");
const { validateExpectedStatus, operationError } = require("../_lib/operations");
const { orderId, requiredRequestId, publicAddition, publicOrder, ADDITION_CONFLICTS } = require("../_lib/order-additions");
const { validateShippingUpdate } = require("../_lib/fulfillment");
const { listRecoveryRequests, issueRecoveryCode } = require("../_lib/customer-recovery-db");
const { challengeId } = require("../_lib/customer-recovery");

async function setShipping(req, res) {
  let input;
  try { input = validateShippingUpdate(req.body); }
  catch (error) {
    return res.status(400).json({ code: error?.code || "INVALID_SHIPPING_FEE", error: "Data ongkir tidak valid. Masukkan nominal rupiah bulat dan muat ulang pesanan." });
  }
  try {
    const order = await updateOrderShipping(input);
    if (!order) return res.status(404).json({ error: "Pesanan tidak ditemukan." });
    return res.status(200).json({ order: publicOrder(order) });
  } catch (error) {
    const code = error?.code || error?.message;
    if (code === "INVALID_SHIPPING_FEE") {
      return res.status(400).json({ code, error: "Nominal ongkir atau total pesanan tidak valid. Periksa kembali jumlahnya." });
    }
    if (["SHIPPING_NOT_ALLOWED", "REQUEST_CONFLICT", "ORDER_CONFLICT"].includes(code)) {
      return res.status(409).json({ code, error: code === "SHIPPING_NOT_ALLOWED"
        ? "Ongkir hanya dapat diatur untuk pesanan diantar yang masih baru atau diproses."
        : "Pesanan telah berubah atau permintaan sudah digunakan. Muat ulang dan periksa total terbaru." });
    }
    console.error("Order shipping update unavailable");
    return res.status(503).json({ error: "Ongkir belum dapat disimpan. Coba lagi dengan permintaan yang sama." });
  }
}

async function sendRecoveryCode(req, res) {
  let input;
  try { input = { challengeId: challengeId(req.body?.challengeId), requestId: requiredRequestId(req.body?.requestId) }; }
  catch (error) {
    return res.status(400).json({ code: error?.code || "INVALID_CHALLENGE", error: "Permintaan kode tidak valid. Muat ulang daftar pemulihan." });
  }
  try { return res.status(200).json(await issueRecoveryCode(input)); }
  catch (error) {
    const code = error?.code || error?.message;
    if (code === "RECOVERY_NOT_FOUND") return res.status(404).json({ code, error: "Permintaan pemulihan tidak ditemukan." });
    if (["RECOVERY_EXPIRED", "RECOVERY_CONSUMED", "REQUEST_CONFLICT"].includes(code)) {
      return res.status(409).json({ code, error: "Permintaan pemulihan sudah berubah atau kedaluwarsa. Muat ulang daftar pemulihan." });
    }
    if (code === "RECOVERY_RATE_LIMIT") return res.status(429).json({ code, error: "Batas kode pemulihan telah tercapai. Coba lagi nanti." });
    console.error("Recovery code generation unavailable");
    return res.status(503).json({ error: "Kode belum dapat dibuat. Coba lagi dengan permintaan yang sama." });
  }
}

async function reviewAddition(req, res) {
  let input;
  try {
    if (req.body?.action !== "review-addition") throw operationError("INVALID_ACTION");
    const observed = validateExpectedStatus(req.body);
    if (!observed) throw operationError("INVALID_EXPECTED_STATUS");
    const decision = req.body.decision;
    if (!["approve", "reject"].includes(decision)) throw operationError("INVALID_DECISION");
    input = { id: orderId(req.body.id), additionId: requiredRequestId(req.body.additionId),
      requestId: requiredRequestId(req.body.requestId), decision, ...observed };
  } catch (error) {
    return res.status(400).json({ code: error.code || "INVALID_ADDITION", error: "Konfirmasi tambahan menu tidak valid. Muat ulang daftar pesanan dan coba lagi." });
  }
  try {
    const result = await reviewOrderAddition(input);
    if (!result) return res.status(404).json({ error: "Pesanan atau tambahan menu tidak ditemukan." });
    return res.status(200).json({ addition: publicAddition(result.addition), order: publicOrder(result.order) });
  } catch (error) {
    const code = error?.code || error?.message;
    if (ADDITION_CONFLICTS[code]) return res.status(409).json({ code, error: ADDITION_CONFLICTS[code] });
    if (code === "ADDITION_NOT_FOUND") return res.status(404).json({ code, error: "Tambahan menu tidak ditemukan." });
    if (code === "DATABASE_NOT_CONFIGURED") return res.status(503).json({ error: "Database belum dikonfigurasi." });
    console.error("Review order addition failed");
    return res.status(503).json({ error: "Tambahan menu belum dapat diputuskan. Coba lagi dengan permintaan yang sama." });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!verifySession(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.method === "POST") {
    if (!(await guardRequest(req, res, { scope: "admin", methods: ["POST"] }))) return;
    if (req.body?.action === "review-addition") return reviewAddition(req, res);
    if (req.body?.action === "set-shipping") return setShipping(req, res);
    if (req.body?.action === "send-recovery-code") return sendRecoveryCode(req, res);
    return res.status(400).json({ code: "INVALID_ACTION", error: "Tindakan pesanan tidak valid." });
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }
  if (req.query?.view === "recovery-requests") {
    if (!(await guardRequest(req, res, { scope: "admin", methods: ["GET"] }))) return;
    try { return res.status(200).json({ requests: await listRecoveryRequests() }); }
    catch {
      console.error("Recovery request listing unavailable");
      return res.status(503).json({ error: "Permintaan pemulihan belum dapat dimuat." });
    }
  }
  if (req.query?.view !== undefined) return res.status(400).json({ error: "Tampilan pesanan tidak valid." });
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
