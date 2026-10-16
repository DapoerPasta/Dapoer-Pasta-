const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const ID = "DP-ADDITION-TEST", TOKEN = "a".repeat(48), KEY = "dapoer-order-addition-v1";
const WA_KEY = "dapoer-order-whatsapp-v1", CURRENT_KEY = "dapoer-current-order-v2";
const clone = value => JSON.parse(JSON.stringify(value));
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const product = (extra = {}) => ({ id: "pasta-oval", name: "Pasta oval", price: 30000, stock: 20, ...extra });
const fixture = (extra = {}) => ({
  id: ID, status: "baru", total: 37000, queueNumber: 7, queueDate: "2026-10-16", canAddItems: true,
  paymentMethod: "Transfer Bank", updatedAt: "2026-10-16T01:00:00.000456Z",
  items: [{ id: "chicken", name: "Chicken", price: 37000, quantity: 1, subtotal: 37000 }], additions: [], ...extra
});
const addition = (payload, status = "applied") => ({
  id: payload.requestId, status, items: payload.items.map(item => ({ ...product(), ...item, subtotal: item.quantity * 30000 })),
  total: payload.expectedTotal, createdAt: "2026-10-16T01:00:00.000457Z", updatedAt: "2026-10-16T01:00:00.000457Z"
});
function success(payload, initial = fixture(), status = "applied") {
  const item = addition(payload, status), applied = ["applied", "approved"].includes(status);
  return { persisted: true, addition: item, order: { ...initial, total: initial.total + (applied ? item.total : 0),
    items: applied ? [...initial.items, ...item.items] : initial.items, additions: [item], updatedAt: item.updatedAt } };
}
function host({ local = new Map(), session = new Map(), fetch: runFetch, failWrites = false } = {}) {
  const nodes = new Map(), listeners = new Map(), timers = new Map(), posts = [], syncs = [];
  let catalog = [product()], latest = fixture(), timerId = 0, unavailable = 0, refreshes = 0, writes = 0;
  function events(target, prefix) {
    target.addEventListener = (type, callback) => { const key = prefix + type, list = listeners.get(key) || []; list.push(callback); listeners.set(key, list); };
    target.emit = async (type, event = {}) => { const calls = listeners.get(prefix + type) || []; return Promise.all(calls.map(callback => callback({ target, ...event }))); };
    return target;
  }
  const document = events({ hidden: false, activeElement: null }, "document:");
  let elementId = 0;
  function node() {
    const classes = new Set();
    return events({ children: [], value: "", textContent: "", hidden: false, disabled: false, dataset: {},
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      setAttribute(key, value) { this[key] = String(value); }, removeAttribute(key) { delete this[key]; }, remove() {},
      focus() { document.activeElement = this; }, scrollIntoView() {},
      classList: { toggle(key, enabled) { enabled ? classes.add(key) : classes.delete(key); }, contains(key) { return classes.has(key); } }
    }, `element:${++elementId}:`);
  }
  document.querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); };
  document.createElement = node;
  const storage = (map, permanent) => ({ getItem: key => map.get(key) ?? null,
    setItem(key, value) { if (failWrites) throw new Error("quota"); if (permanent) writes++; map.set(key, String(value)); },
    removeItem(key) { if (failWrites) throw new Error("quota"); map.delete(key); } });
  const location = { origin: "https://dapoer.example", search: `?id=${ID}&token=${TOKEN}`, hash: "" };
  const context = vm.createContext({ document, location, navigator: { onLine: true }, URL, URLSearchParams, AbortController,
    crypto: webcrypto, localStorage: storage(local, true), sessionStorage: storage(session),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      if (url === "/api/menu") return reply({ products: clone(catalog) });
      const payload = JSON.parse(options.body); posts.push(clone(payload));
      if (runFetch) return runFetch(payload, posts.length);
      const result = success(payload, latest, latest.status === "diproses" ? "pending" : "applied"); return reply(result);
    }
  });
  context.window = context; events(context, "window:");
  for (const file of ["order-recovery.js", "order-additions.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js", file), "utf8"), context);
  context.DapoerTrack = {
    update(order) { latest = clone(order); syncs.push(clone(order)); context.DapoerOrderAdditions.update(order); },
    unavailable() { unavailable++; }, refresh() { refreshes++; }
  };
  const $ = document.querySelector;
  return { context, document, local, session, posts, syncs, $, timers,
    get writes() { return writes; }, get unavailable() { return unavailable; }, get refreshes() { return refreshes; },
    recovery: context.DapoerOrderRecovery, get latest() { return latest; },
    async start(order = fixture()) { await document.emit("DOMContentLoaded"); latest = clone(order); context.DapoerOrderAdditions.update(order); },
    update(order) { latest = clone(order); context.DapoerOrderAdditions.update(order); },
    setCatalog(value) { catalog = value; },
    async open() { await $("#track-add-menu").emit("click"); for (let i = 0; i < 12; i++) await Promise.resolve(); },
    row() { return $("#addition-menu").children[0]; },
    async quantity(value) { const input = this.row().children[1].children[1]; input.value = String(value); await input.emit("input"); return input; },
    submit() { return $("#addition-form").emit("submit", { preventDefault() {} }); },
    retry() { return $("#addition-retry").emit("click"); }
  };
}

