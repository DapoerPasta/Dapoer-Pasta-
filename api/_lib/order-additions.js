const { STORE, PRODUCTS } = require("./catalog");
const { queueMetadata } = require("./order-queue");
const { operationError, requestId, expectedTotal } = require("./operations");

const ADDITION_STATUSES = new Set(["applied", "pending", "approved", "rejected", "expired"]);

function orderId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw operationError("INVALID_ORDER_ID");
  return id;
}

function additionCredentials(body = {}) {
  const id = orderId(body.id);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^[a-f0-9]{48}$/i.test(token)) throw operationError("INVALID_TRACKING_TOKEN");
  return { id, trackingToken: token };
}

function requiredRequestId(value) {
  const id = requestId(value);
  if (!id) throw operationError("INVALID_REQUEST_ID");
  return id;
}

function normalizeAdditionItems(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw operationError("INVALID_ITEMS");
  const catalog = new Map(PRODUCTS.map(product => [product.id, product]));
  const quantities = new Map();
  for (const item of input) {
    const product = catalog.get(item?.id);
    if (!product || !Number.isSafeInteger(item?.quantity) || item.quantity < 1) throw operationError("INVALID_ITEM");
    const quantity = (quantities.get(product.id) || 0) + item.quantity;
    if (!Number.isSafeInteger(quantity) || quantity > 1000000) throw operationError("INVALID_QUANTITY");
    quantities.set(product.id, quantity);
  }
  return [...quantities].sort(([a], [b]) => a.localeCompare(b)).map(([id, quantity]) => {
    const product = catalog.get(id);
    return { id, name: product.name, price: product.price, quantity, subtotal: product.price * quantity };
  });
}

function additionRequest(body = {}) {
  const identity = additionCredentials(body);
  const operationId = requiredRequestId(body.requestId);
  const displayedTotal = expectedTotal(body.expectedTotal);
  if (displayedTotal === null) throw operationError("INVALID_EXPECTED_TOTAL");
  const items = normalizeAdditionItems(body.items);
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  if (!Number.isSafeInteger(total) || total < 1) throw operationError("INVALID_ITEMS");
  return { ...identity, requestId: operationId, expectedTotal: displayedTotal, items, total };
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

function publicAddition(addition = {}) {
  return {
    id: typeof addition.id === "string" ? addition.id : "",
    status: ADDITION_STATUSES.has(addition.status) ? addition.status : "expired",
    items: publicItems(addition.items),
    total: Number(addition.total) || 0,
    createdAt: addition.createdAt ?? addition.created_at ?? null,
    updatedAt: addition.updatedAt ?? addition.updated_at ?? null
  };
}

function publicOrder(order = {}) {
  const eligible = ["baru", "diproses"].includes(order.status);
  const canAddItems = typeof order.canAddItems === "boolean" ? order.canAddItems && eligible :
    typeof order.stock_reserved === "boolean" ? order.stock_reserved && eligible : undefined;
  return {
    id: order.id,
    ...queueMetadata(order),
    items: publicItems(order.items),
    total: Number(order.total),
    status: order.status,
    paymentMethod: order.paymentMethod ?? order.payment_method,
    createdAt: order.createdAt ?? order.created_at,
    updatedAt: order.updatedAt ?? order.updated_at,
    additions: (Array.isArray(order.additions) ? order.additions : []).map(publicAddition),
    ...(canAddItems === undefined ? {} : { canAddItems })
  };
}

function trackingUrl(req, id, token) {
  const relative = `/track/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  const proto = process.env.VERCEL === "1" || req.headers?.["x-forwarded-proto"] !== "http" ? "https" : "http";
  const host = req.headers?.host || "";
  return host ? `${proto}://${host}${relative}` : relative;
}

const rupiah = value => `Rp ${Number(value).toLocaleString("id-ID")}`;

function additionWhatsAppUrl(order, addition, url) {
  const pending = addition.status === "pending";
  const applied = ["applied", "approved"].includes(addition.status);
  const lines = [
    "Halo Admin Dapoer Pasta, saya ingin konfirmasi tambahan menu.",
    "",
    `No. Pesanan: *${order.id}*`,
    order.queueLabel ? `No. Antrian: *${order.queueLabel}* (${order.queueDate} WIB)` : "",
    `Referensi tambahan: ${addition.id}`,
    order.paymentMethod ? `Pembayaran: ${order.paymentMethod}` : "",
    "",
    ...addition.items.map(item => `${item.quantity}x ${item.name} — ${rupiah(item.subtotal)}`),
    `Nilai tambahan: ${rupiah(addition.total)}`,
    pending ? "*MENUNGGU PERSETUJUAN ADMIN*" : applied ? "*TAMBAHAN SUDAH MASUK KE PESANAN*" : "*TAMBAHAN TIDAK DITERAPKAN*",
    pending ? `Total pesanan saat ini: ${rupiah(order.total)} (belum termasuk tambahan).` : `*TOTAL PESANAN TERBARU: ${rupiah(order.total)}*`,
    pending ? "Tambahan belum dikonfirmasi dan belum perlu dibayar. Mohon tunggu persetujuan admin serta konfirmasi total pembayaran." : "Mohon konfirmasi total pembayaran dan ongkir terbaru ya kak.",
    `Lacak status: ${url}`
  ].filter(Boolean);
  return `https://api.whatsapp.com/send?phone=${STORE.whatsapp}&text=${encodeURIComponent(lines.join("\n"))}`;
}

const ADDITION_CONFLICTS = Object.freeze({
  ADDITION_NOT_ALLOWED: "Tambahan menu tidak dapat dilakukan pada status pesanan ini. Periksa status terbaru atau hubungi admin.",
  ADDITION_PENDING: "Masih ada tambahan yang menunggu persetujuan admin. Tunggu keputusan sebelum menambahkan menu lagi.",
  ADDITION_LIMIT: "Batas tambahan menu untuk pesanan ini sudah tercapai. Hubungi admin untuk bantuan.",
  ADDITION_ALREADY_REVIEWED: "Tambahan menu ini sudah diputuskan. Muat ulang pesanan untuk melihat keputusan terbaru.",
  INSUFFICIENT_STOCK: "Stok tambahan tidak mencukupi. Periksa stok terbaru dan sesuaikan jumlah menu.",
  REQUEST_CONFLICT: "Permintaan ini sudah digunakan untuk tambahan berbeda. Periksa riwayat tambahan sebelum mencoba lagi.",
  PRICE_CHANGED: "Harga menu berubah. Periksa total tambahan terbaru dan konfirmasi ulang.",
  ORDER_CONFLICT: "Pesanan sudah diperbarui. Muat ulang dan periksa pesanan terbaru sebelum melanjutkan."
});

module.exports = { orderId, requiredRequestId, additionRequest, publicItems, publicAddition, publicOrder,
  trackingUrl, additionWhatsAppUrl, ADDITION_CONFLICTS };
