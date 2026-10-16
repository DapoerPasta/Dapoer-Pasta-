const { verifySession } = require("../_lib/auth");
const { listOrdersByDate, reviewOrderAddition } = require("../_lib/db");
const { HistoryQueryError, parseHistoryQuery } = require("../_lib/order-history");
const { guardRequest } = require("../_lib/security");
const { validateExpectedStatus, operationError } = require("../_lib/operations");
const { orderId, requiredRequestId, publicAddition, publicOrder, ADDITION_CONFLICTS } = require("../_lib/order-additions");

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
    return reviewAddition(req, res);
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
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
