const { STORE, PRODUCTS } = require("./_lib/catalog");

function normalizeItems(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error("INVALID_ITEMS");
  const byId = new Map(PRODUCTS.map((p) => [p.id, p]));
  const merged = new Map();

  for (const raw of input) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const quantity = Number(raw?.quantity);
    const product = byId.get(id);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error("INVALID_ITEM");
    const next = (merged.get(id) || 0) + quantity;
    if (next > 20) throw new Error("INVALID_QUANTITY");
    merged.set(id, next);
  }

  return [...merged.entries()].map(([id, quantity]) => {
    const product = byId.get(id);
    return { id, name: product.name, price: product.price, quantity, subtotal: product.price * quantity };
  });
}

const rupiah = (value) => `Rp ${Number(value).toLocaleString("id-ID")}`;
const createOrderId = () => `DP-${Date.now().toString(36).toUpperCase()}`;

function buildMessage(orderId, items, total) {
  const lines = ["Halo Admin Dapoer Pasta, saya mau pesan:", "", `No. Pesanan: *${orderId}*`, ""];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. *${item.name}*`, `Jumlah: ${item.quantity}`, `Subtotal: ${rupiah(item.subtotal)}`, "");
  });
  lines.push(`*TOTAL PESANAN: ${rupiah(total)}*`, "", "Nama Pemesan:", "Alamat Pengiriman:", "Metode Pembayaran: (OVO / ShopeePay / DANA)", "", "_Mohon info ongkirnya ya kak._");
  return lines.join("\n");
}

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  let items;
  try {
    items = normalizeItems(req.body?.items);
  } catch {
    return res.status(400).json({ error: "Isi keranjang tidak valid." });
  }

  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  const orderId = createOrderId();
  const message = buildMessage(orderId, items, total);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=${STORE.whatsapp}&text=${encodeURIComponent(message)}`;

  return res.status(200).json({ order: { id: orderId, items, total }, whatsappUrl });
};
