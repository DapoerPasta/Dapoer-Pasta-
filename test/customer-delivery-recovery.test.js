const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const ID = "DP-DELIVERY-001", TOKEN = "a".repeat(48), CHALLENGE = "b".repeat(48);
const CURRENT = "dapoer-current-order-v2", DRAFT = "dapoer-checkout-draft-v1";
const PHONE = "dapoer-phone-recovery-v1", REQUEST = "dapoer-phone-recovery-request-v1", VERIFY = "dapoer-phone-recovery-verification-v1";
const plain = value => JSON.parse(JSON.stringify(value));
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const order = (extra = {}) => ({ id: ID, total: 37000, itemsSubtotal: 37000, deliveryMethod: "delivery", shippingFee: null,
  shippingConfirmed: false, grandTotal: null, status: "baru", updatedAt: "2026-10-16T01:00:00.000001Z",
  queueNumber: 7, queueDate: "2026-10-16", canAddItems: true, paymentMethod: "Transfer Bank", additions: [],
  items: [{ id: "chicken", name: "Chicken", quantity: 1, subtotal: 37000 }], ...extra });
const url = (id = ID, token = TOKEN) => `/track/?id=${id}&token=${token}`;
const challenge = () => ({ challengeId: CHALLENGE, expiresAt: new Date(Date.now() + 9 * 60000).toISOString(), status: "awaiting-admin" });

function host(files = [], { local = new Map(), session = new Map(), search = "", fetch: runFetch = async () => response({}), now = Date.now() } = {}) {
  const nodes = new Map(), timers = new Map(), sent = [], listeners = new Map(); let serial = 0, clock = now;
  function events(target) {
    const key = ++serial;
    target.addEventListener = (type, fn) => { const name = `${key}:${type}`, list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); };
    target.emit = async (type, event = {}) => Promise.all((listeners.get(`${key}:${type}`) || []).map(fn => fn({ target, preventDefault() { this.defaultPrevented = true; }, ...event })));
    return target;
  }
  const document = events({ hidden: false, activeElement: null, title: "" });
  function node() {
    const classes = new Set();
    return events({ value: "", hidden: false, disabled: false, textContent: "", children: [], dataset: {}, attributes: {},
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      setAttribute(key, value) { this.attributes[key] = String(value); }, removeAttribute(key) { delete this.attributes[key]; delete this[key]; },
      setCustomValidity(value) { this.validationMessage = value; }, reportValidity() { return !this.validationMessage; },
      focus() { document.activeElement = this; }, querySelector() { return null; }, querySelectorAll() { return []; }, scrollIntoView() {},
      classList: { add(key) { classes.add(key); }, remove(key) { classes.delete(key); }, contains: key => classes.has(key), toggle(key, enabled) { enabled ? classes.add(key) : classes.delete(key); } }
    });
  }
  document.querySelector = selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); };
  document.createElement = node; document.querySelectorAll = () => []; document.body = node();
  for (const selector of ["#phone-recovery", "#phone-recovery-results", "#phone-recovery-challenge"]) document.querySelector(selector).hidden = true;
  const storage = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) });
  const location = { origin: "https://dapoer.example", search, hash: "", pathname: "/track/" };
  const context = vm.createContext(events({ document, location, URL, URLSearchParams, AbortController, TextEncoder, Uint8Array,
    navigator: { onLine: true }, crypto: webcrypto, localStorage: storage(local), sessionStorage: storage(session),
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() {},
    fetch: async (address, options = {}) => { sent.push({ address, options, body: options.body ? JSON.parse(options.body) : undefined }); return runFetch(address, options, sent.length); }
  }));
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js/order-recovery.js"), "utf8"), context);
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, "../assets/js", file), "utf8"), context);
  if (files.includes("app.js")) vm.runInContext("globalThis.app={state,deliveryChoice,updateDeliveryChoice,customerSnapshot,validateCustomer,saveCheckoutDraft,restoreCheckoutDraft,canonicalPayload,intentFor,loadIntent,renderSavedBilling,postCheckout};", context);
  return { context, app: context.app, recovery: context.DapoerOrderRecovery, document, nodes, sent, local, session, timers, $: document.querySelector,
    start: () => document.emit("DOMContentLoaded"), advance(ms) { clock += ms; },
    runDeadline(delay) { const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `deadline ${delay} exists`); timers.delete(entry[0]); entry[1].fn(); }
  };
}
function fill(view) { for (const [key, value] of Object.entries({ name: "Customer", phone: "081234567890", address: "Jalan privat 123", payment: "DANA", notes: "" })) view.$(`#checkout-${key}`).value = value; }
async function requestCode(view) { view.$("#phone-recovery-phone").value = "081234567890"; await view.$("#phone-recovery-request").emit("submit"); }
async function verifyCode(view, code = "123456") { view.$("#phone-recovery-code").value = code; await view.$("#phone-recovery-verify").emit("submit"); }

