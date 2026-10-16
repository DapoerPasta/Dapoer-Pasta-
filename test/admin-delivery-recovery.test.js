const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const START = Date.parse("2026-10-16T04:00:00Z");
const UPDATED = "2026-10-16T04:00:00.000123Z";
const CHALLENGE = "c".repeat(48);
const PHONE = "6281234567890";
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

function host(script, fetch) {
  const elements = new Map(), timers = new Map(), events = [], listeners = new Map();
  let sequence = 0, now = START, document;
  function handlers(target) {
    const handlers = new Map();
    target.addEventListener = (type, callback) => { const list = handlers.get(type) || []; list.push(callback); handlers.set(type, list); };
    target.dispatchEvent = event => { handlers.get(event.type)?.forEach(callback => callback(event)); };
    target.emit = (type, event = {}) => target.dispatchEvent({ type, ...event });
    return target;
  }
  function node(tag = "div") {
    const classes = new Set();
    return handlers({
      tagName: tag.toUpperCase(), children: [], value: "", textContent: "", hidden: false, disabled: false,
      classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); }, toggle(value, active) { active ? classes.add(value) : classes.delete(value); } },
      append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } },
      insertBefore(child, reference) { child.remove(); child.parent = this; const index = reference ? this.children.indexOf(reference) : -1; index < 0 ? this.children.push(child) : this.children.splice(index, 0, child); },
      replaceChildren(...children) { this.children.forEach(child => child.parent = null); this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
      setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name] || null; }, removeAttribute(name) { delete this[name]; },
      focus() { document.activeElement = this; }
    });
  }
  document = handlers({
    readyState: "loading", hidden: false, createElement: node,
    querySelectorAll() { return []; },
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); }
  });
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    document, window: { DapoerAdminSession: { subscribe(callback) { listeners.set("logout", callback); } } }, Date: ClockDate, Intl, URL, URLSearchParams, AbortController, crypto: { randomUUID }, fetch,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay, repeat: true }); return id; }, clearInterval(id) { timers.delete(id); }
  });
  let source = fs.readFileSync(path.join(__dirname, "../assets/js", script), "utf8");
  source = source.replace(/\}\)\(\);\s*$/, script === "admin.js" ? `
    globalThis.api={state,loadOrders,saveShipping,chooseStatus,showLogin,showDashboard,renderOrders,reviewAddition};
  })();` : `
    globalThis.api={state,setAuthenticated,loadRequests,prepareWhatsApp,safeWhatsApp};
  })();`);
  vm.runInContext(source, context);
  const api = context.api;
  if (script === "admin.js") { api.state.selectedDate = "2026-10-16"; api.state.followingToday = false; }
  if (script === "admin-recovery.js") document.emit("DOMContentLoaded");
  return { ...api, document, context, events, node: selector => document.querySelector(selector),
    advance(milliseconds) { now += milliseconds; },
    tick(delay) { const entry = [...timers].find(([, item]) => item.delay === delay); assert.ok(entry, `timer ${delay} exists`); if (!entry[1].repeat) timers.delete(entry[0]); entry[1].callback(); },
    logout() { listeners.get("logout")?.(); }
  };
}
function order(extra = {}) {
  return { id: "DP-delivery", status: "baru", total: 37000, created_at: "2026-10-16T03:00:00Z", updated_at: UPDATED,
    queue_number: 2, queue_date: "2026-10-16", customer_name: "Customer", delivery_method: "delivery", shipping_fee: null,
    items: [{ id: "chicken", name: "Chicken", quantity: 1, price: 37000, subtotal: 37000 }], additions: [], ...extra };
}
function page(orders) {
  return { date: "2026-10-16", timeZone: "Asia/Jakarta", orders,
    pagination: { page: 1, pageSize: 100, total: orders.length, totalPages: 1, hasMore: false },
    summary: { totalOrders: orders.length, newOrders: 1, processingOrders: 0, orderValue: orders.reduce((sum, item) => sum + item.total, 0) } };
}
function shippingResult(current, shippingFee = 10000, updatedAt = "2026-10-16T05:00:00.000456Z") {
  const itemsSubtotal = current.total - (current.shipping_fee ?? 0);
  return { order: { id: current.id, status: current.status, items: current.items, total: itemsSubtotal + shippingFee,
    deliveryMethod: "delivery", shippingFee, itemsSubtotal, grandTotal: itemsSubtotal + shippingFee, shippingConfirmed: true, updatedAt } };
}
function inputShipping(ui, value, id = "DP-delivery") {
  const row = ui.state.cards.get(id); row.shipping.input.value = value; row.shipping.input.emit("input"); return row;
}
function challenge(extra = {}) {
  return { challengeId: CHALLENGE, phone: PHONE, maskedPhone: "+6281••••890", createdAt: new Date(START).toISOString(),
    expiresAt: new Date(START + 600000).toISOString(), status: "awaiting-admin", orderCount: 1, ...extra };
}
function codeResult(extra = {}) {
  return { challengeId: CHALLENGE, expiresAt: challenge().expiresAt, status: "issued", whatsappUrl: `https://wa.me/${PHONE}?text=Kode%20123456`, ...extra };
}

