const { getPublicOrderStatus } = require("./_lib/db");
const { guardRequest } = require("./_lib/security");
const { queueMetadata } = require("./_lib/order-queue");

function privacyHeaders(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function publicItems(items) {
  return (Array.isArray(items) ? items : []).map(item => ({
    id: typeof item?.id === "string" ? item.id : "",
    name: typeof item?.name === "string" ? item.name : "",
    price: Number(item?.price) || 0,
    quantity: Number(item?.quantity) || 0,
    subtotal: Number(item?.subtotal) || 0
  }));
}

module.exports = async function handler(req, res) {
  privacyHeaders(res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
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

    return res.status(200).json({
      order: {
        id: order.id,
        ...queueMetadata(order),
        items: publicItems(order.items),
        total: Number(order.total),
        status: order.status,
        paymentMethod: order.payment_method,
        createdAt: order.created_at,
        updatedAt: order.updated_at
      }
    });
  } catch (error) {
    if (error?.message === "DATABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Tracking pesanan belum tersedia." });
    }
    console.error("Public order tracking failed");
    return res.status(500).json({ error: "Status pesanan belum dapat dimuat." });
  }
};
