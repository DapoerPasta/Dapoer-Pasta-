const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function dashboard(fetch = async () => { throw new Error("Unexpected fetch"); }) {
  let timestamp = Date.parse("2026-10-06T05:00:00Z");
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [timestamp])); }
    static now() { return timestamp; }
  }
  const elements = new Map();
  const listeners = new Map();
  let document;
  const node = (tag = "div") => {
    const classes = new Set(), handlers = new Map();
    return {
      tagName: tag.toUpperCase(),children: [], textContent: "", value: "", hidden: false, disabled: false, open: false,
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, toggle(name, value) { if(value)classes.add(name);else classes.delete(name); }, contains(name) { return classes.has(name); } },
      append(...children) { children.forEach(child=>{child.remove();child.parent=this;this.children.push(child)}); },
      insertBefore(child, reference) { child.remove();child.parent=this;const index=reference?this.children.indexOf(reference):-1;if(index<0)this.children.push(child);else this.children.splice(index,0,child); },
      replaceChildren(...children) { this.children.forEach(child=>child.parent=null);this.children=[];this.append(...children); },
      remove() { if(this.parent){this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;} },
      addEventListener(name, listener) { handlers.set(name, listener); },dispatchEvent(event) { return handlers.get(event.type)?.(event); },
      setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name] || null; },
      focus() { document.activeElement=this; },showModal() { this.open=true; },close() { this.open=false; }
    };
  };
  document = {
    readyState: "loading", hidden: false,
    addEventListener(name, listener) { listeners.set(name, listener); },dispatchEvent(event) { listeners.get(event.type)?.(event); },
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, node());
      return elements.get(selector);
    },
    createElement: node
  };
  const notifications = [];
  const context = vm.createContext({
    document, window: {}, CustomEvent: class {constructor(type,options={}){this.type=type;this.detail=options.detail}}, Date: ClockDate, Intl, AbortController, URLSearchParams,
    fetch, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, alert() {}
  });
  let source = fs.readFileSync(path.join(__dirname, "../assets/js/admin.js"), "utf8");
  source = source.replace(/\}\)\(\);\s*$/, `
    notifyNewOrders=orders=>globalThis.recordNotification(orders);
    globalThis.dashboardApi={state,todayInWib,validOrderDate,shiftOrderDate,
      millisecondsToWibMidnight,mergeOrders,syncToday,selectOrderDate,loadOrders,
      filteredOrders,showLogin,showDashboard,hasMoreOrders,changeStatus,chooseStatus,renderOrders,checkSession,logout,bind,finishCancellation};
  })();`);
  context.recordNotification = orders => notifications.push(Array.from(orders, order => order.id));
  vm.runInContext(source, context);
  return {
    ...context.dashboardApi, elements, notifications, document, window:context.window,
    clock(value) { timestamp = Date.parse(value); },
    element(selector) { return document.querySelector(selector); }
  };
}

function order(id, createdAt = "2026-10-06T04:00:00Z", status = "baru", total = 12000) {
  return { id, created_at: createdAt, updated_at: createdAt, status, total, items: [], customer_name: "Customer" };
}