test("pickup hides address, removes its required validation, and sends no stale shipping address", () => {
  const view = host(["app.js"]); fill(view); view.$("#checkout-delivery").value = "pickup"; view.app.updateDeliveryChoice();
  assert.equal(view.$("#checkout-address-label").hidden, true); assert.equal(view.$("#checkout-address").required, false); assert.equal(view.$("#checkout-address").disabled, true);
  assert.equal(view.app.customerSnapshot().address, ""); assert.equal(view.app.validateCustomer(view.app.customerSnapshot()), true);
  assert.match(view.$("#checkout-shipping-note").textContent, /ongkir Rp 0/);
  view.$("#checkout-delivery").value = "delivery"; view.app.updateDeliveryChoice(); view.$("#checkout-address").value = "";
  assert.equal(view.$("#checkout-address").required, true); assert.equal(view.$("#checkout-address-label").hidden, false);
  assert.equal(view.app.validateCustomer(view.app.customerSnapshot()), false); assert.match(view.$("#checkout-shipping-note").textContent, /menunggu konfirmasi/);
});

test("pickup drafts restore acceptance method without persisting an unused address or local customer data", () => {
  const session = new Map(), view = host(["app.js"], { session }); fill(view); view.$("#checkout-delivery").value = "pickup"; view.app.saveCheckoutDraft();
  const draft = JSON.parse(session.get(DRAFT)); assert.equal(draft.customer.deliveryMethod, "pickup"); assert.equal(draft.customer.address, "");
  const restored = host(["app.js"], { session }); restored.app.restoreCheckoutDraft();
  assert.equal(restored.app.deliveryChoice(), "pickup"); assert.equal(restored.$("#checkout-address").disabled, true); assert.equal(restored.$("#checkout-name").value, "Customer");
  assert.equal([...restored.local.values()].some(value => value.includes("Customer")), false);
});

test("old delivery intents keep their UUID while changing fulfillment creates a distinct intent", async () => {
  const view = host(["app.js"]); fill(view);
  const oldPayload = { items: [{ id: "chicken", quantity: 1 }], expectedTotal: 37000, customer: { name: "Customer", phone: "081234567890", address: "Jalan privat 123", paymentMethod: "DANA", notes: "" } };
  const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  view.session.set("dapoer-checkout-intent-v1", JSON.stringify({ requestId, payload: oldPayload }));
  const delivery = await view.app.intentFor({ ...oldPayload, customer: { ...oldPayload.customer, deliveryMethod: "delivery" } }); assert.equal(delivery.requestId, requestId);
  const pickup = await view.app.intentFor({ ...oldPayload, customer: { ...oldPayload.customer, address: "", deliveryMethod: "pickup" } }); assert.notEqual(pickup.requestId, requestId);
});

test("billing distinguishes pending delivery from a confirmed zero quote and rejects inconsistent sums", () => {
  const { recovery } = host(); assert.equal(recovery.billing(order()).grandTotal, null);
  const zero = order({ shippingFee: 0, shippingConfirmed: true, grandTotal: 37000 }); assert.equal(recovery.billing(zero).grandTotal, 37000);
  assert.equal(recovery.billing({ ...zero, total: 38000 }), null); assert.equal(recovery.billing({ ...zero, deliveryMethod: "pickup", shippingFee: 1000, total: 38000, grandTotal: 38000 }), null);
});

test("saved confirmation renders subtotal, pending shipping, a confirmed quote, and free pickup clearly", () => {
  const view = host(["app.js"]); view.app.renderSavedBilling(order()); assert.match(view.$("#checkout-success-billing").textContent, /Ongkir menunggu konfirmasi/);
  view.app.renderSavedBilling(order({ shippingFee: 10000, shippingConfirmed: true, total: 47000, grandTotal: 47000 })); assert.match(view.$("#checkout-success-billing").textContent, /Subtotal menu Rp 37\.000.*Ongkir Rp 10\.000.*Total akhir Rp 47\.000/);
  view.app.renderSavedBilling(order({ deliveryMethod: "pickup", shippingFee: 0, shippingConfirmed: true, grandTotal: 37000 })); assert.match(view.$("#checkout-success-billing").textContent, /Ambil sendiri.*Ongkir Rp 0.*Total akhir Rp 37\.000/);
});

