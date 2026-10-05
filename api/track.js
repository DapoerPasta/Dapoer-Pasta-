const { getPublicOrderStatus } = require("./_lib/db");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  const id = typeof req.query?.id === "string" ? req.query.id.trim() : "";
  const token = typeof req.query?.token === "string" ? req.query.token.trim() : "";

  if (!id || token.length < 32) {
    return res.status(400).json({ error: "Link tracking tidak valid." });
  }

  try {
    const order = await getPublicOrderStatus(id, token);
    if (!order) return res.status(404).json({ error: "Pesanan tidak ditemukan." });

    return res.status(200).json({
      order: {
        id: order.id,
        items: order.items,
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
    console.error("Public order tracking failed", error);
    return res.status(500).json({ error: "Status pesanan belum dapat dimuat." });
  }
};