test("shipping is editable for delivery in Baru or Diproses, while pickup remains free", async () => {
  const orders = [order(), order({ id: "DP-process", status: "diproses" }), order({ id: "DP-pickup", delivery_method: "pickup", shipping_fee: 0 }), order({ id: "DP-sent", status: "dikirim", shipping_fee: 10000, total: 47000 })];
  const ui = host("admin.js", async () => response(page(orders))); await ui.loadOrders();
  assert.equal(ui.state.cards.get("DP-delivery").shipping.root.hidden, false);
  assert.equal(ui.state.cards.get("DP-process").shipping.root.hidden, false);
  assert.equal(ui.state.cards.get("DP-pickup").shipping.root.hidden, true);
  assert.equal(ui.state.cards.get("DP-sent").shipping.root.hidden, true);
  assert.match(ui.state.cards.get("DP-pickup").breakdown.children[1].textContent, /tanpa ongkir/);
  assert.match(ui.state.cards.get("DP-sent").breakdown.children[0].textContent, /37\.000/);
});

test("shipping replaces a confirmed fee and preserves order identity, filters, and raw CAS", async () => {
  let current = order({ total: 47000, shipping_fee: 10000 }); const writes = [];
  const ui = host("admin.js", async (url, options) => {
    if (options.method === "POST") { writes.push(JSON.parse(options.body)); const result = shippingResult(current, 12000); current = { ...current, total: result.order.total, shipping_fee: 12000, updated_at: result.order.updatedAt }; return response(result); }
    return response(page([current]));
  });
  await ui.loadOrders(); const row = inputShipping(ui, "12000"), card = row.card;
  ui.state.filter = "baru"; ui.state.query = "customer"; await ui.saveShipping(current.id);
  assert.equal(writes.length, 1); assert.equal(writes[0].shippingFee, 12000); assert.equal(writes[0].expectedUpdatedAt, UPDATED); assert.equal(writes[0].expectedStatus, "baru");
  assert.equal(ui.state.orders[0].total, 49000); assert.equal(ui.state.orders[0].queue_number, 2); assert.equal(row.total.textContent, "Rp 49.000");
  assert.equal(ui.state.cards.get(current.id).card, card); assert.equal(ui.state.filter, "baru"); assert.equal(ui.state.query, "customer");
});

test("polling preserves a focused shipping draft and requires explicit review after a version change", async () => {
  let current = order(); const ui = host("admin.js", async () => response(page([current]))); await ui.loadOrders();
  const row = inputShipping(ui, "12000"); row.shipping.input.focus(); await ui.loadOrders(true);
  assert.equal(ui.document.activeElement, row.shipping.input); assert.equal(row.shipping.input.value, "12000"); assert.equal(row.shipping.save.disabled, false);
  current = { ...current, updated_at: "2026-10-16T04:00:00.000124Z" }; await ui.loadOrders(true);
  assert.equal(row.shipping.input.value, "12000"); assert.equal(row.shipping.save.disabled, true); assert.equal(row.shipping.reset.hidden, false);
  row.shipping.reset.emit("click"); assert.equal(row.shipping.input.value, ""); assert.equal(ui.state.shippingDrafts.size, 0);
});

test("an uncertain shipping write blocks status edits and retries the identical UUID and observed version", async () => {
  const writes = []; let current = order();
  const ui = host("admin.js", async (url, options) => {
    if (options.method === "POST") { writes.push(JSON.parse(options.body)); if (writes.length === 1) throw new Error("Lost after commit"); const result = shippingResult(current); current = { ...current, total: result.order.total, shipping_fee: 10000, updated_at: result.order.updatedAt }; return response(result); }
    return response(page([current]));
  });
  await ui.loadOrders(); const row = inputShipping(ui, "10000"); await ui.saveShipping(current.id);
  assert.equal(ui.state.shippingMutations.get(current.id).uncertain, true); assert.equal(row.select.disabled, true); assert.equal(row.shipping.input.disabled, true); assert.equal(row.shipping.save.disabled, false);
  ui.chooseStatus(current.id, "diproses"); assert.equal(ui.state.drafts.size, 0);
  await ui.saveShipping(current.id); assert.deepEqual(writes[1], writes[0]); assert.equal(ui.state.shippingMutations.size, 0);
});