test("a new order gains menus using the same ID and queue without customer fields or a new checkout", async () => {
  const view = host(); await view.start(); await view.open(); await view.quantity(2); await view.submit();
  assert.equal(view.posts.length, 1); assert.equal(view.posts[0].action, "add-items"); assert.equal(view.posts[0].id, ID);
  assert.equal(view.posts[0].expectedTotal, 60000); assert.equal(view.posts[0].customer, undefined); assert.equal(view.latest.queueNumber, 7);
  assert.equal(view.latest.total, 97000); assert.equal(view.latest.id, ID); assert.equal(view.session.has(KEY), false);
  assert.match(view.$("#addition-notice").textContent, /pesanan yang sama/);
});

test("processing requests stay pending with the old total and no payment request or second submission", async () => {
  const view = host(); await view.start(fixture({ status: "diproses" })); await view.open(); await view.quantity(1);
  assert.match(view.$("#addition-description").textContent, /belum masuk tagihan/); await view.submit(); await view.submit();
  assert.equal(view.posts.length, 1); assert.equal(view.latest.total, 37000); assert.equal(view.latest.additions[0].status, "pending");
  assert.equal(view.$("#track-add-menu").hidden, true); assert.equal(view.$("#addition-submit").disabled, true);
  assert.match(view.$("#addition-history-items").children[0].children[2].textContent, /belum perlu dibayar/);
});

test("a lost response survives reload and replays identical UUID, items and price despite new catalog prices", async () => {
  const session = new Map(), sent = [];
  const first = host({ session, fetch: async payload => { sent.push(payload); throw new Error("lost"); } });
  await first.start(); await first.open(); await first.quantity(1); await first.submit();
  assert.equal(session.has(KEY), true); assert.equal(first.unavailable, 1);
  const second = host({ session, fetch: async payload => { sent.push(payload); return reply(success(payload)); } });
  second.setCatalog([product({ price: 42000, stock: 0 })]); await second.start();
  assert.equal(second.$("#addition-retry").hidden, false); assert.equal(second.$("#tambah-menu").hidden, false);
  await second.retry(); assert.deepEqual(sent[1], sent[0]); assert.equal(second.latest.total, 67000); assert.equal(session.has(KEY), false);
});

test("polling preserves quantity node, focus and selected input", async () => {
  const view = host(); await view.start(); await view.open(); const input = await view.quantity(3); input.focus();
  view.update(fixture({ updatedAt: "2026-10-16T01:00:00.000457Z" }));
  assert.equal(view.row().children[1].children[1], input); assert.equal(view.document.activeElement, input); assert.equal(input.value, "3");
  assert.equal(view.$("#addition-subtotal").textContent, "Rp 90.000");
});

test("price or stock changes require another review before any POST", async () => {
  for (const change of [{ price: 42000 }, { stock: 0 }]) {
    const view = host(); await view.start(); await view.open(); await view.quantity(1); view.setCatalog([product(change)]); await view.submit();
    assert.equal(view.posts.length, 0); assert.equal(view.session.has(KEY), false); assert.match(view.$("#addition-notice").textContent, /Harga menu berubah|Stok berubah/);
    assert.equal(view.row().children[1].children[1].value, "1");
  }
});

test("the definite addition limit clears an impossible intent while a request conflict keeps its UUID", async () => {
  for (const code of ["ADDITION_LIMIT", "REQUEST_CONFLICT"]) {
    const view = host({ fetch: async () => reply({ code, error: "Hubungi admin" }, 409) }); await view.start(); await view.open(); await view.quantity(1); await view.submit();
    assert.equal(view.session.has(KEY), code === "REQUEST_CONFLICT");
    assert.equal(view.$("#addition-retry").hidden, code !== "REQUEST_CONFLICT");
  }
});

test("a malformed success cannot clear an uncertain intent or enable stale actions", async () => {
  const view = host({ fetch: async payload => { const result = success(payload); result.order.additions[0].total++; return reply(result); } });
  await view.start(); await view.open(); await view.quantity(1); await view.submit();
  assert.equal(view.session.has(KEY), true); assert.equal(view.unavailable, 1); assert.equal(view.$("#track-add-menu").hidden, true);
  assert.equal(view.$("#addition-submit").disabled, true); assert.match(view.$("#addition-notice").textContent, /belum memastikan/);
});

