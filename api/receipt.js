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
    return res.status(400).json({ error: "Link nota tidak valid." });
  }

  try {
    const order = await getPublicOrderStatus(id, token);
    if (!order) return res.status(404).json({ error: "Nota tidak ditemukan." });

    return res.status(200).json({
      order: {
        id: order.id,
        customerName: order.customer_name,
        customerPhone: order.customer_phone,
        address: order.address,
        notes: order.notes,
        items: order.items,
        total: Number(order.total),
        status: order.status,
        paymentMethod: order.payment_method,
        createdAt: order.created_at,
        updatedAt: order.updated_at
      }
    });
  } catch (error) {
    console.error("Receipt load failed", error);
    return res.status(500).json({ error: "Nota belum dapat dimuat." });
  }
};