test("shipping JSON timeouts include response decoding and ignore late bodies", async () => {
  let finishJson, firstSignal; const writes = [], current = order();
  const ui = host("admin.js", async (url, options) => {
    if (options.method === "POST") { writes.push(JSON.parse(options.body)); firstSignal = options.signal; return { ok: true, status: 200, json: () => new Promise(resolve => { finishJson = resolve; }) }; }
    return response(page([current]));
  });
  await ui.loadOrders(); inputShipping(ui, "10000"); const pending = ui.saveShipping(current.id); await flush(); ui.tick(30000); await pending;
  assert.equal(firstSignal.aborted, true); assert.equal(ui.state.shippingMutations.get(current.id).uncertain, true);
  finishJson(shippingResult(current)); await flush(); assert.equal(ui.state.orders[0].total, 37000);
});

test("shipping logout aborts writes and prevents a late response restoring private order data", async () => {
  let finish, signal; const current = order();
  const ui = host("admin.js", async (url, options) => {
    if (options.method === "POST") { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }
    return response(page([current]));
  });
  await ui.loadOrders(); inputShipping(ui, "10000"); const pending = ui.saveShipping(current.id); ui.showLogin();
  assert.equal(signal.aborted, true); assert.equal(ui.state.shippingMutations.size, 0); assert.equal(ui.state.shippingDrafts.size, 0);
  finish(response(shippingResult(current))); await pending;
  assert.equal(ui.state.orders.length, 0); assert.equal(ui.node("#orders-list").children.length, 0);
});

test("recovery requests stay private until authenticated and produce an explicit manual WhatsApp send step", async () => {
  const writes = []; const ui = host("admin-recovery.js", async (url, options) => {
    if (options.method === "POST") { writes.push(JSON.parse(options.body)); return response(codeResult()); }
    return response({ requests: [challenge()] });
  });
  assert.equal(ui.state.rows.size, 0); ui.setAuthenticated(true); await flush(); const row = ui.state.rows.get(CHALLENGE);
  assert.match(row.title.textContent, /••••/); assert.equal(row.link.hidden, true); assert.equal(row.button.textContent, "Siapkan kode WhatsApp");
  await ui.prepareWhatsApp(CHALLENGE);
  assert.equal(writes.length, 1); assert.equal(writes[0].challengeId, CHALLENGE); assert.equal(writes[0].action, "send-recovery-code");
  assert.equal(row.link.hidden, false); assert.equal(row.link.href, codeResult().whatsappUrl); assert.match(row.message.textContent, /belum otomatis terkirim/);
});

test("recovery accepts only official HTTPS WhatsApp links addressed to the stored customer phone", () => {
  const ui = host("admin-recovery.js", async () => response({ requests: [] }));
  assert.ok(ui.safeWhatsApp(`https://wa.me/${PHONE}?text=Kode`, PHONE));
  assert.ok(ui.safeWhatsApp(`https://api.whatsapp.com/send?phone=${PHONE}&text=Kode`, PHONE));
  for (const url of [`https://wa.me/628111111111?text=Kode`, `https://api.whatsapp.com/send?phone=628111111111&text=Kode`, `https://api.whatsapp.com/send?phone=${PHONE}&phone=628111111111&text=Kode`, `https://wa.me/${PHONE}?text=Kode&phone=628111111111`, `https://wa.me/${PHONE}?text=Kode&text=Other`, `https://wa.me.evil.test/${PHONE}?text=Kode`, `https://wa.me@evil.test/${PHONE}?text=Kode`, `http://wa.me/${PHONE}?text=Kode`, `https://wa.me:444/${PHONE}?text=Kode`, `https://wa.me/${PHONE}?text=Kode#leak`, `javascript:alert(1)`, `https://wa.me/${PHONE}`]) assert.equal(ui.safeWhatsApp(url, PHONE), null, url);
});