test("a newer approved poll wins over an older pending POST response within the same millisecond", async () => {
  let resolve, began; const started = new Promise(done => { began = done; }), waiting = new Promise(done => { resolve = done; });
  const initial = fixture({ status: "diproses" }); let payload;
  const view = host({ fetch: async body => { payload = body; began(); return waiting; } });
  await view.start(initial); await view.open(); await view.quantity(1); const saving = view.submit(); await started;
  const newer = success(payload, initial, "approved"); newer.order.updatedAt = "2026-10-16T01:00:00.000458Z";
  view.update(newer.order); resolve(reply(success(payload, initial, "pending"))); await saving;
  assert.equal(view.latest.total, 67000); assert.equal(view.latest.additions[0].status, "approved"); assert.equal(view.syncs.length, 0);
  assert.equal(view.session.has(KEY), false); assert.match(view.$("#addition-notice").textContent, /Status terbaru/);
});

test("terminal and unreserved orders cannot open additions; malformed updates disable previously active controls", async () => {
  for (const extra of [{ status: "dikirim" }, { status: "selesai" }, { status: "dibatalkan" }, { canAddItems: false }]) {
    const view = host(); await view.start(fixture(extra)); await view.open(); assert.equal(view.$("#track-add-menu").hidden, true); assert.equal(view.$("#tambah-menu").hidden, true);
  }
  const view = host(); await view.start(); await view.open(); await view.quantity(1); view.update(fixture({ additions: [{ status: "pending" }] }));
  assert.equal(view.$("#track-add-menu").hidden, true); assert.equal(view.$("#addition-submit").disabled, true);
});

test("recovery updates total once without extending its lifetime, storage loops, or persistent PII", () => {
  const view = host(), initial = fixture(), trackingUrl = `/track/?id=${ID}&token=${TOKEN}`;
  view.recovery.remember({ order: initial, trackingUrl, whatsappUrl: "https://api.whatsapp.com/send?phone=6285175391181&text=PRIVATE_FORM" });
  const before = JSON.parse(view.local.get(CURRENT_KEY)); before.savedAt -= 10000; view.local.set(CURRENT_KEY, JSON.stringify(before));
  const count = view.writes;
  for (let i = 0; i < 5; i++) view.recovery.getWhatsAppUrl({ id: ID, token: TOKEN, order: initial });
  assert.equal(view.writes, count);
  const changed = fixture({ total: 67000 }); delete changed.additions;
  const url = view.recovery.getWhatsAppUrl({ id: ID, token: TOKEN, order: changed });
  assert.doesNotMatch(url, /PRIVATE_FORM/); assert.equal(view.session.has(WA_KEY), false);
  assert.match(new URL(url).searchParams.get("text"), /67\.000/);
  const after = JSON.parse(view.local.get(CURRENT_KEY)); assert.equal(after.savedAt, before.savedAt); assert.equal(after.total, 67000); assert.equal(view.writes, count + 1);
  for (let i = 0; i < 5; i++) view.recovery.syncOrder({ id: ID, token: TOKEN, order: changed });
  assert.equal(view.writes, count + 1); assert.doesNotMatch(JSON.stringify([...view.local.values()]), /PRIVATE_FORM|alamat|customer/);
});

test("WhatsApp includes every permitted line and separates pending additional payment from the current total", () => {
  const view = host(), payload = { requestId: "0199dead-beef-7000-8000-000000000001", items: [{ id: "pasta-oval", quantity: 1 }], expectedTotal: 30000 };
  const order = fixture({ status: "diproses", items: Array.from({ length: 100 }, (_, i) => ({ name: `Menu ${i + 1}`, quantity: 1 })), additions: [addition(payload, "pending")] });
  assert.equal(view.recovery.validAdditions(order.additions), true);
  const text = new URL(view.recovery.getWhatsAppUrl({ id: ID, token: TOKEN, order })).searchParams.get("text");
  assert.match(text, /Menu 100 × 1/); assert.match(text, /TOTAL PESANAN: Rp 37\.000/);
  assert.match(text, /MENUNGGU PERSETUJUAN ADMIN/); assert.match(text, /belum masuk total pesanan dan belum perlu dibayar/);
  order.additions[0].items[0].subtotal = 1; assert.equal(view.recovery.getWhatsAppUrl({ id: ID, token: TOKEN, order }), null);
});

test("microsecond timestamp comparison recognizes submillisecond updates and equivalent time zones", () => {
  const compare = host().recovery.compareUpdatedAt;
  assert.equal(compare("2026-10-16T01:00:00.000457Z", "2026-10-16T01:00:00.000456Z"), 1);
  assert.equal(compare("2026-10-16T08:00:00.000456+07:00", "2026-10-16T01:00:00.000456Z"), 0);
  assert.equal(compare("2026-10-16T01:00:00.999999Z", "2026-10-16T01:00:01.000001Z"), -1);
});
