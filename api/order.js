const crypto = require("node:crypto");
const { STORE, PRODUCTS } = require("./_lib/catalog");
const { saveOrder, requestOrderAddition } = require("./_lib/db");
const { guardRequest } = require("./_lib/security");
const { queueMetadata } = require("./_lib/order-queue");
const { requestId, expectedTotal } = require("./_lib/operations");
const { normalizeDeliveryMethod, fulfillmentMetadata } = require("./_lib/fulfillment");
const { additionRequest, publicAddition, publicOrder, trackingUrl: additionTrackingUrl,
  additionWhatsAppUrl, ADDITION_CONFLICTS } = require("./_lib/order-additions");

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
  const deliveryMethod = normalizeDeliveryMethod(input?.deliveryMethod);
  const name = cleanText(input?.name, 80);
  const phone = cleanText(input?.phone, 24).replace(/[^0-9+\- ()]/g, "");
  const address = deliveryMethod === "pickup" ? "" : cleanText(input?.address, 500);
  const notes = cleanText(input?.notes, 300);
  const paymentMethod = cleanText(input?.paymentMethod, 30);

  if (name.length < 2 || phone.replace(/\D/g, "").length < 8 || (deliveryMethod === "delivery" && address.length < 5)) {
    throw new Error("INVALID_CUSTOMER");
  }
  if (!STORE.paymentMethods.includes(paymentMethod)) {
    throw new Error("INVALID_PAYMENT");
  }

  return { name, phone, address, notes, paymentMethod, deliveryMethod };
}

const rupiah = (value) => `Rp ${Number(value).toLocaleString("id-ID")}`;

function createOrderId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `DP-${stamp}-${suffix}`;
}

function buildMessage(order, trackingUrl) {
  const fulfillment = fulfillmentMetadata(order);
  const lines = [
    "Halo Admin Dapoer Pasta, saya mau pesan:",
    "",
    `No. Pesanan: *${order.id}*`,
    order.queueLabel ? `No. Antrian: *${order.queueLabel}* (${order.queueDate} WIB)` : "",
    `Nama: *${order.customer.name}*`,
    `WhatsApp: ${order.customer.phone}`,
    `Penerimaan: ${fulfillment.deliveryMethod === "pickup" ? "Ambil sendiri" : "Diantar"}`,
    fulfillment.deliveryMethod === "delivery" ? `Alamat: ${order.customer.address}` : "",
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
    `Subtotal menu: ${rupiah(fulfillment.itemsSubtotal)}`,
    fulfillment.deliveryMethod === "pickup" ? "Ongkir: Rp 0 (ambil sendiri)" : fulfillment.shippingConfirmed
      ? `Ongkir: ${rupiah(fulfillment.shippingFee)}` : "Ongkir: menunggu konfirmasi admin",
    fulfillment.shippingConfirmed ? `*TOTAL AKHIR: ${rupiah(fulfillment.grandTotal)}*`
      : `*TOTAL PESANAN: ${rupiah(fulfillment.itemsSubtotal)} (belum termasuk ongkir)*`,
    "",
    trackingUrl ? `Lacak status: ${trackingUrl}` : "",
    "",
    fulfillment.deliveryMethod === "pickup" ? "_Mohon konfirmasi pesanan dan waktu pengambilan ya kak._"
      : "_Mohon konfirmasi pesanan dan info ongkirnya ya kak._"
  );

  return lines.join("\n");
}

