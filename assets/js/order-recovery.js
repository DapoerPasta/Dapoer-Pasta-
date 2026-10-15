(function () {
  "use strict";
  const WHATSAPP_KEY = "dapoer-order-whatsapp-v1";
  const CURRENT_KEY = "dapoer-current-order-v2";
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
      queueDate: queueDate(value.queueDate), savedAt: value.savedAt };
  }
  function sameOrder(a, b) { return !!a && !!b && a.id === b.id && a.token === b.token; }
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
    const record = validatedOrder({ id: order.id, trackingUrl: tracking.url, total: order.total, queueNumber: order.queueNumber, queueDate: order.queueDate, savedAt: Date.now() });
    const url = safeWhatsApp(whatsappUrl);
    if (!record || !url) return null;
    currentOrder = record; legacyBlocked = true;
    try { localStorage.setItem(CURRENT_KEY, JSON.stringify(record)); volatileCurrent = false; } catch { volatileCurrent = true; }
    whatsappOrder = { id: tracking.id, token: tracking.token, url, savedAt: record.savedAt };
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
  function fallbackWhatsApp(id, token, order) {
    if (order?.id !== id || !activeStatuses.includes(order.status) || !Number.isSafeInteger(order.total) || order.total < 1) return null;
    const amount = value => `Rp ${Number(value).toLocaleString("id-ID")}`;
    const text = value => typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 120) : "";
    const lines = ["Halo Admin Dapoer Pasta, saya ingin melanjutkan konfirmasi pesanan yang sudah tersimpan:", "", `No. Pesanan: *${id}*`];
    if (Number.isSafeInteger(order.queueNumber) && order.queueNumber > 0) lines.push(`No. Antrian: *A${String(order.queueNumber).padStart(3, "0")}*${queueDate(order.queueDate) ? ` (${order.queueDate} WIB)` : ""}`);
    if (["OVO", "ShopeePay", "DANA", "Transfer Bank"].includes(order.paymentMethod)) lines.push(`Pembayaran: ${order.paymentMethod}`);
    lines.push("");
    for (const item of (Array.isArray(order.items) ? order.items : []).slice(0, 50)) {
      if (text(item?.name) && Number.isSafeInteger(item.quantity) && item.quantity > 0) lines.push(`${text(item.name)} × ${item.quantity}`);
    }
    lines.push("", `*TOTAL PESANAN: ${amount(order.total)}*`, "Data pemesan dan alamat sudah diisi pada pesanan ini.", `Lacak status: ${window.location.origin}/track/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`, "", "Mohon periksa pesanan dan konfirmasi pembayaran serta ongkirnya ya kak.");
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
    if (order && (order.id !== id || !activeStatuses.includes(order.status) || !Number.isSafeInteger(order.total) || order.total < 1)) return null;
    loadWhatsAppOrder();
    if (sameOrder(whatsappOrder, { id, token }) && fresh(whatsappOrder.savedAt)) return safeWhatsApp(whatsappOrder.url) || (order ? fallbackWhatsApp(id, token, order) : null);
    return order ? fallbackWhatsApp(id, token, order) : null;
  }
  window.DapoerOrderRecovery = Object.freeze({ remember, getCurrent, getLegacyReference, recoverLegacy, forget, getWhatsAppUrl, safeOrderUrl, safeWhatsApp, currentKey: CURRENT_KEY });
}());
