const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

function dashboard(fetch) {
  const elements = new Map(), listeners = new Map(), timers = new Map(), events = [];
  let sequence = 0, document;
  function node(tag = "div") {
    const classes = new Set(), handlers = new Map();
    return {
      tagName: tag.toUpperCase(), children: [], value: "", textContent: "", hidden: false, disabled: false,
      classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); }, toggle(value, active) { active ? classes.add(value) : classes.delete(value); } },
      append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } },
      insertBefore(child, reference) { child.remove(); child.parent = this; const index = reference ? this.children.indexOf(reference) : -1; index < 0 ? this.children.push(child) : this.children.splice(index, 0, child); },
      replaceChildren(...children) { this.children.forEach(child => child.parent = null); this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
      addEventListener(type, listener) { handlers.set(type, listener); }, dispatchEvent(event) { return handlers.get(event.type)?.(event); },
      setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name] || null; }, focus() { document.activeElement = this; }
    };
  }
  document = {
    readyState: "loading", hidden: false, createElement: node,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { events.push(event); listeners.get(event.type)?.(event); },
    querySelectorAll() { return []; },
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, node()); return elements.get(selector); }
  };
  const context = vm.createContext({
    document, window: {}, Date, Intl, URLSearchParams, AbortController, crypto: { randomUUID }, fetch,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval() { return 1; }, clearInterval() {}
  });
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/admin.js"), "utf8").replace(/\}\)\(\);\s*$/, `
    globalThis.api={state,loadOrders,renderOrders,reviewAddition,chooseStatus,showLogin,showDashboard,updateOrderContents,updateStatusRow};
  })();`);
  vm.runInContext(source, context);
  const api = context.api;
  api.state.selectedDate = "2026-10-16"; api.state.followingToday = false;
  return { ...api, events, document, timers, element(selector) { return document.querySelector(selector); },
    expire(delay) { const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `timer ${delay} exists`); timers.delete(entry[0]); entry[1].callback(); }
  };
}

const ADDITION_ID = "66f49638-993b-44be-9b58-069bdcb0d488";
const UPDATED = "2026-10-16T04:00:00.000123Z";
function addition(overrides = {}) {
  return { id: ADDITION_ID, status: "pending", total: 30000, items: [{ id: "oval", name: "Pasta oval", price: 30000, quantity: 1, subtotal: 30000 }], ...overrides };
}
function order(overrides = {}) {
  return { id: "DP-addition", status: "diproses", total: 37000, created_at: "2026-10-16T03:00:00Z", updated_at: UPDATED, queue_number: 2, queue_date: "2026-10-16", customer_name: "Customer", items: [{ id: "chicken", name: "Chicken", price: 37000, quantity: 1, subtotal: 37000 }], additions: [addition()], ...overrides };
}
function page(orders, number = 1, total = orders.length) {
  return { date: "2026-10-16", timeZone: "Asia/Jakarta", orders, pagination: { page: number, pageSize: 100, total, totalPages: Math.ceil(total / 100), hasMore: number < Math.ceil(total / 100) }, summary: { totalOrders: total, processingOrders: total, newOrders: 0, orderValue: orders.reduce((sum, item) => sum + item.total, 0) } };
}
function response(data, status = 200) { return { status, ok: status >= 200 && status < 300, async json() { return data; } }; }
function decided(current = order(), decision = "approve") {
  const nextAddition = addition({ status: decision === "approve" ? "approved" : "rejected" });
  const next = { ...current, updated_at: "2026-10-16T05:00:00.000456Z", total: decision === "approve" ? current.total + 30000 : current.total, items: decision === "approve" ? [...current.items, ...nextAddition.items] : current.items, additions: [nextAddition] };
  return { raw: next, body: { addition: nextAddition, order: { ...next, updatedAt: next.updated_at } } };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("admin shows pending additions only while processing, with item amounts and projected total", async () => {
  const orders = [order(), order({ id: "DP-new", status: "baru" }), order({ id: "DP-sent", status: "dikirim" }), order({ id: "DP-approved", additions: [addition({ status: "approved" })] })];
  const ui = dashboard(async () => response(page(orders)));
  await ui.loadOrders();
  const row = ui.state.cards.get("DP-addition"), request = row.additionRows.get(ADDITION_ID);
  assert.equal(row.additions.hidden, false);
  assert.equal(request.items.children[0].children[0].textContent, "Pasta oval × 1");
  assert.match(request.totals.textContent, /30\.000.*67\.000/);
  for (const id of ["DP-new", "DP-sent", "DP-approved"]) assert.equal(ui.state.cards.get(id).additions.hidden, true);
});

test("approval preserves the order card, filters, loaded pages and queue while refreshing stock and financial listeners", async () => {
  const writes = [], reads = []; let current = order();
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") { writes.push(JSON.parse(options.body)); const result = decided(current); current = result.raw; return response(result.body); }
    const number = Number(new URL(url, "https://test.example").searchParams.get("page")); reads.push(number);
    return response(page(number === 1 ? [current] : [], number, 101));
  });
  await ui.loadOrders(); await ui.loadOrders(false, true);
  const row = ui.state.cards.get(current.id), card = row.card, items = row.items;
  ui.state.filter = "diproses"; ui.state.query = "customer";
  await ui.reviewAddition(current.id, ADDITION_ID, "approve");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expectedUpdatedAt, UPDATED);
  assert.equal(writes[0].expectedStatus, "diproses");
  assert.match(writes[0].requestId, /^[a-f\d-]{36}$/);
  assert.equal(ui.state.cards.get(current.id).card, card); assert.equal(ui.state.cards.get(current.id).items, items);
  assert.equal(items.children.length, 2); assert.equal(row.total.textContent, "Rp 67.000");
  assert.equal(ui.state.orders[0].queue_number, 2); assert.equal(ui.state.cards.get(current.id).additions.hidden, true);
  assert.equal(ui.state.filter, "diproses"); assert.equal(ui.state.query, "customer"); assert.equal(ui.state.pageCount, 2);
  assert.deepEqual(reads, [1, 2, 1, 2]);
  assert.equal(ui.events.filter(event => event.type === "dapoer:stock-changed").length, 1);
  assert.equal(ui.element("#stat-value").textContent, "Rp 67.000");
});

test("rejecting an addition preserves the original menu and total", async () => {
  let current = order();
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") { const result = decided(current, "reject"); current = result.raw; return response(result.body); }
    return response(page([current]));
  });
  await ui.loadOrders(); await ui.reviewAddition(current.id, ADDITION_ID, "reject");
  assert.equal(ui.state.orders[0].total, 37000); assert.equal(ui.state.orders[0].items.length, 1);
  assert.equal(ui.state.orders[0].additions[0].status, "rejected");
  assert.equal(ui.state.cards.get(current.id).additions.hidden, true);
});

test("an uncertain review retries its exact UUID and CAS, blocks the opposite decision and status edits", async () => {
  const writes = []; let current = order();
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") {
      writes.push(JSON.parse(options.body));
      if (writes.length === 1) throw new Error("Connection lost after commit");
      const result = decided(current); current = result.raw; return response(result.body);
    }
    return response(page([current]));
  });
  await ui.loadOrders(); await ui.reviewAddition(current.id, ADDITION_ID, "approve");
  const row = ui.state.cards.get(current.id), request = row.additionRows.get(ADDITION_ID);
  assert.equal(request.approve.disabled, false); assert.equal(request.reject.disabled, true); assert.equal(row.select.disabled, true);
  ui.chooseStatus(current.id, "dikirim"); assert.equal(ui.state.drafts.size, 0);
  await ui.reviewAddition(current.id, ADDITION_ID, "reject"); assert.equal(writes.length, 1);
  await ui.reviewAddition(current.id, ADDITION_ID, "approve");
  assert.deepEqual(writes[1], writes[0]); assert.equal(ui.state.additionReviews.size, 0);
});

test("a response body that stalls times out, and a late body cannot apply a second result", async () => {
  const writes = []; let finishJson, firstSignal, current = order();
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") {
      writes.push(JSON.parse(options.body));
      if (writes.length === 1) { firstSignal = options.signal; return { ok: true, status: 200, json() { return new Promise(resolve => { finishJson = resolve; }); } }; }
      const result = decided(current); current = result.raw; return response(result.body);
    }
    return response(page([current]));
  });
  await ui.loadOrders();
  const pending = ui.reviewAddition(current.id, ADDITION_ID, "approve"); await flush(); ui.expire(30000); await pending;
  assert.equal(firstSignal.aborted, true); assert.equal(ui.state.additionReviews.get(ADDITION_ID).uncertain, true);
  finishJson(decided(current).body); await flush();
  assert.equal(ui.state.orders[0].total, 37000); assert.equal(ui.events.length, 0);
  await ui.reviewAddition(current.id, ADDITION_ID, "approve");
  assert.deepEqual(writes[1], writes[0]); assert.equal(ui.state.orders[0].total, 67000);
});

test("in-flight review survives polling, blocks duplicate clicks, and holds status controls", async () => {
  let finish; const writes = [], current = order();
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") { writes.push(JSON.parse(options.body)); return new Promise(resolve => { finish = resolve; }); }
    return response(page([current]));
  });
  await ui.loadOrders(); const row = ui.state.cards.get(current.id), request = row.additionRows.get(ADDITION_ID);
  const pending = ui.reviewAddition(current.id, ADDITION_ID, "approve"); await ui.loadOrders(true);
  assert.equal(row.additionRows.get(ADDITION_ID), request); assert.equal(request.approve.disabled, true); assert.equal(request.reject.disabled, true); assert.equal(row.select.disabled, true);
  await ui.reviewAddition(current.id, ADDITION_ID, "approve"); assert.equal(writes.length, 1);
  finish(response(decided(current).body)); await pending;
});

test("a stale version conflict requires a new review with the refreshed raw timestamp", async () => {
  let current = order(); const writes = [];
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") {
      writes.push(JSON.parse(options.body));
      if (writes.length === 1) { current = { ...current, updated_at: "2026-10-16T06:00:00.000987Z" }; return response({ code: "ORDER_CONFLICT" }, 409); }
      const result = decided(current); current = result.raw; return response(result.body);
    }
    return response(page([current]));
  });
  await ui.loadOrders(); await ui.reviewAddition(current.id, ADDITION_ID, "approve");
  assert.equal(ui.state.additionReviews.size, 0);
  assert.match(ui.state.cards.get(current.id).additionRows.get(ADDITION_ID).message.textContent, /Pesanan berubah/);
  await ui.reviewAddition(current.id, ADDITION_ID, "approve");
  assert.notEqual(writes[1].requestId, writes[0].requestId); assert.equal(writes[1].expectedUpdatedAt, "2026-10-16T06:00:00.000987Z");
});

test("cross-tab logout aborts an active review and ignores its later success", async () => {
  let finish, signal;
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }
    return response(page([order()]));
  });
  await ui.loadOrders(); ui.showDashboard();
  const pending = ui.reviewAddition("DP-addition", ADDITION_ID, "approve"); ui.showLogin();
  assert.equal(signal.aborted, true); assert.equal(ui.state.additionReviews.size, 0);
  finish(response(decided().body)); await pending;
  assert.equal(ui.state.orders.length, 0); assert.equal(ui.element("#orders-list").children.length, 0); assert.equal(ui.element("#dashboard-view").hidden, true);
  assert.equal(ui.events.filter(event => event.type === "dapoer:stock-changed").length, 0);
});

test("an expired review response clears private data before reading the body", async () => {
  let bodyReads = 0;
  const ui = dashboard(async (url, options) => options?.method === "POST" ? { status: 401, ok: false, async json() { bodyReads++; throw new Error("Must not read"); } } : response(page([order()])));
  await ui.loadOrders(); await ui.reviewAddition("DP-addition", ADDITION_ID, "approve");
  assert.equal(bodyReads, 0); assert.equal(ui.state.orders.length, 0); assert.equal(ui.state.additionReviews.size, 0);
});

test("logout during the follow-up refresh cannot publish a stale success notification", async () => {
  let reads = 0, finishRefresh;
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") return response(decided().body);
    if (++reads === 1) return response(page([order()]));
    return new Promise(resolve => { finishRefresh = resolve; });
  });
  await ui.loadOrders(); const pending = ui.reviewAddition("DP-addition", ADDITION_ID, "approve"); await flush();
  assert.equal(typeof finishRefresh, "function"); ui.showLogin(); finishRefresh(response(page([decided().raw]))); await pending;
  assert.equal(ui.element("#notification-title").textContent, ""); assert.equal(ui.state.orders.length, 0);
});

test("malformed or mismatched successful decisions remain uncertain and reuse the original request", async () => {
  const writes = []; let current = order();
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") {
      writes.push(JSON.parse(options.body));
      if (writes.length === 1) return response(decided(current, "reject").body);
      const result = decided(current); current = result.raw; return response(result.body);
    }
    return response(page([current]));
  });
  await ui.loadOrders(); await ui.reviewAddition(current.id, ADDITION_ID, "approve");
  assert.equal(ui.state.additionReviews.get(ADDITION_ID).uncertain, true); assert.equal(ui.state.orders[0].total, 37000);
  await ui.reviewAddition(current.id, ADDITION_ID, "approve"); assert.deepEqual(writes[1], writes[0]);
});

test("an applied addition from polling refreshes existing item nodes and invalidates an older unsaved status version", async () => {
  let current = order(); const ui = dashboard(async () => response(page([current])));
  await ui.loadOrders(); const row = ui.state.cards.get(current.id); ui.chooseStatus(current.id, "dikirim");
  current = decided(current).raw; await ui.loadOrders(true);
  assert.equal(ui.state.cards.get(current.id), row); assert.equal(row.items.children.length, 2); assert.equal(row.total.textContent, "Rp 67.000");
  assert.equal(row.button.disabled, true); assert.equal(row.review.hidden, false); assert.equal(row.select.value, "dikirim");
});

test("a slow approval response cannot overwrite a newer polled total or pending request, even within the same millisecond", async () => {
  let current = order(), finish, unavailable = false;
  const ui = dashboard(async (url, options) => {
    if (options?.method === "POST") return new Promise(resolve => { finish = resolve; });
    if (unavailable) throw new Error("Offline after confirmation");
    return response(page([current]));
  });
  await ui.loadOrders(); const pending = ui.reviewAddition(current.id, ADDITION_ID, "approve");
  const previousResult = decided(current);
  const newerRequest = addition({ id: "03d0c3af-1de0-438f-a83f-a7a88538d828", total: 37000 });
  current = { ...previousResult.raw, updated_at: "2026-10-16T05:00:00.000457Z", total: 104000, items: [...previousResult.raw.items, ...order().items], additions: [...previousResult.raw.additions, newerRequest] };
  await ui.loadOrders(true); unavailable = true; finish(response(previousResult.body)); await pending;
  assert.equal(ui.state.orders[0].total, 104000);
  assert.equal(ui.state.orders[0].updated_at, "2026-10-16T05:00:00.000457Z");
  assert.equal(ui.state.cards.get(current.id).total.textContent, "Rp 104.000");
  assert.equal(ui.state.cards.get(current.id).additionRows.has(newerRequest.id), true);
});
