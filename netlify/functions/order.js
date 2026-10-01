const { STORE, PRODUCTS } = require("./_lib/catalog");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...HEADERS, ...extraHeaders },
    body: JSON.stringify(payload)
  };
}

function normalizeItems(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    throw new Error("INVALID_ITEMS");
  }

  const byId = new Map(PRODUCTS.map((product) => [product.id, product]));
  const merged = new Map();

  for (const raw of input) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const quantity = Number(raw?.quantity);
    const product = byId.get(id);

    if (!product || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("INVALID_ITEM");
    }

    const nextQuantity = (merged.get(id) || 0) + quantity;
    if (!Number.isSafeInteger(nextQuantity)) throw new Error("INVALID_QUANTITY");
    merged.set(id, nextQuantity);
  }

  return [...merged.entries()].map(([id, quantity]) => {
    const product = byId.get(id);
    return {
      id: product.id,
      name: product.name,
      price: product.price,
      quantity,
      subtotal: product.price * quantity
    };
  });
}

function rupiah(value) {
  return `Rp ${Number(value).toLocaleString("id-ID")}`;
}

function createOrderId() {
  return `DP-${Date.now().toString(36).toUpperCase()}`;
}

function buildWhatsAppMessage(orderId, items, total) {
  const lines = [
    "Halo Admin Dapoer Pasta, saya mau pesan:",
    "",
    `No. Pesanan: *${orderId}*`,
    ""
  ];

  items.forEach((item, index) => {
    lines.push(
      `${index + 1}. *${item.name}*`,
      `Jumlah: ${item.quantity}`,
      `Subtotal: ${rupiah(item.subtotal)}`,
      ""
    );
  });

  lines.push(
    `*TOTAL PESANAN: ${rupiah(total)}*`,
    "",
    "Nama Pemesan:",
    "Alamat Pengiriman:",
    "Metode Pembayaran: (OVO / ShopeePay / DANA)",
    "",
    "_Mohon info ongkirnya ya kak._"
  );

  return lines.join("\n");
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...HEADERS, Allow: "POST, OPTIONS" }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Metode tidak diizinkan." }, { Allow: "POST, OPTIONS" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Format pesanan tidak valid." });
  }

  let items;
  try {
    items = normalizeItems(payload.items);
  } catch {
    return json(400, { error: "Isi keranjang tidak valid." });
  }

  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  const orderId = createOrderId();
  const message = buildWhatsAppMessage(orderId, items, total);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=${STORE.whatsapp}&text=${encodeURIComponent(message)}`;

  return json(200, {
    order: {
      id: orderId,
      items,
      total
    },
    whatsappUrl
  });
};
