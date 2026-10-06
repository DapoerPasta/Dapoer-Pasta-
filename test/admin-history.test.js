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
  const node = () => ({
    children: [], textContent: "", value: "", hidden: false, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {}, setAttribute(name, value) { this[name] = value; }
  });
  const document = {
    readyState: "loading", hidden: false, addEventListener() {},
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, node());
      return elements.get(selector);
    },
    createElement: node
  };
  const notifications = [];
  const context = vm.createContext({
    document, window: {}, Date: ClockDate, Intl, AbortController, URLSearchParams,
    fetch, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {}, alert() {}
  });
  let source = fs.readFileSync(path.join(__dirname, "../assets/js/admin.js"), "utf8");
  source = source.replace(/\}\)\(\);\s*$/, `
    notifyNewOrders=orders=>globalThis.recordNotification(orders);
    globalThis.dashboardApi={state,todayInWib,validOrderDate,shiftOrderDate,
      millisecondsToWibMidnight,mergeOrders,syncToday,selectOrderDate,loadOrders,
      filteredOrders,showLogin,hasMoreOrders,changeStatus};
  })();`);
  context.recordNotification = orders => notifications.push(Array.from(orders, order => order.id));
  vm.runInContext(source, context);
  return {
    ...context.dashboardApi, elements, notifications,
    clock(value) { timestamp = Date.parse(value); },
    element(selector) { return document.querySelector(selector); }
  };
}

function order(id, createdAt = "2026-10-06T04:00:00Z", status = "baru", total = 12000) {
  return { id, created_at: createdAt, status, total, items: [], customer_name: "Customer" };
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
