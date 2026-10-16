(function () {
  "use strict";
  const WHATSAPP_KEY = "dapoer-order-whatsapp-v1";
  const CURRENT_KEY = "dapoer-current-order-v2";
  const SELECT_KEY = "dapoer-phone-recovery-selection-v1";
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const activeStatuses = ["baru", "diproses", "dikirim"];
  let whatsappOrder = null, currentOrder = null, volatileCurrent = false, legacyBlocked = false;
  // The current confirmation is separate from the retired homepage order history.
  try { localStorage.removeItem("dapoer-last-order-v1"); localStorage.removeItem("dapoer-pasta-last-tracking"); } catch {}
  const orderId = value => typeof value === "string" && /^DP-[A-Z0-9-]{3,80}$/.test(value);
  const tokenValue = value => typeof value === "string" && /^[a-f0-9]{48}$/i.test(value);
  const fresh = value => Number.isFinite(value) && value <= Date.now() + 60000 && Date.now() - value < MAX_AGE;
  function read(storage, key) { return JSON.parse(storage.getItem(key) || "null"); }
  function safeOrderUrl(value, path) {
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname !== path || url.username || url.password || url.hash) return null;
      if (url.searchParams.getAll("id").length !== 1 || url.searchParams.getAll("token").length !== 1 || [...url.searchParams.keys()].some(key => !["id", "token"].includes(key))) return null;
      const id = url.searchParams.get("id"), token = url.searchParams.get("token");
      return orderId(id) && tokenValue(token) ? { id, token, url: url.pathname + url.search } : null;
    } catch { return null; }
  }
  function safeWhatsApp(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "api.whatsapp.com" && !url.port && !url.username && !url.password && !url.hash && ["/send", "/send/"].includes(url.pathname) && url.searchParams.getAll("phone").length === 1 && url.searchParams.getAll("text").length <= 1 && url.searchParams.get("phone") === "6285175391181" && [...url.searchParams.keys()].every(key => ["phone", "text"].includes(key)) ? url.href : null;
    } catch { return null; }
  }
  function queueDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    try { return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null; } catch { return null; }
  }
  function validatedOrder(value) {
    const tracking = safeOrderUrl(value?.trackingUrl, "/track/");
    if (!tracking || tracking.id !== value?.id || !Number.isSafeInteger(value.total) || value.total < 1 || !fresh(value.savedAt)) return null;
    return { id: tracking.id, token: tracking.token, trackingUrl: tracking.url, total: value.total,
      queueNumber: Number.isSafeInteger(value.queueNumber) && value.queueNumber > 0 ? value.queueNumber : null,
      queueDate: queueDate(value.queueDate), savedAt: value.savedAt,
      ...(typeof value.billingKey === "string" && /^(delivery|pickup):\d+:(pending|\d+)$/.test(value.billingKey) ? { billingKey: value.billingKey } : {}) };
  }
  function billing(order) {
    if (!Number.isSafeInteger(order?.total) || order.total < 1) return null;
    const legacy = ["deliveryMethod", "itemsSubtotal", "shippingFee", "shippingConfirmed", "grandTotal"].every(key => order[key] === undefined);
    if (legacy) return { deliveryMethod: "delivery", itemsSubtotal: order.total, shippingFee: null, shippingConfirmed: false, grandTotal: null, total: order.total };
    const method = order.deliveryMethod;
    if (!["delivery", "pickup"].includes(method) || !Number.isSafeInteger(order.itemsSubtotal) || order.itemsSubtotal < 1 || typeof order.shippingConfirmed !== "boolean") return null;
    if (order.shippingConfirmed) {
      if (!Number.isSafeInteger(order.shippingFee) || order.shippingFee < 0 || !Number.isSafeInteger(order.itemsSubtotal + order.shippingFee) || order.total !== order.itemsSubtotal + order.shippingFee || order.grandTotal !== order.total || (method === "pickup" && order.shippingFee !== 0)) return null;
    } else if (method !== "delivery" || order.shippingFee !== null || order.grandTotal !== null || order.total !== order.itemsSubtotal) return null;
    return { deliveryMethod: method, itemsSubtotal: order.itemsSubtotal, shippingFee: order.shippingFee, shippingConfirmed: order.shippingConfirmed, grandTotal: order.grandTotal, total: order.total };
  }
  function billingKey(order) { const value = billing(order); return value ? `${value.deliveryMethod}:${value.itemsSubtotal}:${value.shippingConfirmed ? value.shippingFee : "pending"}` : null; }
  function sameOrder(a, b) { return !!a && !!b && a.id === b.id && a.token === b.token; }
  function compareUpdatedAt(a, b) {
    const version = value => {
      const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
      if (!Number.isFinite(milliseconds)) return null;
      const fraction = value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] || "";
      return BigInt(milliseconds) * 1000000n + BigInt(fraction.slice(3, 9).padEnd(6, "0"));
    };
    const left = version(a), right = version(b);
    return left === null || right === null || left === right ? 0 : left < right ? -1 : 1;
  }
  function validAdditions(value) {
    if (value === undefined) return true; // Orders saved before menu additions remain readable.
    if (!Array.isArray(value) || value.length > 100) return false;
    const seen = new Set(); let pending = 0;
    return value.every(addition => {
      if (!addition || typeof addition.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(addition.id) || seen.has(addition.id)
        || !["applied", "pending", "approved", "rejected", "expired"].includes(addition.status) || !Number.isSafeInteger(addition.total) || addition.total < 1
        || !Array.isArray(addition.items) || !addition.items.length || addition.items.length > 20) return false;
      seen.add(addition.id); if (addition.status === "pending" && ++pending > 1) return false;
      let total = 0;
      for (const item of addition.items) {
        if (!item || typeof item.name !== "string" || !item.name.trim() || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000000
          || !Number.isSafeInteger(item.price) || item.price < 1 || !Number.isSafeInteger(item.subtotal) || item.subtotal !== item.price * item.quantity) return false;
        total += item.subtotal;
      }
      return Number.isSafeInteger(total) && total === addition.total;
    });
  }
  function blockLegacyForCurrent(raw) {
    const identity = safeOrderUrl(raw?.trackingUrl, "/track/");
    if (!identity) return;
    try {
      const entry = read(sessionStorage, WHATSAPP_KEY);
      if (!sameOrder(entry, identity) || !safeWhatsApp(entry.url)) return;
      const hasSavedAt = Object.prototype.hasOwnProperty.call(entry, "savedAt");
      if (hasSavedAt && entry.legacyRecoveryPending !== true) return;
      if (!hasSavedAt) entry.savedAt = Date.now();
      entry.legacyRecoveryPending = false;
      sessionStorage.setItem(WHATSAPP_KEY, JSON.stringify(entry));
      if (sameOrder(whatsappOrder, identity)) whatsappOrder = entry;
    } catch {}
  }
  function getCurrent() {
    try {
      const raw = read(localStorage, CURRENT_KEY), stored = validatedOrder(raw);
      if (raw) { legacyBlocked = true; blockLegacyForCurrent(raw); }
      if (!volatileCurrent) currentOrder = stored;
    } catch {}
    currentOrder = validatedOrder(currentOrder);
    if (!currentOrder) { try { localStorage.removeItem(CURRENT_KEY); } catch {} }
    return currentOrder ? { ...currentOrder } : null;
  }
  function remember({ order, trackingUrl, whatsappUrl }) {
    const tracking = safeOrderUrl(trackingUrl, "/track/");
    if (!tracking || tracking.id !== order?.id) return null;
    if (!billing(order)) return null;
    const record = validatedOrder({ id: order.id, trackingUrl: tracking.url, total: order.total, queueNumber: order.queueNumber, queueDate: order.queueDate, savedAt: Date.now(), billingKey: billingKey(order) });
    const url = safeWhatsApp(whatsappUrl);
    if (!record || !url) return null;
    currentOrder = record; legacyBlocked = true;
    try { localStorage.setItem(CURRENT_KEY, JSON.stringify(record)); volatileCurrent = false; } catch { volatileCurrent = true; }
    whatsappOrder = { id: tracking.id, token: tracking.token, url, savedAt: record.savedAt, billingKey: billingKey(order) };
    try { sessionStorage.setItem(WHATSAPP_KEY, JSON.stringify(whatsappOrder)); } catch {}
    return { ...record };
  }
  function forget({ id, token } = {}) {
    const target = { id, token };
    if (sameOrder(getCurrent(), target)) {
      currentOrder = null; volatileCurrent = false;
      try { localStorage.removeItem(CURRENT_KEY); } catch {}
    }
    try { const stored = read(sessionStorage, WHATSAPP_KEY); if (sameOrder(stored, target)) sessionStorage.removeItem(WHATSAPP_KEY); } catch {}
    if (sameOrder(whatsappOrder, target)) whatsappOrder = null;
  }
  function selectRecovered({ id, token, expiresAt } = {}) {
    const until = Date.parse(expiresAt);
    if (!orderId(id) || !tokenValue(token) || !Number.isFinite(until) || until <= Date.now() || until > Date.now() + 11 * 60 * 1000) return false;
    const current = getCurrent();
    try { sessionStorage.setItem(SELECT_KEY, JSON.stringify({ id, token, expiresAt, previous: current ? { id: current.id, token: current.token, savedAt: current.savedAt } : null })); return true; } catch { return false; }
  }
  function adoptSelected({ id, token, order } = {}) {
    let selected;
    try { selected = read(sessionStorage, SELECT_KEY); } catch { return null; }
    if (!selected) return null;
    const until = Date.parse(selected.expiresAt);
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 11 * 60 * 1000) {
      try { sessionStorage.removeItem(SELECT_KEY); } catch {} return null;
    }
    if (!sameOrder(selected, { id, token })) return null;
    try { sessionStorage.removeItem(SELECT_KEY); } catch {}
    const current = getCurrent();
    // A new checkout created while the selected tracking request was in flight
    // must keep its own confirmation reminder.
    if (current ? !sameOrder(current, selected.previous) || current.savedAt !== selected.previous?.savedAt : !!selected.previous) return null;
    if (order?.id !== id || !activeStatuses.includes(order.status) || !billing(order) || !validAdditions(order.additions)) return null;
    const whatsappUrl = fallbackWhatsApp(id, token, order);
    return whatsappUrl ? remember({ order, trackingUrl: `/track/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`, whatsappUrl }) : null;
  }
  function fallbackWhatsApp(id, token, order) {
    if (order?.id !== id || !activeStatuses.includes(order.status) || !Number.isSafeInteger(order.total) || order.total < 1) return null;
    const amount = value => `Rp ${Number(value).toLocaleString("id-ID")}`;
    const text = value => typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 120) : "";
    const lines = ["Halo Admin Dapoer Pasta, saya ingin melanjutkan konfirmasi pesanan yang sudah tersimpan:", "", `No. Pesanan: *${id}*`];
    if (Number.isSafeInteger(order.queueNumber) && order.queueNumber > 0) lines.push(`No. Antrian: *A${String(order.queueNumber).padStart(3, "0")}*${queueDate(order.queueDate) ? ` (${order.queueDate} WIB)` : ""}`);
    if (["OVO", "ShopeePay", "DANA", "Transfer Bank"].includes(order.paymentMethod)) lines.push(`Pembayaran: ${order.paymentMethod}`);
    lines.push("");
    for (const item of (Array.isArray(order.items) ? order.items : []).slice(0, 100)) {
      if (text(item?.name) && Number.isSafeInteger(item.quantity) && item.quantity > 0) lines.push(`${text(item.name)} × ${item.quantity}`);
    }
    const charges = billing(order);
    if (!charges) return null;
    lines.push("", `Penerimaan: ${charges.deliveryMethod === "pickup" ? "Ambil sendiri" : "Diantar"}`, `Subtotal menu: ${amount(charges.itemsSubtotal)}`,
      `Ongkir: ${charges.deliveryMethod === "pickup" ? "Rp 0 (ambil sendiri)" : charges.shippingConfirmed ? amount(charges.shippingFee) : "Menunggu konfirmasi admin"}`,
      charges.shippingConfirmed ? `*TOTAL PESANAN: ${amount(charges.total)}*` : `*TOTAL PESANAN: ${amount(charges.itemsSubtotal)} (belum termasuk ongkir)*`);
    const pending = Array.isArray(order.additions) ? order.additions.filter(item => item?.status === "pending") : [];
    for (const addition of pending) {
      lines.push("", "*PERMINTAAN TAMBAHAN — MENUNGGU PERSETUJUAN ADMIN*");
      for (const item of (Array.isArray(addition.items) ? addition.items : []).slice(0, 20)) {
        if (text(item?.name) && Number.isSafeInteger(item.quantity) && item.quantity > 0) lines.push(`${text(item.name)} × ${item.quantity}`);
      }
      if (Number.isSafeInteger(addition.total) && addition.total > 0) lines.push(`Subtotal tambahan: ${amount(addition.total)} (belum masuk total pesanan dan belum perlu dibayar)`);
    }
    lines.push("", charges.deliveryMethod === "pickup" ? "Data pemesan sudah tersimpan. Saya akan mengambil pesanan sendiri." : "Data pemesan dan alamat sudah diisi pada pesanan ini.", `Lacak status: ${window.location.origin}/track/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`, "", "Mohon periksa pesanan dan konfirmasi total pembayarannya ya kak.");
    return `https://api.whatsapp.com/send?phone=6285175391181&text=${encodeURIComponent(lines.join("\n"))}`;
  }
  function loadWhatsAppOrder() {
    if (!whatsappOrder) {
      try {
        whatsappOrder = read(sessionStorage, WHATSAPP_KEY);
        // Existing tabs can retain their original confirmation after this upgrade.
        // Attach the lifetime once; subsequent reads cannot renew an expired entry.
        if (orderId(whatsappOrder?.id) && tokenValue(whatsappOrder?.token) && safeWhatsApp(whatsappOrder?.url) && !Object.prototype.hasOwnProperty.call(whatsappOrder,"savedAt")) {
          whatsappOrder.savedAt = Date.now();
          whatsappOrder.legacyRecoveryPending = !legacyBlocked;
          sessionStorage.setItem(WHATSAPP_KEY, JSON.stringify(whatsappOrder));
        }
      } catch {}
    }
    if (whatsappOrder && !fresh(whatsappOrder.savedAt)) {
      const expired = whatsappOrder;
      whatsappOrder = null;
      try {
        const stored = read(sessionStorage, WHATSAPP_KEY);
        if (sameOrder(stored, expired) && stored.savedAt === expired.savedAt) sessionStorage.removeItem(WHATSAPP_KEY);
      } catch {}
    }
    return whatsappOrder;
  }
  function getLegacyReference() {
    if (getCurrent() || legacyBlocked) return null;
    const entry = loadWhatsAppOrder();
    return entry?.legacyRecoveryPending === true && orderId(entry.id) && tokenValue(entry.token) && safeWhatsApp(entry.url) && fresh(entry.savedAt)
      ? { id: entry.id, token: entry.token, savedAt: entry.savedAt } : null;
  }
  function recoverLegacy({ id, token, order } = {}) {
    const reference = getLegacyReference();
    if (!sameOrder(reference, { id, token }) || order?.id !== id || !activeStatuses.includes(order.status)) return null;
    const record = validatedOrder({ id, trackingUrl: `/track/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`, total: order.total, queueNumber: order.queueNumber, queueDate: order.queueDate, savedAt: reference.savedAt });
    if (!record) return null;
    currentOrder = record; legacyBlocked = true;
    try { localStorage.setItem(CURRENT_KEY, JSON.stringify(record)); volatileCurrent = false; } catch { volatileCurrent = true; }
    delete whatsappOrder.legacyRecoveryPending;
    try { sessionStorage.setItem(WHATSAPP_KEY, JSON.stringify(whatsappOrder)); } catch {}
    return { ...record };
  }
  function getWhatsAppUrl({ id, token, order } = {}) {
    if (!orderId(id) || !tokenValue(token)) return null;
    if (order && (order.id !== id || !activeStatuses.includes(order.status) || !billing(order) || !validAdditions(order.additions))) return null;
    if (order) syncOrder({ id, token, order });
    loadWhatsAppOrder();
    if (sameOrder(whatsappOrder, { id, token }) && fresh(whatsappOrder.savedAt)) return safeWhatsApp(whatsappOrder.url) || (order ? fallbackWhatsApp(id, token, order) : null);
    return order ? fallbackWhatsApp(id, token, order) : null;
  }
  function syncOrder({ id, token, order } = {}) {
    if (!orderId(id) || !tokenValue(token) || order?.id !== id || !activeStatuses.includes(order.status) || !billing(order) || !validAdditions(order.additions)) return null;
    const previous = getCurrent();
    if (sameOrder(previous, { id, token })) {
      const record = validatedOrder({ ...previous, total: order.total, queueNumber: order.queueNumber, queueDate: order.queueDate, billingKey: billingKey(order) });
      if (record && JSON.stringify(record) !== JSON.stringify(previous)) {
        currentOrder = record;
        try { localStorage.setItem(CURRENT_KEY, JSON.stringify(record)); volatileCurrent = false; } catch { volatileCurrent = true; }
      }
    }
    // Original checkout messages include the old total. Once an addition exists,
    // always build WhatsApp from the verified current order, including pending requests.
    let savedWhatsApp = whatsappOrder;
    try { savedWhatsApp = read(sessionStorage, WHATSAPP_KEY) || savedWhatsApp; } catch {}
    const changedBilling = order.deliveryMethod !== undefined && ((sameOrder(previous, { id, token }) && previous.billingKey !== billingKey(order)) || (sameOrder(savedWhatsApp, { id, token }) && savedWhatsApp.billingKey !== billingKey(order)));
    if ((Array.isArray(order.additions) && order.additions.length) || changedBilling || (sameOrder(previous, { id, token }) && previous.total !== order.total)) {
      if (sameOrder(whatsappOrder, { id, token })) whatsappOrder = null;
      try { if (sameOrder(read(sessionStorage, WHATSAPP_KEY), { id, token })) sessionStorage.removeItem(WHATSAPP_KEY); } catch {}
    }
    return sameOrder(currentOrder, { id, token }) ? { ...currentOrder } : null;
  }
  window.DapoerOrderRecovery = Object.freeze({ remember, getCurrent, getLegacyReference, recoverLegacy, forget, selectRecovered, adoptSelected, getWhatsAppUrl, syncOrder, validAdditions, billing, compareUpdatedAt, safeOrderUrl, safeWhatsApp, currentKey: CURRENT_KEY });
}());