function page(date, orders, number = 1, total = orders.length, summary = {}) {
  return {
    date, timeZone: "Asia/Jakarta", orders,
    pagination: { page: number, pageSize: 100, total, totalPages: Math.ceil(total / 100), hasMore: number < Math.ceil(total / 100) },
    summary: { totalOrders: total, newOrders: total, processingOrders: 0, orderValue: total * 12000, ...summary }
  };
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

test("the order calendar uses WIB boundaries and valid calendar dates", () => {
  const ui = dashboard();
  assert.equal(ui.state.selectedDate, "2026-10-06");
  assert.equal(ui.todayInWib(new Date("2026-10-05T16:59:59.999Z")), "2026-10-05");
  assert.equal(ui.todayInWib(new Date("2026-10-05T17:00:00Z")), "2026-10-06");
  assert.equal(ui.millisecondsToWibMidnight(new Date("2026-10-05T16:59:59.999Z")), 1);
  assert.equal(ui.millisecondsToWibMidnight(new Date("2026-10-05T17:00:00Z")), 86400000);
  for (const value of ["2026-02-29", "2026-04-31", "2026-00-01", "2026-10-6", "", "not-a-date"]) {
    assert.equal(ui.validOrderDate(value), false, value);
  }
  assert.equal(ui.validOrderDate("2028-02-29"), true);
  assert.equal(ui.shiftOrderDate("2028-03-01", -1), "2028-02-29");
  assert.equal(ui.shiftOrderDate("2026-12-31", 1), "2027-01-01");
});

test("today automatically advances at midnight, but manually selected history stays fixed", async () => {
  const ui = dashboard(async url => response(page(new URL(url, "https://test.example").searchParams.get("date"), [])));
  ui.state.orders = [order("yesterday")];
  ui.state.initialized = true;
  ui.state.seenIds.add("yesterday");
  ui.clock("2026-10-06T17:00:00Z");
  assert.equal(ui.syncToday(), true);
  assert.equal(ui.state.selectedDate, "2026-10-07");
  assert.equal(ui.state.orders.length, 0);
  assert.equal(ui.state.initialized, false);
  assert.equal(ui.state.seenIds.size, 0);
  await ui.selectOrderDate("2026-10-05", false);
  ui.clock("2026-10-07T17:00:00Z");
  assert.equal(ui.syncToday(), false);
  assert.equal(ui.state.selectedDate, "2026-10-05");
  await ui.selectOrderDate(ui.todayInWib(), true);
  assert.equal(ui.state.selectedDate, "2026-10-08");
  assert.equal(ui.state.followingToday, true);
  assert.equal(ui.notifications.length, 0);
});

test("daily summary counts the whole day rather than just the first loaded page", async () => {
  const urls = [];
  const ui = dashboard(async (url, options) => {
    urls.push(url);
    assert.equal(options.cache, "no-store");
    return response(page("2026-10-06", [order("one"), order("two")], 1, 205, {
      newOrders: 93, processingOrders: 50, orderValue: 2500000
    }));
  });
  await ui.loadOrders();
  const query = new URL(urls[0], "https://test.example").searchParams;
  assert.equal(query.get("date"), "2026-10-06");
  assert.equal(query.get("page"), "1");
  assert.equal(query.get("pageSize"), "100");
  assert.equal(ui.element("#stat-total").textContent, 205);
  assert.equal(ui.element("#stat-new").textContent, 93);
  assert.equal(ui.element("#stat-processing").textContent, 50);
  assert.match(ui.element("#orders-caption").textContent, /2 dimuat dari 205/);
  assert.equal(ui.element("#load-more-orders").hidden, false);
  assert.equal(ui.notifications.length, 0);
  ui.state.query = "one";
  assert.equal(ui.filteredOrders().length, 1);
  ui.state.filter = "selesai";
  assert.equal(ui.filteredOrders().length, 0);
});

test("polls preserve loaded pages, deduplicate shifted rows, and alert once for new orders", async () => {
  const requests = [];
  const replies = [
    page("2026-10-06", [order("middle", "2026-10-06T04:00:00Z"), order("tail", "2026-10-06T03:00:00Z")], 1, 205),
    page("2026-10-06", [order("tail", "2026-10-06T03:00:00Z"), order("oldest", "2026-10-06T02:00:00Z")], 2, 205),
    page("2026-10-06", [order("new", "2026-10-06T05:00:00Z"), order("middle", "2026-10-06T04:00:00Z")], 1, 206),
    page("2026-10-06", [order("tail", "2026-10-06T03:00:00Z", "selesai")], 2, 206),
    page("2026-10-06", [order("new", "2026-10-06T05:00:00Z"), order("middle", "2026-10-06T04:00:00Z")], 1, 206),
    page("2026-10-06", [order("tail", "2026-10-06T03:00:00Z", "selesai")], 2, 206)
  ];
  const ui = dashboard(async url => { requests.push(url); return response(replies.shift()); });
  await ui.loadOrders();
  await ui.loadOrders(false, true);
  assert.equal(ui.state.pageCount, 2);
  assert.equal(ui.state.orders.length, 3);
  assert.equal(ui.notifications.length, 0);
  await ui.loadOrders(true);
  assert.deepEqual(Array.from(ui.state.orders, value => value.id), ["new", "middle", "tail", "oldest"]);
  assert.equal(ui.state.orders.find(value => value.id === "tail").status, "selesai");
  assert.deepEqual(ui.notifications, [["new"]]);
  await ui.loadOrders(true);
  assert.equal(ui.notifications.length, 1);
  assert.deepEqual(requests.map(url => new URL(url, "https://test.example").searchParams.get("page")), ["1", "2", "1", "2", "1", "2"]);
});

test("switching dates establishes a silent baseline instead of announcing historical orders", async () => {
  const ui = dashboard(async url => {
    const date = new URL(url, "https://test.example").searchParams.get("date");
    return response(page(date, [order(`${date}-order`)]));
  });
  await ui.loadOrders();
  await ui.selectOrderDate("2026-10-05", false);
  assert.deepEqual(Array.from(ui.state.orders, value => value.id), ["2026-10-05-order"]);
  assert.equal(ui.state.followingToday, false);
  await ui.selectOrderDate("2026-10-06", true);
  assert.deepEqual(Array.from(ui.state.orders, value => value.id), ["2026-10-06-order"]);
  assert.equal(ui.notifications.length, 0);
});

test("slow stale responses cannot replace the newly selected date", async () => {
  let resolveOld;
  let oldSignal;
  const ui = dashboard((url, options) => {
    const date = new URL(url, "https://test.example").searchParams.get("date");
    if (date === "2026-10-06") {
      oldSignal = options.signal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return Promise.resolve(response(page(date, [order("history")])));
  });
  const oldRequest = ui.loadOrders();
  await ui.selectOrderDate("2026-10-05", false);
  assert.equal(oldSignal.aborted, true);
  resolveOld(response(page("2026-10-06", [order("stale")])));
  await oldRequest;
  assert.equal(ui.state.selectedDate, "2026-10-05");
  assert.deepEqual(Array.from(ui.state.orders, value => value.id), ["history"]);
  assert.equal(ui.element("#refresh-orders").disabled, false);
  assert.equal(ui.notifications.length, 0);
});

test("concurrent polling and refresh events reuse one active request", async () => {
  let finish;
  let calls = 0;
  const ui = dashboard(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = ui.loadOrders(true);
  await ui.loadOrders(true);
  await ui.loadOrders(false);
  assert.equal(calls, 1);
  finish(response(page("2026-10-06", [])));
  await pending;
  assert.equal(ui.state.request, null);
  assert.equal(ui.element("#refresh-orders").disabled, false);
});

test("an expired session invalidates pending order requests and clears private rows", async () => {
  const ui = dashboard(async () => response({ error: "Unauthorized" }, 401));
  ui.state.orders = [order("private")];
  await ui.loadOrders(true);
  assert.equal(ui.state.orders.length, 0);
  assert.equal(ui.element("#dashboard-view").hidden, true);
  assert.equal(ui.element("#login-view").hidden, false);
  assert.equal(ui.state.request, null);
});

test("the initial silent refresh shows an actionable database error", async () => {
  const ui = dashboard(async () => response({ error: "Database belum siap" }, 503));
  await ui.loadOrders(true);
  assert.equal(ui.element("#orders-caption").textContent, "Database belum siap");
  assert.equal(ui.state.initialized, false);
  assert.equal(ui.state.request, null);
  assert.equal(ui.element("#refresh-orders").disabled, false);
  assert.equal(ui.element("#orders-list").children[0].children[0].textContent, "Data belum tersedia");
});

test("a successful status save invalidates a poll with an older status snapshot", async () => {
  let resolveOld;
  let oldSignal;
  let reads = 0;
  const ui = dashboard(async (url, options) => {
    if (url === "/api/admin/status") return response({ ok: true });
    if (++reads === 1) {
      oldSignal = options.signal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return response(page("2026-10-06", [order("one", "2026-10-06T04:00:00Z", "selesai")], 1, 1, { newOrders: 0 }));
  });
  ui.state.orders = [order("one")];
  ui.state.seenIds.add("one");
  ui.state.initialized = true;
  ui.state.summary = { totalOrders: 1, newOrders: 1, processingOrders: 0, orderValue: 12000 };
  const pendingPoll = ui.loadOrders(true);
  await ui.changeStatus("one", "selesai", ui.element("#save-status"));
  assert.equal(oldSignal.aborted, true);
  assert.equal(reads, 2);
  resolveOld(response(page("2026-10-06", [order("one")])));
  await pendingPoll;
  assert.equal(ui.state.orders[0].status, "selesai");
  assert.equal(ui.state.summary.newOrders, 0);
  assert.equal(ui.element("#stat-new").textContent, 0);
  assert.equal(ui.notifications.length, 0);
});

test("polling preserves the exact status draft, DOM node and focused control", async () => {
  let current = order("one");
  const ui = dashboard(async () => response(page("2026-10-06", [current])));
  await ui.loadOrders();
  const row = ui.state.cards.get("one");
  row.select.value = "dikirim";
  ui.chooseStatus("one", "dikirim");
  row.select.focus();
  await ui.loadOrders(true);
  assert.equal(ui.state.cards.get("one"), row);
  assert.equal(ui.element("#orders-list").children[0], row.card);
  assert.equal(ui.document.activeElement, row.select);
  assert.equal(row.select.value, "dikirim");
  assert.equal(row.button.disabled, false);
  assert.equal(ui.state.drafts.get("one").expectedUpdatedAt, current.updated_at);
});

test("in-flight status saves remain disabled through polling and cannot duplicate", async () => {
  let finish;
  const writes = [];
  const ui = dashboard(async (url, options) => {
    if (url === "/api/admin/status") {
      writes.push(JSON.parse(options.body));
      return new Promise(resolve => { finish = resolve; });
    }
    return response(page("2026-10-06", [order("one")]));
  });
  await ui.loadOrders();
  const row = ui.state.cards.get("one");
  ui.chooseStatus("one", "diproses");
  const save = ui.changeStatus("one", "diproses", row.button);
  await ui.loadOrders(true);
  assert.equal(row.button.disabled, true);
  assert.equal(row.select.disabled, true);
  await ui.changeStatus("one", "dikirim", row.button);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { id: "one", status: "diproses", expectedStatus: "baru", expectedUpdatedAt: "2026-10-06T04:00:00Z" });
  finish(response({ order: { ...order("one"), status: "diproses", updated_at: "2026-10-06T05:00:00.000123Z" } }));
  await save;
  assert.equal(ui.state.pendingStatuses.size, 0);
});

test("a changed status version requires review while preserving the unsaved selection", async () => {
  let current = order("one");
  const ui = dashboard(async () => response(page("2026-10-06", [current])));
  await ui.loadOrders();
  const row = ui.state.cards.get("one");
  ui.chooseStatus("one", "selesai");
  current = { ...current, status: "diproses", updated_at: "2026-10-06T05:00:00.000001Z" };
  await ui.loadOrders(true);
  assert.equal(row.select.value, "selesai");
  assert.equal(row.button.disabled, true);
  assert.equal(row.review.hidden, false);
  row.review.dispatchEvent({ type: "click" });
  assert.equal(ui.state.drafts.has("one"), false);
  assert.equal(row.select.value, "diproses");
});

test("an ambiguous status failure retries the identical CAS action even after server state changes", async () => {
  let current = order("one");
  const writes = [];
  const ui = dashboard(async (url, options) => {
    if (url === "/api/admin/status") {
      writes.push(JSON.parse(options.body));
      current = { ...current, status: "diproses", updated_at: "2026-10-06T05:00:00.000002Z" };
      if (writes.length === 1) throw new Error("Connection reset after commit");
      return response({ order: current });
    }
    return response(page("2026-10-06", [current]));
  });
  await ui.loadOrders();
  const row = ui.state.cards.get("one");
  ui.chooseStatus("one", "diproses");
  await ui.changeStatus("one", "diproses", row.button);
  await ui.loadOrders(true);
  assert.equal(row.select.disabled, true);
  assert.equal(row.button.disabled, false);
  assert.equal(ui.state.drafts.get("one").uncertain, true);
  await ui.changeStatus("one", "diproses", row.button);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(ui.state.drafts.size, 0);
});

test("status controls prohibit backwards changes and cancellation after shipping", async () => {
  const ui = dashboard(async () => response(page("2026-10-06", [order("one", undefined, "dikirim"), order("two", undefined, "selesai")])));
  await ui.loadOrders();
  const shipped = ui.state.cards.get("one"), completed = ui.state.cards.get("two");
  for (const value of ["baru", "diproses", "dibatalkan"]) assert.equal(shipped.select.children.find(option => option.value === value).disabled, true);
  assert.equal(shipped.select.children.find(option => option.value === "selesai").disabled, false);
  assert.equal(completed.select.disabled, true);
  assert.equal(completed.button.disabled, true);
});

test("cancellation requires the explicit dialog confirmation before any request", async () => {
  const writes = [];
  const ui = dashboard(async (url, options) => {
    if (url === "/api/admin/status") { writes.push(JSON.parse(options.body)); return response({ order: { ...order("one"), status: "dibatalkan" } }); }
    return response(page("2026-10-06", [order("one")]));
  });
  await ui.loadOrders();
  const row = ui.state.cards.get("one");
  ui.chooseStatus("one", "dibatalkan");
  const cancel = ui.changeStatus("one", "dibatalkan", row.button);
  assert.equal(ui.element("#order-cancel-dialog").open, true);
  assert.equal(writes.length, 0);
  ui.finishCancellation(false);
  await cancel;
  assert.equal(writes.length, 0);
  const confirmed = ui.changeStatus("one", "dibatalkan", row.button);
  ui.finishCancellation(true);
  await confirmed;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expectedStatus, "baru");
});

test("failed logout keeps dashboard and private rows until a successful retry", async () => {
  let calls = 0, broadcasts = 0;
  const ui = dashboard(async () => { if (++calls === 1) throw new Error("Offline"); return response({ ok: true }); });
  ui.window.DapoerAdminSession = { notifyLogout() { broadcasts++; } };
  ui.showDashboard();
  ui.state.orders = [order("private")];
  await ui.logout();
  assert.equal(ui.element("#dashboard-view").hidden, false);
  assert.equal(ui.state.orders.length, 1);
  assert.equal(broadcasts, 0);
  assert.match(ui.element("#admin-session-message").textContent, /Sesi Anda masih aktif/);
  assert.equal(ui.element("#logout-button").disabled, false);
  await ui.logout();
  assert.equal(ui.element("#dashboard-view").hidden, true);
  assert.equal(ui.state.orders.length, 0);
  assert.equal(broadcasts, 1);
});

test("silent polling failures keep private rows while showing connectivity degradation and recovery", async () => {
  let fail = false;
  const ui = dashboard(async () => { if (fail) throw new Error("Offline"); return response(page("2026-10-06", [order("one")])); });
  await ui.loadOrders();
  const card = ui.state.cards.get("one").card;
  fail = true;
  await ui.loadOrders(true);
  assert.equal(ui.element("#orders-list").children[0], card);
  assert.equal(ui.element("#orders-live-state").classList.contains("delayed"), true);
  assert.match(ui.element("#orders-live-label").textContent, /terganggu/);
  fail = false;
  await ui.loadOrders(true);
  assert.equal(ui.element("#orders-live-state").classList.contains("delayed"), false);
  assert.match(ui.element("#orders-live-label").textContent, /tersambung/);
});

test("a session check started before cross-tab logout cannot reopen the dashboard", async () => {
  let finish;let reads=0;
  const ui = dashboard(async url => {
    if(url === "/api/admin/session")return new Promise(resolve=>{finish=resolve});
    reads++;return response(page("2026-10-06", [order("private")]));
  });
  ui.showDashboard();
  const pending = ui.checkSession();
  ui.showLogin();
  finish(response({email:"admin@example.test"}));
  await pending;
  assert.equal(ui.element("#dashboard-view").hidden,true);
  assert.equal(reads,0);
  assert.equal(ui.state.orders.length,0);
});
