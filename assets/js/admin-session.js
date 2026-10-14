(() => {
  "use strict";
  const KEY = "dapoer-admin-session-v1";
  const listeners = new Set();
  const seen = new Set();
  let channel;
  try { if (typeof BroadcastChannel === "function") channel = new BroadcastChannel(KEY); } catch {}
  function receive(event) {
    if (!event || event.authenticated !== false || typeof event.id !== "string" || seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 100) seen.delete(seen.values().next().value);
    listeners.forEach(listener => { try { listener(event); } catch {} });
    document.dispatchEvent(new CustomEvent("dapoer:admin-session", { detail: event }));
  }
  if (channel) channel.addEventListener("message", event => receive(event.data));
  window.addEventListener("storage", event => {
    if (event.key !== KEY || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch {}
  });
  window.DapoerAdminSession = Object.freeze({
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notifyLogout(reason = "logout") {
      const event = { authenticated: false, reason, at: Date.now(), id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}` };
      receive(event);
      try { localStorage.setItem(KEY, JSON.stringify(event)); } catch {}
      try { channel?.postMessage(event); } catch {}
    }
  });
})();