test("recovery hides prepared code URLs while hidden and scrubs all rows on logout", async () => {
  const ui = host("admin-recovery.js", async (url, options) => options.method === "POST" ? response(codeResult()) : response({ requests: [challenge()] }));
  ui.setAuthenticated(true); await flush(); await ui.prepareWhatsApp(CHALLENGE); const row = ui.state.rows.get(CHALLENGE);
  ui.document.hidden = true; ui.document.emit("visibilitychange"); assert.equal(row.link.hidden, true); assert.equal(row.link.href, undefined); assert.equal(row.url, null);
  ui.logout(); assert.equal(ui.state.rows.size, 0); assert.equal(ui.state.mutations.size, 0); assert.equal(ui.node("#recovery-requests").children.length, 0);
});

test("recovery retries an uncertain generation with the identical request ID and challenge", async () => {
  const writes = []; const ui = host("admin-recovery.js", async (url, options) => {
    if (options.method === "POST") { writes.push(JSON.parse(options.body)); if (writes.length === 1) throw new Error("Lost reply"); return response(codeResult()); }
    return response({ requests: [challenge()] });
  });
  ui.setAuthenticated(true); await flush(); await ui.prepareWhatsApp(CHALLENGE); const row = ui.state.rows.get(CHALLENGE);
  assert.equal(row.link.hidden, true); assert.equal(row.button.textContent, "Periksa kode yang sama");
  await ui.prepareWhatsApp(CHALLENGE); assert.deepEqual(writes[1], writes[0]); assert.equal(row.link.hidden, false);
});

test("recovery response decoding timeout rejects late code data and preserves exact retry", async () => {
  let finishJson, signal; const ui = host("admin-recovery.js", async (url, options) => {
    if (options.method === "POST") { signal = options.signal; return { ok: true, status: 200, json: () => new Promise(resolve => { finishJson = resolve; }) }; }
    return response({ requests: [challenge()] });
  });
  ui.setAuthenticated(true); await flush(); const pending = ui.prepareWhatsApp(CHALLENGE); await flush(); ui.tick(30000); await pending;
  const row = ui.state.rows.get(CHALLENGE); assert.equal(signal.aborted, true); assert.equal(ui.state.mutations.get(CHALLENGE).uncertain, true);
  finishJson(codeResult()); await flush(); assert.equal(row.link.hidden, true); assert.equal(row.link.href, undefined);
});

test("logout before the recovery JSON body settles prevents code links from reappearing", async () => {
  let finishJson; const ui = host("admin-recovery.js", async (url, options) => {
    if (options.method === "POST") return { ok: true, status: 200, json: () => new Promise(resolve => { finishJson = resolve; }) };
    return response({ requests: [challenge()] });
  });
  ui.setAuthenticated(true); await flush(); const pending = ui.prepareWhatsApp(CHALLENGE); await flush(); const row = ui.state.rows.get(CHALLENGE); ui.logout();
  finishJson(codeResult()); await pending; assert.equal(row.link.hidden, true); assert.equal(row.link.href, undefined); assert.equal(ui.state.rows.size, 0);
});

test("expired requests and malformed generation responses never expose an actionable code link", async () => {
  let malformed = false; const ui = host("admin-recovery.js", async (url, options) => options.method === "POST" ? response(codeResult({ whatsappUrl: "https://wa.me/628999999999?text=Kode" })) : response({ requests: malformed ? [{ ...challenge(), orderCount: -1 }] : [challenge()] }));
  ui.setAuthenticated(true); await flush(); await ui.prepareWhatsApp(CHALLENGE); const row = ui.state.rows.get(CHALLENGE);
  assert.equal(row.link.hidden, true); assert.equal(ui.state.mutations.get(CHALLENGE).uncertain, true);
  malformed = true; await ui.loadRequests(); assert.match(ui.node("#recovery-caption").textContent, /Pembaruan terputus/);
  ui.advance(600001); await ui.loadRequests(); assert.equal(row.link.hidden, true);
  await ui.prepareWhatsApp(CHALLENGE); assert.equal(row.link.href, undefined);
});

test("expired private links are removed even while recovery polling fails", async () => {
  let offline = false;
  const ui = host("admin-recovery.js", async (url, options) => {
    if (options.method === "POST") return response(codeResult());
    if (offline) throw new Error("Offline");
    return response({ requests: [challenge()] });
  });
  ui.setAuthenticated(true); await flush(); await ui.prepareWhatsApp(CHALLENGE); const row = ui.state.rows.get(CHALLENGE);
  assert.equal(row.link.hidden, false); offline = true; ui.advance(600001); await ui.loadRequests();
  assert.equal(row.link.hidden, true); assert.equal(row.link.href, undefined); assert.equal(row.button.disabled, true);
});