async function addItems(req, res) {
  let input;
  try {
    input = additionRequest(req.body);
  } catch (error) {
    return res.status(400).json({ code: error.code || "INVALID_ADDITION", error: "Data tambahan menu tidak valid. Muat ulang pesanan dan periksa jumlah menu." });
  }
  try {
    const result = await requestOrderAddition(input);
    if (!result) return res.status(404).json({ error: "Pesanan tidak ditemukan." });
    const addition = publicAddition(result.addition);
    const order = publicOrder(result.order);
    if (!order.additions.some(item => item.id === addition.id)) order.additions.push(addition);
    const trackingUrl = additionTrackingUrl(req, input.id, input.trackingToken);
    const whatsappUrl = additionWhatsAppUrl(order, addition, trackingUrl);
    return res.status(200).json({ addition, order, persisted: true, trackingUrl, whatsappUrl });
  } catch (error) {
    const code = error?.code || error?.message;
    if (ADDITION_CONFLICTS[code]) {
      return res.status(409).json({ code, error: ADDITION_CONFLICTS[code],
        ...(code === "PRICE_CHANGED" ? { items: input.items, total: input.total } : {}) });
    }
    if (code === "ADDITION_NOT_FOUND") return res.status(404).json({ code, error: "Tambahan menu tidak ditemukan." });
    console.error("Order addition failed");
    return res.status(503).json({ error: "Tambahan menu belum dapat disimpan. Coba lagi dengan permintaan yang sama agar tidak terduplikasi." });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!(await guardRequest(req, res, { scope: "order", methods: ["POST"] }))) return;

  if (req.body?.action === "add-items") return addItems(req, res);
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, "action")) {
    return res.status(400).json({ code: "INVALID_ACTION", error: "Tindakan pesanan tidak valid." });
  }

  let items;
  let customer;
  let operationId;
  let displayedTotal;
  try {
    operationId = requestId(req.body?.requestId);
    displayedTotal = expectedTotal(req.body?.expectedTotal);
    items = normalizeItems(req.body?.items);
    customer = normalizeCustomer(req.body?.customer);
  } catch (error) {
    if (["INVALID_REQUEST_ID", "INVALID_EXPECTED_TOTAL"].includes(error?.code)) {
      return res.status(400).json({ code: error.code, error: "Data konfirmasi checkout tidak valid. Muat ulang halaman dan coba lagi." });
    }
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
    deliveryMethod: customer.deliveryMethod,
    items,
    total,
    requestId: operationId,
    expectedTotal: displayedTotal
  };

  let persisted = false;
  try {
    persisted = await saveOrder(order);
  } catch (error) {
    if (error.code === "REQUEST_CONFLICT") {
      return res.status(409).json({ code: error.code, error: "Permintaan ini sudah digunakan untuk pesanan berbeda. Periksa pesanan sebelumnya sebelum membuat pesanan baru." });
    }
    if (error.code === "PRICE_CHANGED") {
      return res.status(409).json({ code: error.code, error: "Harga menu berubah. Periksa total terbaru dan konfirmasi ulang sebelum memesan.", items, total });
    }
    if (error.code === "INSUFFICIENT_STOCK") {
      return res.status(409).json({
        code: "INSUFFICIENT_STOCK",
        error: "Stok pesanan tidak mencukupi. Periksa stok terbaru dan sesuaikan jumlah di keranjang."
      });
    }
    console.error("Order database save failed");
    return res.status(503).json({
      error: "Pesanan belum dapat disimpan. Silakan coba lagi beberapa saat."
    });
  }

  if (!persisted) {
    return res.status(503).json({
      error: "Database pesanan belum terhubung. Pesanan belum disimpan dan tracking belum dibuat."
    });
  }

  const relativeTrackingUrl = `/track/?id=${encodeURIComponent(order.id)}&token=${encodeURIComponent(order.trackingToken)}`;
  const proto = process.env.VERCEL === "1" || req.headers["x-forwarded-proto"] !== "http" ? "https" : "http";
  const host = req.headers.host || "";
  const trackingUrl = host ? `${proto}://${host}${relativeTrackingUrl}` : relativeTrackingUrl;
  const message = buildMessage(order, trackingUrl);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=${STORE.whatsapp}&text=${encodeURIComponent(message)}`;

  return res.status(200).json({
    order: { id: order.id, items: order.items, total: order.total, customer: order.customer,
      ...queueMetadata(order), ...fulfillmentMetadata(order) },
    persisted,
    whatsappUrl,
    trackingUrl
  });
};
