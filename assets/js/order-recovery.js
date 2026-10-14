(function () {
  "use strict";
  const WHATSAPP_KEY = "dapoer-order-whatsapp-v1";
  let whatsappOrder = null;
  // Remove metadata from the retired homepage order-history feature.
  try { localStorage.removeItem("dapoer-last-order-v1"); localStorage.removeItem("dapoer-pasta-last-tracking"); } catch {}
  const orderId = value => typeof value === "string" && /^DP-[A-Z0-9-]{3,80}$/.test(value);
  const tokenValue = value => typeof value === "string" && /^[a-f0-9]{48}$/i.test(value);
  function read(storage, key) { try { return JSON.parse(storage.getItem(key) || "null"); } catch { return null; } }
  function write(storage, key, value) { try { storage.setItem(key, JSON.stringify(value)); } catch {} }
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
      return url.protocol === "https:" && url.hostname === "api.whatsapp.com" && !url.port && !url.username && !url.password && !url.hash && ["/send", "/send/"].includes(url.pathname) && url.searchParams.getAll("phone").length === 1 && url.searchParams.get("phone") === "6285175391181" && [...url.searchParams.keys()].every(key => ["phone", "text"].includes(key)) ? url.href : null;
    } catch { return null; }
  }
  function validatedOrder(value) {
    const tracking = safeOrderUrl(value?.trackingUrl, "/track/");
    if (!tracking || tracking.id !== value?.id) return null;
    return { id: tracking.id, trackingUrl: tracking.url, receiptUrl: `/nota/?id=${encodeURIComponent(tracking.id)}&token=${encodeURIComponent(tracking.token)}`, queueNumber: Number.isSafeInteger(value.queueNumber) && value.queueNumber > 0 ? value.queueNumber : null, queueDate: /^\d{4}-\d{2}-\d{2}$/.test(value.queueDate || "") ? value.queueDate : null };
  }
  function remember({ order, trackingUrl, whatsappUrl }) {
    const tracking = safeOrderUrl(trackingUrl, "/track/");
    if (!tracking || tracking.id !== order?.id) return null;
    const record = validatedOrder({ id: order.id, trackingUrl: tracking.url, queueNumber: order.queueNumber, queueDate: order.queueDate });
    const url = safeWhatsApp(whatsappUrl);
    if (url) {
      whatsappOrder = { id: tracking.id, token: tracking.token, url };
      try { write(sessionStorage, WHATSAPP_KEY, whatsappOrder); } catch {}
    }
    return record;
  }
  function getWhatsAppUrl({ id, token } = {}) {
    if (!orderId(id) || !tokenValue(token)) return null;
    if (!whatsappOrder) { try { whatsappOrder = read(sessionStorage, WHATSAPP_KEY); } catch {} }
    return whatsappOrder?.id === id && whatsappOrder?.token === token ? safeWhatsApp(whatsappOrder.url) : null;
  }
  window.DapoerOrderRecovery = Object.freeze({ remember, getWhatsAppUrl, safeOrderUrl, safeWhatsApp });
}());
