const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ID = "DP-20261014-RELIABLE", TOKEN = "a".repeat(48);
const asset = name => fs.readFileSync(path.join(__dirname, "../assets/js", name), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(extra = {}) {
  return {
    id: ID, createdAt: "2026-10-13T17:01:00.000Z", updatedAt: "2026-10-13T17:01:00.000Z",
    status: "baru", queueNumber: 1, queueDate: "2026-10-14",
    items: [{ name: "Pasta", quantity: 2, price: 37000, subtotal: 74000 }],
    total: 74000, paymentMethod: "Transfer Bank", customerDataProtected: false,
    customerName: "PRIVATE_NAME", customerPhone: "PRIVATE_PHONE", address: "PRIVATE_ADDRESS", notes: "PRIVATE_NOTES",
    ...extra
  };
}
function host(kind, options = {}) {
  function events(target) {
    const listeners = new Map();
    target.addEventListener = (name, callback) => { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); };
    target.emit = (name, event = {}) => listeners.get(name)?.forEach(callback => callback(event));
    target.dispatchEvent = event => target.emit(event.type, event);
    return target;
  }
  function element() {
    return events({
      textContent: "", hidden: false, disabled: false, dataset: {}, value: "80", children: [],
      append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); },
      replaceChildren(...nodes) { this.children = nodes; }, removeAttribute(name) { delete this[name]; },
      setAttribute(name, value) { this[name] = value; }, remove() {}, click() { this.emit("click"); },
      classList: { toggle() {} }
    });
  }
  const nodes = new Map(), timers = new Map(), requests = [], prints = [], downloads = [], exportedBlobs = [];
  let timerId = 0, sessionListener;
  const body = element();
  const document = events({
    body, hidden: false, title: "", createElement: element,
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    querySelectorAll() { return []; }
  });
  const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
  const context = vm.createContext(events({
    document, console, URL, URLSearchParams, AbortController, DOMException, Date, Intl, Blob,
    navigator: { onLine: true }, localStorage: storage(), sessionStorage: storage(),
    location: { origin: "https://dapoer.example", search: "?id=" + ID + (options.token ? "&token=" + TOKEN : "") },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, request) => {
      const entry = { url, signal: request.signal }; requests.push(entry);
      if (options.fetch) return options.fetch(entry, requests.length);
      return { ok: true, status: 200, json: async () => ({ order: fixture(options.protected ? { customerDataProtected: true } : {}) }) };
    },
    CustomEvent: class { constructor(type, details) { this.type = type; this.detail = details?.detail; } },
    DapoerAdminSession: { subscribe(callback) { sessionListener = callback; } }
  }));
  context.window = context;
  context.print = () => {
    context.emit("beforeprint");
    prints.push({ name: nodes.get("#receipt-customer").textContent, grant: body.dataset.privatePrintAuthorized, ready: body.dataset.receiptReady });
    context.emit("afterprint");
  };
  vm.runInContext(asset("receipt-print-files.js"), context);
  // The production normalizer is immutable; only replace the writer boundary.
  const original = context.DapoerReceiptPrint;
  context.DapoerReceiptPrint = { ...original, build: async (order, requestOptions) => {
    downloads.push({ order, signal: requestOptions.signal });
    if (requestOptions.signal.aborted) throw new DOMException("Aborted", "AbortError");
    return options.build ? options.build(order, requestOptions) : { blob: new Blob(["PDF"]), filename: "receipt.pdf" };
  } };
  context.URL = class extends URL {};
  context.URL.createObjectURL = blob => { exportedBlobs.push(blob); return "blob:receipt"; };
  context.URL.revokeObjectURL = () => {};
  if (kind === "track") vm.runInContext(asset("order-recovery.js"), context);
  vm.runInContext(asset(kind + ".js"), context);
  return {
    context, document, body, nodes, requests, prints, downloads, exportedBlobs, timers,
    node: selector => document.querySelector(selector),
    start: () => document.emit("DOMContentLoaded"),
    logout: () => sessionListener({ authenticated: false, reason: "logout" }),
    tick(delay) {
      const found = [...timers].find(([, timer]) => timer.delay === delay);
      if (!found) return false;
      timers.delete(found[0]); found[1].callback(); return true;
    }
  };
}

test("logout synchronously scrubs all private receipt fields and aborts pending print revalidation", async () => {
  const held = deferred();
  const view = host("receipt", { fetch: async (_, count) => count === 1
    ? { ok: true, json: async () => ({ order: fixture() }) }
    : held.promise });
  view.start(); await flush();
  assert.equal(view.node("#receipt-customer").textContent, "PRIVATE_NAME");
  view.node("#print-receipt").emit("click");
  assert.equal(view.requests.length, 2);
  view.logout();
  assert.equal(view.body.dataset.receiptReady, "false");
  assert.equal(view.requests[1].signal.aborted, true);
  for (const key of ["customer", "phone", "address", "notes"]) assert.equal(view.node("#receipt-" + key).textContent, "—");
  held.resolve({ ok: true, json: async () => ({ order: fixture() }) });
  await flush();
  assert.equal(view.prints.length, 0);
  assert.equal(view.body.dataset.receiptReady, "false");
});

