const { getPublicOrderStatus } = require("./_lib/db");
const { verifySession } = require("./_lib/auth");
const { guardRequest } = require("./_lib/security");

function privacyHeaders(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Vary", "Cookie");
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
    return res.status(400).json({ error: "Link nota tidak valid." });
  }

  const allowed = await guardRequest(req, res, { scope: "receipt", methods: ["GET"] });
  if (!allowed) return;
  privacyHeaders(res);

  try {
    const order = await getPublicOrderStatus(id, token);
    if (!order) return res.status(404).json({ error: "Nota tidak ditemukan." });

    const admin = verifySession(req);
    const receipt = {
      id: order.id,
      items: publicItems(order.items),
      total: Number(order.total),
      status: order.status,
      paymentMethod: order.payment_method,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      customerDataProtected: !admin
    };

    if (admin) {
      Object.assign(receipt, {
        customerName: order.customer_name,
        customerPhone: order.customer_phone,
        address: order.address,
        notes: order.notes
      });
    }

    return res.status(200).json({ order: receipt });
  } catch (error) {
    if (error?.message === "DATABASE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Nota pesanan belum tersedia." });
    }
    console.error("Receipt load failed");
    return res.status(500).json({ error: "Nota belum dapat dimuat." });
  }
};
