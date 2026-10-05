const QRCode = require("qrcode");
const { getPublicOrderStatus } = require("./_lib/db");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, max-age=300");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }

  const id = typeof req.query?.id === "string" ? req.query.id.trim() : "";
  const token = typeof req.query?.token === "string" ? req.query.token.trim() : "";
  if (!id || token.length < 32) return res.status(400).send("Invalid QR request");

  try {
    const order = await getPublicOrderStatus(id, token);
    if (!order) return res.status(404).send("Order not found");

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || "";
    const receiptUrl = `${proto}://${host}/nota/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
    const svg = await QRCode.toString(receiptUrl, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320
    });

    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    return res.status(200).send(svg);
  } catch (error) {
    console.error("QR generation failed", error);
    return res.status(500).send("QR unavailable");
  }
};