test("native private printing clears immediately; application printing obtains one bounded authorization grant", async () => {
  const view = host("receipt");
  view.start(); await flush();
  view.context.emit("beforeprint");
  assert.equal(view.node("#receipt-customer").textContent, "—");
  assert.equal(view.body.dataset.receiptReady, "false");
  assert.equal(view.requests.length, 1, "native print cannot await or restore private data during preview");
  view.context.emit("afterprint"); await flush();
  assert.equal(view.requests.length, 2);
  assert.equal(view.node("#receipt-customer").textContent, "PRIVATE_NAME");
  view.node("#print-receipt").emit("click"); await flush();
  assert.equal(view.requests.length, 3);
  assert.deepEqual(view.prints, [{ name: "PRIVATE_NAME", grant: "true", ready: "true" }]);
  assert.equal(view.body.dataset.privatePrintAuthorized, "false");
});

test("a receipt hidden then refocused revalidates and replaces expired admin identity with the protected public view", async () => {
  let authenticated = true;
  const view = host("receipt", { token: true, fetch: async () => ({
    ok: true, json: async () => ({ order: fixture({ customerDataProtected: !authenticated }) })
  }) });
  view.start(); await flush();
  view.document.hidden = true; view.document.emit("visibilitychange");
  assert.equal(view.node("#receipt-customer").textContent, "—");
  authenticated = false;
  view.context.emit("focus"); await flush();
  assert.equal(view.requests.length, 1);
  view.document.hidden = false; view.document.emit("visibilitychange"); view.context.emit("focus");
  await flush();
  assert.equal(view.requests.length, 2, "visibility/focus share the same in-flight validation");
  assert.equal(view.body.dataset.customerProtected, "true");
  assert.equal(view.node("#receipt-phone").textContent, "Dilindungi");
  assert.doesNotMatch(JSON.stringify([...view.nodes.values()].map(node => node.textContent)), /PRIVATE_/);
  view.node("#print-receipt").emit("click"); await flush();
  assert.equal(view.prints.length, 1);
  assert.equal(view.prints[0].name, "Data pelanggan dilindungi");
});

test("a stale initial private response cannot restore a receipt after session logout", async () => {
  const held = deferred(), view = host("receipt", { fetch: () => held.promise });
  view.start(); view.logout();
  assert.equal(view.requests[0].signal.aborted, true);
  held.resolve({ ok: true, json: async () => ({ order: fixture() }) });
  await flush();
  assert.equal(view.body.dataset.receiptReady, "false");
  assert.equal(view.node("#receipt-customer").textContent, "—");
});

test("logout during private PDF generation aborts the export without a download or another authorization read", async () => {
  const held = deferred(), view = host("receipt", { build: () => held.promise });
  view.start(); await flush();
  view.node("#download-receipt-pdf").emit("click"); await flush();
  assert.equal(view.downloads.length, 1);
  assert.equal(view.requests.length, 2);
  view.logout();
  assert.equal(view.downloads[0].signal.aborted, true);
  assert.equal(view.node("#receipt-customer").textContent, "—");
  held.resolve({ blob: new Blob(["private PDF"]), filename: "private.pdf" }); await flush();
  assert.equal(view.exportedBlobs.length, 0);
  assert.equal(view.requests.length, 2);
  assert.equal(view.body.dataset.receiptReady, "false");
});

test("public receipt native printing remains available without an admin authorization grant", async () => {
  const view = host("receipt", { token: true, protected: true });
  view.start(); await flush(); view.context.emit("beforeprint");
  assert.equal(view.body.dataset.receiptReady, "true");
  assert.equal(view.node("#receipt-customer").textContent, "Data pelanggan dilindungi");
  assert.equal(view.requests.length, 1);
});

test("tracking preserves the last successful update on transient failures and recovers after retry", async () => {
  let failing = false;
  const view = host("track", { token: true, fetch: async () => ({
    ok: !failing, status: failing ? 503 : 200,
    json: async () => failing ? { error: "Koneksi sedang terganggu." } : { order: fixture({ status: "diproses" }) }
  }) });
  view.start(); await flush();
  assert.equal(view.node("#track-status").textContent, "diproses");
  failing = true; assert.equal(view.tick(8000), true); await flush();
  assert.equal(view.node("#track-content").hidden, false);
  assert.equal(view.node("#track-status").textContent, "diproses");
  assert.match(view.node("#track-sync").textContent, /pembaruan terakhir/);
  assert.equal(view.node("#track-error").hidden, true);
  failing = false; view.node("#track-retry").emit("click"); await flush();
  assert.equal(view.node("#track-sync").hidden, true);
  assert.equal(view.requests.length, 3);
});

