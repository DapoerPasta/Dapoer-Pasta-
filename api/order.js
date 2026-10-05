const crypto = require("node:crypto");
const { STORE, PRODUCTS } = require("./_lib/catalog");
const { saveOrder } = require("./_lib/db");

function normalizeItems(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error("INVALID_ITEMS");
  const byId = new Map(PRODUCTS.map((p) => [p.id, p]));
  const merged = new Map();

  for (const raw of input) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const quantity = Number(raw?.quantity);
    const product = byId.get(id);
    if (!product || !Number.isSafeInteger(quantity) || quantity < 1) throw new Error("INVALID_ITEM");
    const next = (merged.get(id) || 0) + quantity;
    if (!Number.isSafeInteger(next)) throw new Error("INVALID_QUANTITY");
    merged.set(id, next);
  }

  return [...merged.entries()].map(([id, quantity]) => {
    const product = byId.get(id);
    return { id, name: product.name, price: product.price, quantity, subtotal: product.price * quantity };
  });
}

function cleanText(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max)
    : "";
}

function normalizeCustomer(input) {
  const name = cleanText(input?.name, 80);
  const phone = cleanText(input?.phone, 24).replace(/[^0-9+\- ()]/g, "");
  const address = cleanText(input?.address, 500);
  const notes = cleanText(input?.notes, 300);
  const paymentMethod = cleanText(input?.paymentMethod, 30);

  if (name.length < 2 || phone.replace(/\D/g, "").length < 8 || address.length < 5) {
    throw new Error("INVALID_CUSTOMER");
  }
  if (!STORE.paymentMethods.includes(paymentMethod)) {
    throw new Error("INVALID_PAYMENT");
  }

  return { name, phone, address, notes, paymentMethod };
}

const rupiah = (value) => `Rp ${Number(value).toLocaleString("id-ID")}`;

function createOrderId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `DP-${stamp}-${suffix}`;
}

function buildMessage(order, trackingUrl) {
  const lines = [
    "Halo Admin Dapoer Pasta, saya mau pesan:",
    "",
    `No. Pesanan: *${order.id}*`,
    `Nama: *${order.customer.name}*`,
    `WhatsApp: ${order.customer.phone}`,
    `Alamat: ${order.customer.address}`,
    `Pembayaran: ${order.customer.paymentMethod}`,
    order.customer.notes ? `Catatan: ${order.customer.notes}` : "",
    ""
  ].filter(Boolean);

  order.items.forEach((item, index) => {
    lines.push(
      `${index + 1}. *${item.name}*`,
      `Jumlah: ${item.quantity}`,
      `Subtotal: ${rupiah(item.subtotal)}`,
      ""
    );
  });

  lines.push(
    `*TOTAL PESANAN: ${rupiah(order.total)}*`,
    "",
    trackingUrl ? `Lacak status: ${trackingUrl}` : "",
    "",
    "_Mohon konfirmasi pesanan dan info ongkirnya ya kak._"
  );

  return lines.join("\n");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metode tidak diizinkan." });
  }

  let items;
  let customer;
  try {
    items = normalizeItems(req.body?.items);
    customer = normalizeCustomer(req.body?.customer);
  } catch {
    return res.status(400).json({ error: "Data checkout belum lengkap atau tidak valid." });
  }

  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  if (!Number.isSafeInteger(total) || total < 1) {
    return res.status(400).json({ error: "Total pesanan tidak valid." });
  }

  const trackingToken = crypto.randomBytes(24).toString("hex");
  const order = {
    id: createOrderId(),
    trackingToken,
    customer,
    items,
    total
  };

  let persisted = false;
  try {
    persisted = await saveOrder(order);
  } catch (error) {
    console.error("Order database save failed", error);
    return res.status(503).json({
      error: "Pesanan belum dapat disimpan. Silakan coba lagi beberapa saat."
    });
  }

  const relativeTrackingUrl = `/track/?id=${encodeURIComponent(order.id)}&token=${encodeURIComponent(order.trackingToken)}`;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || "";
  const trackingUrl = host ? `${proto}://${host}${relativeTrackingUrl}` : relativeTrackingUrl;
  const message = buildMessage(order, trackingUrl);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=${STORE.whatsapp}&text=${encodeURIComponent(message)}`;

  return res.status(200).json({
    order: { id: order.id, items, total, customer },
    persisted,
    whatsappUrl,
    trackingUrl
  });
};
