const { getPublicOrderStatus } = require("./_lib/db");
const { guardRequest } = require("./_lib/security");
const { publicOrder, requiredRequestId } = require("./_lib/order-additions");
const { normalizePhone, challengeId } = require("./_lib/customer-recovery");
const { requestRecovery, verifyRecoveryCode } = require("./_lib/customer-recovery-db");

function privacyHeaders(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

async function recoverOrder(req, res) {
  // Parse and apply method/origin/body protections before reading a phone or
  // challenge from the body. The second guard enforces durable IP+account limits.
  if (!(await guardRequest(req, res, { scope: "recovery", methods: ["POST"], skipRateLimit: true }))) return;
  let input;
  const action = req.body?.action;
  try {
    if (action === "request-recovery") {
      input = { phone: normalizePhone(req.body.phone), requestId: requiredRequestId(req.body.requestId) };
    } else if (action === "verify-recovery") {
      input = { challengeId: challengeId(req.body.challengeId), requestId: requiredRequestId(req.body.requestId), code: req.body.code };
      if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code)) {
        return res.status(400).json({ code: "INVALID_CODE", error: "Masukkan kode verifikasi 6 angka." });
      }
    } else {
      return res.status(400).json({ code: "INVALID_ACTION", error: "Tindakan pemulihan pesanan tidak valid." });
    }
  } catch (error) {
    return res.status(400).json({ code: error?.code || "INVALID_RECOVERY", error: "Data pemulihan pesanan tidak valid. Periksa nomor WhatsApp atau kode Anda." });
  }
  const verifying = action === "verify-recovery";
  if (!(await guardRequest(req, res, { scope: verifying ? "recovery-verify" : "recovery-request", methods: ["POST"],
    limit: verifying ? 20 : 6, windowSeconds: 15 * 60, account: verifying ? input.challengeId : input.phone }))) return;
  privacyHeaders(res);
  try {
    const result = verifying ? await verifyRecoveryCode(input) : await requestRecovery(input);
    return res.status(200).json(result);
  } catch (error) {
    const code = error?.code || error?.message;
    if (code === "RECOVERY_RATE_LIMIT") {
      res.setHeader("Retry-After", "900");
      return res.status(429).json({ code, error: "Terlalu banyak permintaan pemulihan. Silakan coba lagi nanti." });
    }
    if (code === "REQUEST_CONFLICT") return res.status(409).json({ code, error: "Permintaan sudah digunakan. Muat ulang formulir pemulihan sebelum mencoba lagi." });
    if (["INVALID_PHONE", "INVALID_REQUEST_ID", "INVALID_CHALLENGE", "INVALID_CODE"].includes(code)) {
      return res.status(400).json({ code, error: "Data pemulihan pesanan tidak valid." });
    }
    // A missing challenge cannot disclose whether a phone has an order.
    if (["RECOVERY_NOT_FOUND", "RECOVERY_EXPIRED", "RECOVERY_CONSUMED"].includes(code)) {
      return res.status(200).json({ status: "expired" });
    }
    console.error("Customer order recovery unavailable");
    return res.status(503).json({ error: "Pemulihan pesanan belum tersedia. Coba lagi nanti atau hubungi admin melalui WhatsApp." });
  }
}

module.exports = async function handler(req, res) {
  privacyHeaders(res);
  if (req.method === "POST") return recoverOrder(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  const id = typeof req.query?.id === "string" ? req.query.id.trim() : "";
  const token = typeof req.query?.token === "string" ? req.query.token.trim() : "";

  if (!id || token.length < 32) {
    return res.status(400).json({ error: "Link tracking tidak valid." });
  }

  const allowed = await guardRequest(req, res, { scope: "track", methods: ["GET"] });
  if (!allowed) return;
  privacyHeaders(res);

  try {
    const order = await getPublicOrderStatus(id, token);
    if (!order) return res.status(404).json({ error: "Pesanan tidak ditemukan." });

    return res.status(200).json({ order: publicOrder(order) });
  } catch (error) {
    if (error?.message === "DATABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Tracking pesanan belum tersedia." });
    }
    console.error("Public order tracking failed");
    return res.status(500).json({ error: "Status pesanan belum dapat dimuat." });
  }
};