test("tracking coalesces refreshes, pauses hidden tabs, and discards aborted stale responses", async () => {
  const held = deferred();
  const view = host("track", { token: true, fetch: (_, count) => count === 1 ? held.promise : Promise.resolve({
    ok: true, status: 200, json: async () => ({ order: fixture({ status: "dikirim" }) })
  }) });
  view.start(); view.context.emit("online"); view.context.emit("online");
  assert.equal(view.requests.length, 1);
  view.document.hidden = true; view.document.emit("visibilitychange");
  assert.equal(view.requests[0].signal.aborted, true);
  view.context.emit("online");
  assert.equal(view.requests.length, 1);
  assert.equal(view.tick(8000), false);
  view.document.hidden = false; view.document.emit("visibilitychange"); await flush();
  assert.equal(view.requests.length, 2);
  assert.equal(view.node("#track-status").textContent, "dikirim");
  held.resolve({ ok: true, status: 200, json: async () => ({ order: fixture({ status: "baru" }) }) }); await flush();
  assert.equal(view.node("#track-status").textContent, "dikirim");
  assert.equal([...view.timers.values()].filter(timer => timer.delay === 8000).length, 1);
});

test("tracking WhatsApp recovery appears only after a successful matching order with a safe session URL", async () => {
  const view = host("track", { token: true });
  const whatsapp = "https://api.whatsapp.com/send/?phone=6285175391181&text=Saved%20order";
  view.context.DapoerOrderRecovery.remember({ order: fixture(), trackingUrl: "/track/?id=" + ID + "&token=" + TOKEN, whatsappUrl: whatsapp });
  view.start(); await flush();
  assert.equal(view.node("#track-whatsapp-recovery").hidden, false);
  assert.equal(view.node("#track-whatsapp-link").href, whatsapp);
  const mismatch = host("track", { token: true });
  mismatch.context.DapoerOrderRecovery.remember({ order: fixture({ id: "DP-OTHER-ORDER" }), trackingUrl: "/track/?id=DP-OTHER-ORDER&token=" + TOKEN, whatsappUrl: whatsapp });
  mismatch.start(); await flush();
  assert.equal(mismatch.node("#track-whatsapp-recovery").hidden, true);
  assert.equal(mismatch.node("#track-whatsapp-link").href, undefined);
  const cancelled = host("track", { token: true, fetch: async () => ({ ok: true, status: 200, json: async () => ({ order: fixture({ status: "dibatalkan" }) }) }) });
  cancelled.context.DapoerOrderRecovery.remember({ order: fixture(), trackingUrl: "/track/?id=" + ID + "&token=" + TOKEN, whatsappUrl: whatsapp });
  cancelled.start(); await flush();
  assert.equal(cancelled.node("#track-whatsapp-recovery").hidden, true);
  assert.equal(cancelled.node("#track-whatsapp-link").href, undefined);
});

test("tracking rejects a different order and removes recovery and displayed content on a revoked token", async () => {
  const different = host("track", { token: true, fetch: async () => ({ ok: true, status: 200, json: async () => ({ order: fixture({ id: "DP-DIFFERENT-ORDER" }) }) }) });
  different.start(); await flush();
  assert.equal(different.node("#track-content").hidden, true);
  assert.equal(different.node("#track-error").hidden, false);
  assert.equal(different.tick(8000), false);
  let valid = true;
  const view = host("track", { token: true, fetch: async () => ({
    ok: valid, status: valid ? 200 : 404, json: async () => valid ? { order: fixture() } : { error: "Pesanan tidak ditemukan." }
  }) });
  view.start(); await flush(); valid = false; view.tick(8000); await flush();
  assert.equal(view.node("#track-content").hidden, true);
  assert.equal(view.node("#track-whatsapp-recovery").hidden, true);
  assert.equal(view.tick(8000), false, "revoked links do not continue polling");
});

test("tracking renders immediately without the QR library and adds a late QR without another API read", async () => {
  const view = host("track", { token: true });
  view.start(); await flush();
  assert.equal(view.node("#track-content").hidden, false);
  assert.equal(view.node("#receipt-qr").hidden, true);
  assert.equal(view.node("#receipt-qr-title").textContent, "Buka nota pesanan");
  const qrCalls = [];
  view.context.QRCode = function(root, options) { qrCalls.push(options); };
  view.context.QRCode.CorrectLevel = { M: 1 };
  view.node("#track-qr-library").emit("load");
  assert.equal(view.node("#receipt-qr").hidden, false);
  assert.equal(qrCalls.length, 1);
  assert.equal(qrCalls[0].text, "https://dapoer.example/nota/?id=" + ID + "&token=" + TOKEN);
  assert.equal(view.requests.length, 1);
});