test("WhatsApp discards cached checkout amounts when pending shipping becomes a zero or paid quote", () => {
  const view = host(), original = "https://api.whatsapp.com/send?phone=6285175391181&text=OLD_FORM";
  view.recovery.remember({ order: order(), trackingUrl: url(), whatsappUrl: original }); assert.equal(view.recovery.getWhatsAppUrl({ id: ID, token: TOKEN, order: order() }), original);
  const zero = order({ shippingFee: 0, shippingConfirmed: true, grandTotal: 37000 });
  const zeroText = new URL(view.recovery.getWhatsAppUrl({ id: ID, token: TOKEN, order: zero })).searchParams.get("text"); assert.match(zeroText, /Ongkir: Rp 0/); assert.doesNotMatch(zeroText, /OLD_FORM|belum termasuk ongkir/);
  const quoted = order({ shippingFee: 10000, shippingConfirmed: true, total: 47000, grandTotal: 47000 });
  const quotedText = new URL(view.recovery.getWhatsAppUrl({ id: ID, token: TOKEN, order: quoted })).searchParams.get("text"); assert.match(quotedText, /Subtotal menu: Rp 37\.000/); assert.match(quotedText, /TOTAL PESANAN: Rp 47\.000/);
});

test("tracking reports final totals and labels pickup dispatch as ready for collection", async () => {
  const value = order({ status: "dikirim", deliveryMethod: "pickup", shippingFee: 0, shippingConfirmed: true, grandTotal: 37000 });
  const view = host(["track.js"], { search: `?id=${ID}&token=${TOKEN}`, fetch: async () => response({ order: value }) }); await view.start(); await tick();
  assert.equal(view.$("#track-status").textContent, "Siap diambil"); assert.equal(view.$("#track-total-label").textContent, "Total akhir"); assert.equal(view.$("#track-shipping").textContent, "Rp 0 · ambil sendiri");
});

test("add-menu estimates include an existing delivery quote only once", async () => {
  const view = host(["order-additions.js"], { search: `?id=${ID}&token=${TOKEN}`, fetch: async () => response({ products: [{ id: "oval", name: "Pasta oval", price: 30000, stock: 5 }] }) });
  await view.start(); view.context.DapoerOrderAdditions.update(order({ shippingFee: 10000, shippingConfirmed: true, total: 47000, grandTotal: 47000 }));
  await view.$("#track-add-menu").emit("click"); await tick();
  const quantity = view.$("#addition-menu").children[0].children[1].children[1]; quantity.value = "1"; await quantity.emit("input");
  assert.equal(view.$("#addition-current-total").textContent, "Rp 47.000"); assert.equal(view.$("#addition-combined-total").textContent, "Rp 77.000"); assert.match(view.$("#addition-shipping-note").textContent, /ongkir dihitung satu kali/);
});

test("a bare or malformed tracking page offers phone recovery without querying any order", async () => {
  for (const search of ["", "?id=bad&token=bad"]) {
    const view = host(["phone-recovery.js"], { search }); await view.start(); assert.equal(view.$("#phone-recovery").hidden, false); assert.equal(view.sent.length, 0);
  }
  const linked = host(["phone-recovery.js"], { search: `?id=${ID}&token=${TOKEN}` }); linked.$("#phone-recovery").hidden = true; await linked.start(); assert.equal(linked.$("#phone-recovery").hidden, true);
});

test("request uses a normalized phone and exposes only a challenge while explaining admin sends the code", async () => {
  const view = host(["phone-recovery.js"], { fetch: async () => response(challenge()) }); await view.start(); await requestCode(view);
  assert.equal(view.sent[0].body.phone, "6281234567890"); assert.equal(view.sent[0].body.action, "request-recovery"); assert.match(view.sent[0].body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(view.$("#phone-recovery-challenge").hidden, false); assert.match(view.$("#phone-recovery-notice").textContent, /Admin.*mengirim kode melalui WhatsApp/);
  assert.equal(view.local.size, 0); assert.equal(JSON.parse(view.session.get(PHONE)).challengeId, CHALLENGE); assert.equal(view.session.has(REQUEST), false);
  assert.equal(view.$("#phone-recovery-orders").children.length, 0); assert.match(new URL(view.$("#phone-recovery-whatsapp").href).searchParams.get("text"), /Mohon kirim kode hanya ke nomor WhatsApp yang tercatat/);
});

test("invalid mobile phone or a malformed server challenge never starts a verification flow", async () => {
  const view = host(["phone-recovery.js"], { fetch: async () => response({ ...challenge(), challengeId: "forged" }) }); await view.start();
  view.$("#phone-recovery-phone").value = "phone+081234567890"; await view.$("#phone-recovery-request").emit("submit"); assert.equal(view.sent.length, 0);
  await requestCode(view); assert.equal(view.session.has(PHONE), false); assert.equal(view.$("#phone-recovery-challenge").hidden, true); assert.equal(view.session.has(REQUEST), true);
});

test("a lost request result is retried with the same phone and UUID after reload", async () => {
  const session = new Map(), first = host(["phone-recovery.js"], { session, fetch: async () => { throw new Error("lost"); } }); await first.start(); await requestCode(first);
  const second = host(["phone-recovery.js"], { session, fetch: async () => response(challenge()) }); await second.start(); assert.equal(second.$("#phone-recovery-phone").disabled, true);
  await second.$("#phone-recovery-request").emit("submit"); assert.deepEqual(second.sent[0].body, first.sent[0].body); assert.equal(session.has(REQUEST), false);
});

test("an uncertain request can be explicitly abandoned so a corrected phone can be entered", async () => {
  const view = host(["phone-recovery.js"], { fetch: async () => { throw new Error("lost"); } }); await view.start(); await requestCode(view);
  assert.equal(view.$("#phone-recovery-restart").hidden, false); assert.equal(view.$("#phone-recovery-phone").disabled, true);
  await view.$("#phone-recovery-restart").emit("click"); assert.equal(view.session.has(REQUEST), false); assert.equal(view.$("#phone-recovery-phone").disabled, false); assert.equal(view.$("#phone-recovery-restart").hidden, true);
});

test("wrong code clears its old intent and a corrected code consumes a new attempt UUID", async () => {
  const view = host(["phone-recovery.js"], { fetch: async (_, options) => JSON.parse(options.body).action === "request-recovery" ? response(challenge()) : response({ status: "invalid", remainingAttempts: 4 }) }); await view.start(); await requestCode(view);
  await verifyCode(view, "111111"); assert.match(view.$("#phone-recovery-notice").textContent, /Sisa 4 percobaan/); assert.equal(view.session.has(VERIFY), false);
  await verifyCode(view, "222222"); assert.notEqual(view.sent[1].body.requestId, view.sent[2].body.requestId); assert.equal(view.$("#phone-recovery-orders").children.length, 0);
});

test("uncertain verification replays an immutable code and UUID after refresh", async () => {
  const session = new Map(), first = host(["phone-recovery.js"], { session, fetch: async (_, options) => JSON.parse(options.body).action === "request-recovery" ? response(challenge()) : Promise.reject(new Error("lost")) }); await first.start(); await requestCode(first); await verifyCode(first);
  const second = host(["phone-recovery.js"], { session, fetch: async () => response({ status: "verified", orders: [{ ...order(), trackingUrl: url() }] }) }); await second.start();
  assert.equal(second.$("#phone-recovery-code").disabled, true); await second.$("#phone-recovery-verify").emit("submit");
  assert.deepEqual(second.sent[0].body, first.sent[1].body); assert.equal(session.has(VERIFY), false); assert.equal(second.$("#phone-recovery-results").hidden, false);
});

test("awaiting-admin and exhausted codes reveal no orders and reset appropriately", async () => {
  let outcome = { status: "awaiting-admin" };
  const view = host(["phone-recovery.js"], { fetch: async (_, options) => JSON.parse(options.body).action === "request-recovery" ? response(challenge()) : response(outcome) }); await view.start(); await requestCode(view); await verifyCode(view);
  assert.match(view.$("#phone-recovery-notice").textContent, /Kode belum dikirim admin/); assert.equal(view.session.has(VERIFY), false);
  outcome = { status: "invalid", remainingAttempts: 0 }; await verifyCode(view); assert.equal(view.$("#phone-recovery-challenge").hidden, true); assert.equal(view.session.has(PHONE), false); assert.equal(view.$("#phone-recovery-orders").children.length, 0);
});

test("verification timeout includes JSON parsing and ignores a late successful private result", async () => {
  const held = deferred();
  const view = host(["phone-recovery.js"], { fetch: async (_, options) => JSON.parse(options.body).action === "request-recovery" ? response(challenge()) : { ok: true, status: 200, json: () => held.promise } });
  await view.start(); await requestCode(view); const verifying = verifyCode(view); await tick(); view.runDeadline(12000); await verifying;
  held.resolve({ status: "verified", orders: [{ ...order(), trackingUrl: url() }] }); await tick(); assert.equal(view.$("#phone-recovery-orders").children.length, 0); assert.equal(view.$("#phone-recovery-results").hidden, true);
  assert.equal(view.$("#phone-recovery-verify-submit").textContent, "Periksa Kode yang Sama");
});

test("expiry while verification is in flight prevents late recovery URLs from appearing", async () => {
  const held = deferred(), view = host(["phone-recovery.js"], { fetch: async (_, options) => JSON.parse(options.body).action === "request-recovery" ? response(challenge()) : held.promise });
  await view.start(); await requestCode(view); const verifying = verifyCode(view); await tick(); view.advance(11 * 60000); await view.document.emit("visibilitychange");
  held.resolve(response({ status: "verified", orders: [{ ...order(), trackingUrl: url() }] })); await verifying;
  assert.equal(view.$("#phone-recovery-orders").children.length, 0); assert.equal(view.session.has(PHONE), false); assert.equal(view.session.has(VERIFY), false);
});

test("verified results do not replace the current order until the customer chooses one", async () => {
  const recovered = order(), view = host(["phone-recovery.js"], { fetch: async (_, options) => JSON.parse(options.body).action === "request-recovery" ? response(challenge()) : response({ status: "verified", orders: [{ ...recovered, trackingUrl: url() }] }) });
  view.recovery.remember({ order: order({ id: "DP-OTHER-001" }), trackingUrl: url("DP-OTHER-001", "c".repeat(48)), whatsappUrl: "https://api.whatsapp.com/send?phone=6285175391181&text=OTHER" });
  await view.start(); await requestCode(view); await verifyCode(view); assert.equal(view.recovery.getCurrent().id, "DP-OTHER-001");
  const link = view.$("#phone-recovery-orders").children[0].children[2]; await link.emit("click"); assert.equal(view.recovery.getCurrent().id, "DP-OTHER-001");
  const adopted = view.recovery.adoptSelected({ id: ID, token: TOKEN, order: recovered }); assert.equal(adopted.id, ID); assert.equal(view.recovery.getCurrent().id, ID);
  assert.equal(JSON.stringify([...view.local.values()]).includes("Customer"), false);
});

test("a newer checkout created after recovery selection keeps its reminder", () => {
  const view = host(); view.recovery.selectRecovered({ id: ID, token: TOKEN, expiresAt: challenge().expiresAt });
  view.recovery.remember({ order: order({ id: "DP-NEW-001" }), trackingUrl: url("DP-NEW-001", "d".repeat(48)), whatsappUrl: "https://api.whatsapp.com/send?phone=6285175391181&text=NEW" });
  assert.equal(view.recovery.adoptSelected({ id: ID, token: TOKEN, order: order() }), null); assert.equal(view.recovery.getCurrent().id, "DP-NEW-001");
});

test("malformed recovered URLs or inconsistent shipping totals fail closed", async () => {
  for (const extra of [{ trackingUrl: "https://evil.example/track/" }, { total: 1 }]) {
    const view = host(["phone-recovery.js"], { fetch: async (_, options) => JSON.parse(options.body).action === "request-recovery" ? response(challenge()) : response({ status: "verified", orders: [{ ...order(), trackingUrl: url(), ...extra }] }) });
    await view.start(); await requestCode(view); await verifyCode(view); assert.equal(view.$("#phone-recovery-orders").children.length, 0); assert.equal(view.$("#phone-recovery-results").hidden, true); assert.equal(view.session.has(VERIFY), true);
  }
});

test("expired recovery intents are discarded and never restored beyond ten minutes", async () => {
  const session = new Map([[PHONE, JSON.stringify({ ...challenge(), expiresAt: new Date(Date.now() - 1000).toISOString() })], [REQUEST, JSON.stringify({ phone: "6281234567890", requestId: webcrypto.randomUUID(), savedAt: Date.now() - 11 * 60000 })], [VERIFY, JSON.stringify({ challengeId: CHALLENGE, requestId: webcrypto.randomUUID(), code: "123456", savedAt: Date.now() - 11 * 60000 })]]);
  const view = host(["phone-recovery.js"], { session }); await view.start(); assert.equal(session.has(PHONE), false); assert.equal(session.has(REQUEST), false); assert.equal(session.has(VERIFY), false); assert.equal(view.sent.length, 0);
});
