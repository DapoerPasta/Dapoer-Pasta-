const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function financeDashboard(fetch = async () => { throw new Error("Unexpected request"); }, options = {}) {
  const nodes = new Map();
  const listeners = new Map();
  const events = [];
  const downloads = [];
  const downloadedFiles = [];
  const intervals = new Map();
  let timer = 0;
  let timestamp = Date.parse("2026-10-05T17:30:00Z");
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [timestamp])); }
    static now() { return timestamp; }
  }
  function node(tagName = "div") {
    const classes = new Set();
    const handlers = new Map();
    return {
      tagName: tagName.toUpperCase(), children: [], dataset: {}, value: "", textContent: "",
      hidden: false, disabled: false, open: false, style: {},
      classList: {
        contains(name) { return classes.has(name); },
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        toggle(name, active = !classes.has(name)) { if (active) classes.add(name); else classes.delete(name); }
      },
      append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); },
      appendChild(child) { this.append(child); return child; },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
      dispatchEvent(event) {
        if (!event.target) event.target = this;
        (handlers.get(event.type) || []).forEach(handler => handler(event));
      },
      setAttribute(name, value) { this[name] = value; },
      getAttribute(name) { return this[name] ?? null; },
      removeAttribute(name) { delete this[name]; },
      showModal() { this.open = true; },
      close() { this.open = false; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
      click() {
        if (this.tagName === "A" && this.download) downloadedFiles.push({ name: this.download, href: this.href });
        this.dispatchEvent({ type: "click" });
      },
      reset() {},
      set innerHTML(value) { throw new Error("Finance data must be rendered using text nodes"); }
    };
  }
  const periods = ["daily", "weekly", "monthly", "yearly"].map(period => {
    const button = node("button");
    button.dataset.financePeriod = period;
    nodes.set(`[data-finance-period="${period}"]`, button);
    return button;
  });
  const document = {
    readyState: "loading", hidden: false, body: node("body"),
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    querySelectorAll(selector) {
      if (selector === "[data-finance-period]") return periods;
      if (selector === "[data-expense-action]") return descendants(this.querySelector("#finance-expense-body")).filter(child => child["data-expense-action"]);
      return [];
    },
    createElement: node,
    createElementNS(namespace, name) { return node(name); },
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); },
    dispatchEvent(event) { events.push(event); (listeners.get(event.type) || []).forEach(handler => handler(event)); }
  };
  document.querySelector("#finance-report").hidden = true;
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  class DownloadUrl extends URL {
    static createObjectURL(blob) { downloads.push(blob); return `blob:finance-${downloads.length}`; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    document, window: { confirm: () => true, DapoerFinanceFiles: options.files }, fetch, CustomEvent, AbortController,
    Date: ClockDate, Intl, URLSearchParams, URL: DownloadUrl, Blob, TextEncoder,
    crypto: { randomUUID: () => "13d58532-0e7b-4571-a731-3c9b1b8b9834" },
    confirm: () => true,
    setInterval(handler) { const id = ++timer; intervals.set(id, handler); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(handler) { handler(); return ++timer; }, clearTimeout() {}
  });
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/admin-finance.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, `globalThis.financeApi={state,init,setAuthenticated,loadReport,selectPeriod,changeDate,openExpenseEditor,closeExpenseEditor,saveExpense,deleteExpense,exportCsv,exportSelected,exportReport};})();`);
  vm.runInContext(source, context);
  context.financeApi.init();
  return {
    ...context.financeApi, document, events, intervals, downloads, downloadedFiles,
    element: selector => document.querySelector(selector),
    clock(value) { timestamp = Date.parse(value); },
    confirm(value) { context.window.confirm = context.confirm = () => value; }
  };
}

const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return data; } });
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
async function authenticatedDashboard(fetch, options) {
  const ui = financeDashboard(fetch, options);
  ui.setAuthenticated(true);
  await flush();
  return ui;
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function textOf(node) { return [node.textContent, ...descendants(node).map(child => child.textContent)].join(" "); }
function setField(ui, selector, value) {
  const input = ui.element(selector);
  input.value = String(value);
  input.dispatchEvent({ type: "input" });
  input.dispatchEvent({ type: "change" });
}
function fillExpense(ui, values = {}) {
  const expense = { date: "2026-10-06", amount: "12500", category: "bahan_baku", description: "Belanja keju", ...values };
  Object.entries(expense).forEach(([field, value]) => setField(ui, `#expense-${field}`, value));
}

const expense = (values = {}) => ({
  id: "6b541f17-b5ce-4ead-8d26-cc3f66ba5baf", date: "2026-10-06", category: "bahan_baku",
  description: "Belanja keju", amount: 12500, createdAt: "2026-10-06T01:00:00.000Z",
  updatedAt: "2026-10-06T01:00:00.123456Z", ...values
});
function report(values = {}) {
  const summary = {
    completedSales: 135000, completedCount: 5, orderValue: 216000, orderCount: 8,
    pendingValue: 54000, pendingCount: 2, cancelledValue: 27000, cancelledCount: 1,
    totalOrders: 8, expenseTotal: 12500, expenseCount: 1, recordedBalance: 122500
  };
  return {
    period: { type: "monthly", date: "2026-10-06", startDate: "2026-10-01", endDate: "2026-10-31", timeZone: "Asia/Jakarta" },
    previousPeriod: { type: "monthly", date: "2026-09-06", startDate: "2026-09-01", endDate: "2026-09-30", timeZone: "Asia/Jakarta" },
    summary, previousSummary: { ...summary, completedSales: 0, expenseTotal: 0, recordedBalance: 0 },
    comparison: {
      completedSales: { difference: 135000, percent: null },
      expenseTotal: { difference: 12500, percent: null },
      recordedBalance: { difference: 122500, percent: null }
    },
    buckets: [{ date: "2026-10-06", ...summary }],
    paymentMethods: [{ paymentMethod: "cash", completedSales: 135000, completedCount: 5, orderValue: 216000, orderCount: 8 }],
    expenseCategories: [{ category: "bahan_baku", total: 12500, count: 1 }],
    expenses: [expense()],
    expensePagination: { page: 1, pageSize: 100, total: 1, totalPages: 1, hasMore: false },
    categories: [
      { id: "bahan_baku", label: "Bahan baku" }, { id: "kemasan", label: "Kemasan" },
      { id: "operasional", label: "Operasional" }, { id: "transportasi", label: "Transportasi" },
      { id: "pemasaran", label: "Pemasaran" }, { id: "lainnya", label: "Lainnya" }
    ],
    basis: { income: "Pesanan selesai", balance: "Pemasukan dikurangi pengeluaran tercatat", time: "WIB" },
    ...values
  };
}
function reportForUrl(url, values = {}) {
  const query = new URL(url, "https://test.example").searchParams;
  const result = report(values);
  const type = query.get("period");
  const date = query.get("date");
  const anchor = new Date(`${date}T00:00:00Z`);
  const calendar = value => new Date(value).toISOString().slice(0, 10);
  let startDate = date;
  let endDate = date;
  if (type === "weekly") {
    const monday = anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * 86400000;
    startDate = calendar(monday);
    endDate = calendar(monday + 6 * 86400000);
  } else if (type === "monthly") {
    startDate = calendar(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    endDate = calendar(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
  } else if (type === "yearly") {
    startDate = `${date.slice(0, 4)}-01-01`;
    endDate = `${date.slice(0, 4)}-12-31`;
  }
  result.period = { type, date, startDate, endDate, timeZone: "Asia/Jakarta" };
  return result;
}

test("finance starts at today's WIB date and remains private before login", async () => {
  let requests = 0;
  const ui = financeDashboard(async () => { requests++; return response(report()); });
  assert.equal(ui.state.date, "2026-10-06");
  assert.equal(ui.state.period, "monthly");
  await ui.loadReport();
  ui.openExpenseEditor();
  await ui.exportCsv();
  assert.equal(requests, 0);
  assert.equal(ui.element("#finance-export").disabled, true);
  assert.equal(ui.element("#expense-editor").open, false);
  assert.equal(ui.downloads.length, 0);
});

test("the four period buttons request the selected date without invalid period requests", async () => {
  const urls = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    urls.push(url);
    assert.equal(options.cache, "no-store");
    return response(reportForUrl(url));
  });
  for (const period of ["daily", "weekly", "yearly", "monthly"]) {
    ui.element(`[data-finance-period="${period}"]`).click();
    await flush();
    assert.equal(ui.state.period, period);
    const query = new URL(urls.at(-1), "https://test.example").searchParams;
    assert.equal(query.get("period"), period);
    assert.equal(query.get("date"), "2026-10-06");
  }
  const count = urls.length;
  await ui.selectPeriod("quarterly");
  assert.equal(ui.state.period, "monthly");
  assert.equal(urls.length, count);
  assert.equal(ui.element("#finance-export").disabled, false);
});

test("invalid calendar dates are rejected and manual historical dates survive later clock changes", async () => {
  const urls = [];
  const ui = await authenticatedDashboard(async url => { urls.push(url); return response(reportForUrl(url)); });
  for (const date of ["2026-02-29", "2026-04-31", "2026-10-6", "2026-00-01", "1999-12-31", "2101-01-01", "", "invalid"]) await ui.changeDate(date);
  assert.equal(ui.state.date, "2026-10-06");
  assert.equal(urls.length, 1);
  await ui.changeDate("2026-09-12");
  ui.clock("2026-10-07T17:00:00Z");
  await ui.loadReport();
  assert.equal(ui.state.date, "2026-09-12");
  assert.equal(new URL(urls.at(-1), "https://test.example").searchParams.get("date"), "2026-09-12");
});

test("period navigation handles leap days, short months, and year boundaries", async () => {
  const ui = await authenticatedDashboard(async url => response(reportForUrl(url)));
  for (const [period, date, previous] of [
    ["daily", "2028-03-01", "2028-02-29"],
    ["weekly", "2026-01-01", "2025-12-25"],
    ["monthly", "2026-03-31", "2026-02-28"],
    ["yearly", "2028-02-29", "2027-02-28"]
  ]) {
    await ui.selectPeriod(period);
    await ui.changeDate(date);
    ui.element("#finance-prev").click();
    await flush();
    assert.equal(ui.state.date, previous, `${period} navigation`);
  }
});

test("automatic refresh advances today's report at WIB midnight but leaves selected history fixed", async () => {
  const ui = await authenticatedDashboard(async url => response(reportForUrl(url)));
  assert.equal(ui.intervals.size, 1);
  const tick = ui.intervals.values().next().value;
  ui.clock("2026-10-06T16:59:59.999Z");
  tick();
  await flush();
  assert.equal(ui.state.date, "2026-10-06");
  ui.clock("2026-10-06T17:00:00Z");
  tick();
  await flush();
  assert.equal(ui.state.date, "2026-10-07");
  await ui.changeDate("2026-10-04");
  ui.clock("2026-10-07T17:00:00Z");
  tick();
  await flush();
  assert.equal(ui.state.date, "2026-10-04");
});

test("summary cards separate completed sales from pending orders and explain an unfinished period", async () => {
  const ui = await authenticatedDashboard(async () => response(report()));
  assert.equal(ui.element("#finance-completed-sales").textContent, "Rp 135.000");
  assert.equal(ui.element("#finance-pending-sales").textContent, "Rp 54.000");
  assert.equal(ui.element("#finance-expenses-total").textContent, "Rp 12.500");
  assert.equal(ui.element("#finance-balance").textContent, "Rp 122.500");
  assert.match(ui.element("#finance-orders-note").textContent, /1 dibatalkan/);
  assert.match(ui.element("#finance-orders-note").textContent, /dikeluarkan dari penjualan/);
  assert.match(ui.element("#finance-sales-comparison").textContent, /Belum ada nilai pembanding/);
  assert.match(ui.element("#finance-sales-comparison").textContent, /[Pp]eriode ini masih berjalan/);
  assert.doesNotMatch(ui.element("#finance-sales-comparison").textContent, /NaN|Infinity|100%/);
});

test("wrong report anchors, time zones, unsafe values, and fractional rupiah are rejected", async () => {
  const malformed = [
    report({ period: { ...report().period, date: "2026-10-07" } }),
    report({ period: { ...report().period, type: "daily" } }),
    report({ period: { ...report().period, timeZone: "UTC" } }),
    report({ period: { ...report().period, startDate: "2026-10-08" } }),
    report({ period: { ...report().period, endDate: "2026-10-05" } }),
    report({ summary: { ...report().summary, completedSales: 1.5 } }),
    report({ summary: { ...report().summary, expenseTotal: -1 } }),
    report({ summary: { ...report().summary, totalOrders: Number.MAX_SAFE_INTEGER + 1 } }),
    report({ summary: { ...report().summary, recordedBalance: Infinity } }),
    report({ summary: { ...report().summary, completedCount: "5" } })
  ];
  for (const invalid of malformed) {
    const ui = await authenticatedDashboard(async () => response(invalid));
    assert.equal(ui.state.report, null);
    assert.equal(ui.element("#finance-report").hidden, true);
    assert.equal(ui.element("#finance-export").disabled, true);
    assert.match(ui.element("#finance-message").textContent, /Data laporan belum lengkap/);
  }
});

test("a valid weekly report may begin in 1999 for a selectable January 2000 anchor", async () => {
  const ui = await authenticatedDashboard(async url => response(reportForUrl(url)));
  await ui.selectPeriod("weekly");
  await ui.changeDate("2000-01-01");
  assert.equal(ui.state.report.period.startDate, "1999-12-27");
  assert.equal(ui.state.report.period.endDate, "2000-01-02");
  assert.equal(ui.element("#finance-report").hidden, false);
  assert.equal(ui.element("#finance-export").disabled, false);
  assert.match(ui.element("#finance-period-label").textContent, /1999/);
});

test("switching periods hides the old financial snapshot and ignores a slow obsolete response", async () => {
  let resolveOld;
  let resolveNew;
  let oldSignal;
  let reads = 0;
  const waiting = await authenticatedDashboard((url, options) => {
    if (++reads === 1) return Promise.resolve(response(report()));
    if (reads === 2) {
      oldSignal = options.signal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return new Promise(resolve => { resolveNew = resolve; });
  });
  assert.equal(waiting.element("#finance-export").disabled, false);
  const oldPoll = waiting.loadReport(true);
  const next = waiting.selectPeriod("yearly");
  assert.equal(oldSignal.aborted, true);
  assert.equal(waiting.state.report, null);
  assert.equal(waiting.element("#finance-export").disabled, true);
  resolveNew(response(report({ period: { type: "yearly", date: "2026-10-06", startDate: "2026-01-01", endDate: "2026-12-31", timeZone: "Asia/Jakarta" } })));
  await next;
  await flush();
  resolveOld(response(report({ summary: { ...report().summary, completedSales: 999999 } })));
  await oldPoll;
  assert.equal(waiting.state.report.period.type, "yearly");
  assert.equal(waiting.state.report.summary.completedSales, 135000);
  assert.equal(waiting.element("#finance-refresh").disabled, false);
});

test("ordinary refreshes and visibility events share one request and hidden polling does not fetch", async () => {
  let finish;
  let reads = 0;
  const ui = financeDashboard(() => { reads++; return new Promise(resolve => { finish = resolve; }); });
  ui.setAuthenticated(true);
  const duplicatePoll = ui.loadReport(true);
  const duplicateRefresh = ui.loadReport(false);
  ui.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(reads, 1);
  finish(response(report()));
  await Promise.all([duplicatePoll, duplicateRefresh]);
  await flush();
  ui.document.hidden = true;
  ui.document.dispatchEvent({ type: "visibilitychange" });
  await ui.loadReport(true);
  assert.equal(reads, 1);
  assert.equal(ui.element("#finance-refresh").disabled, false);
});

test("an order change invalidates a pending report or export and ignores its old sales snapshot", async () => {
  for (const operation of ["report", "export"]) {
    let reads = 0;
    let finishOld;
    let oldSignal;
    const ui = await authenticatedDashboard((url, options) => {
      if (++reads === 2) {
        oldSignal = options.signal;
        return new Promise(resolve => { finishOld = resolve; });
      }
      const completedSales = reads === 1 ? 135000 : 222000;
      return Promise.resolve(response(report({ summary: { ...report().summary, completedSales } })));
    });
    const pending = operation === "report" ? ui.loadReport(true) : ui.exportCsv();
    ui.document.dispatchEvent({ type: "dapoer:stock-changed" });
    assert.equal(oldSignal.aborted, true, `${operation} cancellation`);
    await flush();
    assert.equal(reads, 3);
    assert.equal(ui.state.report.summary.completedSales, 222000);
    finishOld(response(report()));
    await pending;
    assert.equal(ui.state.report.summary.completedSales, 222000);
    assert.equal(ui.element("#finance-completed-sales").textContent, "Rp 222.000");
    assert.equal(ui.element("#finance-refresh").disabled, false);
    assert.equal(ui.downloads.length, 0);
  }
});

test("an order change during an expense write waits for its result and refreshes after success or failure", async () => {
  for (const success of [true, false]) {
    let reads = 0;
    let writes = 0;
    let finishSave;
    const ui = await authenticatedDashboard((url, options) => {
      if (options.method === "PATCH") {
        writes++;
        return new Promise(resolve => { finishSave = resolve; });
      }
      const completedSales = ++reads === 1 ? 135000 : 222000;
      return Promise.resolve(response(report({ summary: { ...report().summary, completedSales } })));
    });
    ui.openExpenseEditor(expense());
    fillExpense(ui, { amount: "25000" });
    const pending = ui.saveExpense();
    ui.document.dispatchEvent({ type: "dapoer:stock-changed" });
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.equal(ui.element("#expense-save").disabled, true);
    finishSave(success ? response({ expense: expense({ amount: 25000 }) }) : response({ error: "Pengeluaran gagal disimpan." }, 503));
    await pending;
    assert.equal(reads, 2);
    assert.equal(ui.state.report.summary.completedSales, 222000);
    assert.equal(ui.element("#expense-editor").open, !success);
    if (!success) {
      assert.equal(ui.element("#expense-amount").value, "25000");
      assert.match(ui.element("#expense-message").textContent, /Pengeluaran gagal disimpan/);
      assert.equal(ui.element("#expense-save").disabled, false);
    }
  }
});

test("logging out clears financial rows and aborts a report that cannot later restore them", async () => {
  let finish;
  let signal;
  let reads = 0;
  const ui = await authenticatedDashboard((url, options) => {
    if (++reads === 1) return Promise.resolve(response(report()));
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  ui.openExpenseEditor(expense());
  const pending = ui.loadReport(true);
  ui.setAuthenticated(false);
  assert.equal(signal.aborted, true);
  assert.equal(ui.state.report, null);
  assert.equal(ui.element("#expense-editor").open, false);
  assert.equal(ui.element("#finance-expense-body").children.length, 0);
  assert.equal(ui.element("#finance-breakdown-body").children.length, 0);
  assert.equal(ui.element("#finance-payment-body").children.length, 0);
  assert.equal(ui.element("#finance-export").disabled, true);
  finish(response(report()));
  await pending;
  assert.equal(ui.state.report, null);
  assert.equal(ui.element("#finance-expense-body").children.length, 0);
});

test("an expired report session removes sensitive data and notifies the login module", async () => {
  let reads = 0;
  const ui = await authenticatedDashboard(async () => ++reads === 1 ? response(report()) : response({ error: "Unauthorized" }, 401));
  await ui.loadReport();
  assert.equal(ui.state.authenticated, false);
  assert.equal(ui.state.report, null);
  assert.equal(ui.element("#finance-expense-body").children.length, 0);
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.events.filter(event => event.type === "dapoer:admin-session-expired").length, 1);
});

test("a failed report change exposes the API error and prevents exporting an older period", async () => {
  let reads = 0;
  const ui = await authenticatedDashboard(async () => ++reads === 1 ? response(report()) : response({ error: "Database belum siap" }, 503));
  await ui.selectPeriod("daily");
  await flush();
  assert.equal(ui.state.report, null);
  assert.equal(ui.element("#finance-export").disabled, true);
  assert.equal(ui.element("#finance-refresh").disabled, false);
  assert.match(ui.element("#finance-message").textContent, /Database belum siap/);
  await ui.exportCsv();
  assert.equal(ui.downloads.length, 0);
});

test("expense descriptions and payment labels are inserted as text, including HTML payloads", async () => {
  const payload = '<img src=x onerror="alert(1)">';
  const ui = await authenticatedDashboard(async () => response(report({
    expenses: [expense({ description: payload })],
    paymentMethods: [{ paymentMethod: payload, completedSales: 135000, completedCount: 5, orderValue: 216000, orderCount: 8 }]
  })));
  assert.match(textOf(ui.element("#finance-expense-body")), /<img src=x/);
  assert.match(textOf(ui.element("#finance-payment-body")), /<img src=x/);
  assert.equal(descendants(ui.element("#finance-expense-body")).some(node => node.tagName === "IMG"), false);
});

test("expense inputs reject invalid amounts, future dates, blank descriptions, and unknown categories", async () => {
  let writes = 0;
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method && options.method !== "GET") writes++;
    return response(report());
  });
  ui.openExpenseEditor();
  for (const amount of ["", "0", "-1", "1.5", "1e3", "1000000000001", "Infinity"]) {
    fillExpense(ui, { amount });
    await ui.saveExpense();
  }
  for (const values of [
    { date: "2026-10-07" }, { date: "2026-02-29" }, { date: "" },
    { description: "  " }, { description: "x".repeat(201) }, { description: "keju\nsusu" },
    { description: "keju\u0000susu" }, { description: "\tBelanja bahan" }, { category: "unknown" }
  ]) {
    fillExpense(ui, values);
    await ui.saveExpense();
  }
  assert.equal(writes, 0);
  assert.equal(ui.element("#expense-editor").open, true);
});

test("new expense submission sends integer rupiah with a retry-safe UUID and reloads the report", async () => {
  const writes = [];
  let reads = 0;
  const ui = await authenticatedDashboard(async (url, options) => {
    assert.equal(url.split("?")[0], "/api/admin/finance");
    if (!options.method || options.method === "GET") { reads++; return response(report()); }
    writes.push({ method: options.method, body: JSON.parse(options.body) });
    return response({ expense: expense({ ...writes.at(-1).body }) });
  });
  ui.openExpenseEditor();
  fillExpense(ui, { amount: "1000000000000", description: "  Belanja bahan  " });
  let prevented = false;
  ui.element("#expense-form").dispatchEvent({ type: "submit", preventDefault() { prevented = true; } });
  await flush();
  assert.equal(prevented, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { method: "POST", body: {
    id: "13d58532-0e7b-4571-a731-3c9b1b8b9834", date: "2026-10-06", amount: 1000000000000,
    category: "bahan_baku", description: "Belanja bahan"
  } });
  assert.ok(reads >= 2);
  assert.equal(ui.element("#expense-editor").open, false);
});

test("editing preserves the exact optimistic concurrency token rather than rounding timestamps", async () => {
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (!options.method || options.method === "GET") return response(report());
    writes.push({ method: options.method, body: JSON.parse(options.body) });
    return response({ expense: expense({ amount: 25000 }) });
  });
  ui.openExpenseEditor(expense());
  assert.equal(ui.element("#expense-amount").value, "12500");
  fillExpense(ui, { amount: "25000", category: "kemasan", description: "Kotak pasta" });
  await ui.saveExpense();
  assert.deepEqual(writes, [{ method: "PATCH", body: {
    id: expense().id, date: "2026-10-06", amount: 25000, category: "kemasan", description: "Kotak pasta",
    expectedUpdatedAt: "2026-10-06T01:00:00.123456Z"
  } }]);
});

test("deleting an expense waits for confirmation, supports cancel, and sends the reviewed version", async () => {
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (!options.method || options.method === "GET") return response(report());
    writes.push({ method: options.method, body: JSON.parse(options.body) });
    return response({ deleted: true, id: expense().id });
  });
  ui.deleteExpense(expense());
  assert.equal(ui.element("#expense-editor").open, true);
  assert.equal(writes.length, 0);
  ui.element("#expense-cancel").click();
  assert.equal(ui.element("#expense-editor").open, false);
  assert.equal(writes.length, 0);
  ui.deleteExpense(expense());
  await ui.saveExpense();
  assert.deepEqual(writes, [{ method: "DELETE", body: { id: expense().id, expectedUpdatedAt: expense().updatedAt } }]);
});

test("a save in progress blocks duplicate writes, dismissal, and editing a different expense", async () => {
  let finish;
  let writes = 0;
  const ui = await authenticatedDashboard((url, options) => {
    if (!options.method || options.method === "GET") return Promise.resolve(response(report()));
    writes++;
    return new Promise(resolve => { finish = resolve; });
  });
  ui.openExpenseEditor(expense());
  fillExpense(ui, { amount: "25000" });
  const pending = ui.saveExpense();
  assert.equal(ui.element("#expense-save").disabled, true);
  assert.equal(ui.element("#expense-cancel").disabled, true);
  assert.equal(ui.element("#expense-amount").disabled, true);
  assert.equal(ui.element("#finance-date").disabled, true);
  assert.equal(ui.element("#finance-prev").disabled, true);
  assert.ok(ui.document.querySelectorAll("[data-expense-action]").every(button => button.disabled));
  await ui.saveExpense();
  await ui.selectPeriod("daily");
  ui.closeExpenseEditor();
  let prevented = false;
  ui.element("#expense-editor").dispatchEvent({ type: "cancel", preventDefault() { prevented = true; } });
  ui.openExpenseEditor(expense({ id: "different" }));
  assert.equal(writes, 1);
  assert.equal(ui.state.period, "monthly");
  assert.equal(prevented, true);
  assert.equal(ui.element("#expense-editor").open, true);
  assert.equal(ui.element("#expense-amount").value, "25000");
  finish(response({ expense: expense({ amount: 25000 }) }));
  await pending;
  assert.equal(ui.element("#expense-editor").open, false);
});

test("network failures preserve a new expense draft and reuse its UUID during an explicit retry", async () => {
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (!options.method || options.method === "GET") return response(report());
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) throw new Error("Koneksi terputus");
    return response({ expense: expense(writes.at(-1)) });
  });
  ui.openExpenseEditor();
  fillExpense(ui);
  await ui.saveExpense();
  assert.equal(ui.element("#expense-editor").open, true);
  assert.equal(ui.element("#expense-amount").value, "12500");
  assert.match(ui.element("#expense-message").textContent, /Koneksi terputus/);
  assert.equal(ui.element("#expense-save").disabled, false);
  await ui.saveExpense();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(ui.element("#expense-editor").open, false);
});

test("a stale expense version keeps the draft and requires reviewing fresh data before resaving", async () => {
  const writes = [];
  let current = expense();
  const ui = await authenticatedDashboard(async (url, options) => {
    if (!options.method || options.method === "GET") return response(report({ expenses: [current] }));
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) {
      current = expense({ amount: 20000, updatedAt: "2026-10-06T02:00:00.654321Z" });
      return response({ error: "Pengeluaran telah berubah.", code: "EXPENSE_CONFLICT" }, 409);
    }
    return response({ expense: expense({ amount: 25000 }) });
  });
  ui.openExpenseEditor(expense());
  fillExpense(ui, { amount: "25000" });
  await ui.saveExpense();
  assert.equal(ui.element("#expense-editor").open, true);
  assert.equal(ui.element("#expense-amount").value, "25000");
  assert.equal(ui.element("#expense-save").disabled, true);
  assert.equal(ui.state.report.expenses[0].amount, 20000);
  await ui.saveExpense();
  assert.equal(writes.length, 1);
  ui.closeExpenseEditor();
  ui.openExpenseEditor(ui.state.report.expenses[0]);
  fillExpense(ui, { amount: "25000" });
  await ui.saveExpense();
  assert.equal(writes.length, 2);
  assert.equal(writes[0].expectedUpdatedAt, "2026-10-06T01:00:00.123456Z");
  assert.equal(writes[1].expectedUpdatedAt, "2026-10-06T02:00:00.654321Z");
});

test("saving an expense invalidates a pre-save report request and keeps the fresh totals", async () => {
  let reads = 0;
  let finishOld;
  let oldSignal;
  const ui = await authenticatedDashboard((url, options) => {
    if (options.method && options.method !== "GET") return Promise.resolve(response({ expense: expense({ amount: 25000 }) }));
    if (++reads === 2) {
      oldSignal = options.signal;
      return new Promise(resolve => { finishOld = resolve; });
    }
    return Promise.resolve(response(report({ summary: { ...report().summary, expenseTotal: reads === 1 ? 12500 : 25000 } })));
  });
  ui.openExpenseEditor(expense());
  fillExpense(ui, { amount: "25000" });
  const oldPoll = ui.loadReport(true);
  await ui.saveExpense();
  assert.equal(oldSignal.aborted, true);
  assert.equal(ui.state.report.summary.expenseTotal, 25000);
  finishOld(response(report()));
  await oldPoll;
  assert.equal(ui.state.report.summary.expenseTotal, 25000);
});

test("a late expense save after logout cannot restore private data or open dialogs", async () => {
  let finish;
  let reads = 0;
  const ui = await authenticatedDashboard((url, options) => {
    if (!options.method || options.method === "GET") { reads++; return Promise.resolve(response(report())); }
    return new Promise(resolve => { finish = resolve; });
  });
  ui.openExpenseEditor(expense());
  fillExpense(ui, { amount: "25000" });
  const pending = ui.saveExpense();
  ui.setAuthenticated(false);
  finish(response({ expense: expense({ amount: 25000 }) }));
  await pending;
  assert.equal(reads, 1);
  assert.equal(ui.state.report, null);
  assert.equal(ui.element("#expense-editor").open, false);
  assert.equal(ui.element("#finance-expense-body").children.length, 0);
});

test("an expired expense save session clears the dialog and financial report", async () => {
  const ui = await authenticatedDashboard(async (url, options) => !options.method || options.method === "GET"
    ? response(report()) : response({ error: "Unauthorized" }, 401));
  ui.openExpenseEditor(expense());
  fillExpense(ui, { amount: "25000" });
  await ui.saveExpense();
  assert.equal(ui.state.authenticated, false);
  assert.equal(ui.state.report, null);
  assert.equal(ui.element("#expense-editor").open, false);
  assert.equal(ui.events.filter(event => event.type === "dapoer:admin-session-expired").length, 1);
});

test("CSV export quotes labels and neutralizes spreadsheet formulas", async () => {
  const formula = '=HYPERLINK("https://bad.example","click"),\nline';
  const formulas = [formula, "+SUM(1,2)", "-2+3", "@SUM(1)", "  =1+1", "\t=1+1", "\r=1+1"];
  const ui = await authenticatedDashboard(async () => response(report({
    paymentMethods: formulas.map(paymentMethod => ({ paymentMethod, completedSales: 135000, completedCount: 5, orderValue: 216000, orderCount: 8 }))
  })));
  await ui.exportCsv();
  assert.equal(ui.downloads.length, 1);
  const csv = await ui.downloads[0].text();
  for (const value of formulas) assert.ok(csv.includes(`"'${value.replace(/"/g, '""')}"`), `Formula was not escaped: ${JSON.stringify(value)}`);
  assert.ok(csv.includes("135000"));
  assert.ok(csv.includes("12500"));
  assert.match(csv, /2026-10-06/);
});

function paginatedExportReport(url, values = {}) {
  const query = new URL(url, "https://test.example").searchParams;
  const page = Number(query.get("expensePage") || 1);
  const pageSize = Number(query.get("expensePageSize") || 10);
  const entries = Array.from({ length: 101 }, (_, index) => expense({
    id: `6b541f17-b5ce-4ead-8d26-${String(index).padStart(12, "0")}`,
    description: `Baris pengeluaran ${index + 1}`
  }));
  return reportForUrl(url, {
    summary: { ...report().summary, expenseCount: 101, expenseTotal: 1262500, recordedBalance: -1127500 },
    expenses: entries.slice((page - 1) * pageSize, page * pageSize),
    expenseCategories: [{ category: "bahan_baku", total: 1262500, count: 101 }],
    expensePagination: { page, pageSize, total: 101, totalPages: Math.ceil(101 / pageSize), hasMore: page < Math.ceil(101 / pageSize) },
    ...values
  });
}

test("expense pagination changes the visible ledger while totals still cover the whole period", async () => {
  const urls = [];
  const ui = await authenticatedDashboard(async url => { urls.push(url); return response(paginatedExportReport(url)); });
  const descriptions = () => descendants(ui.element("#finance-expense-body"))
    .filter(node => node.className === "finance-expense-description").map(node => node.textContent);
  assert.deepEqual(descriptions(), Array.from({ length: 10 }, (_, index) => `Baris pengeluaran ${index + 1}`));
  assert.equal(ui.element("#finance-expense-prev").disabled, true);
  ui.element("#finance-expense-next").click();
  await flush();
  assert.deepEqual(descriptions(), Array.from({ length: 10 }, (_, index) => `Baris pengeluaran ${index + 11}`));
  assert.equal(ui.state.report.summary.expenseCount, 101);
  assert.equal(ui.element("#finance-expenses-total").textContent, "Rp 1.262.500");
  assert.equal(new URL(urls.at(-1), "https://test.example").searchParams.get("expensePage"), "2");
  await ui.selectPeriod("daily");
  assert.equal(new URL(urls.at(-1), "https://test.example").searchParams.get("expensePage"), "1");
});

test("deleting the last expense on page two loads the remaining valid page and its totals", async () => {
  let deleted = false;
  const pages = [];
  const entries = Array.from({ length: 11 }, (_, index) => expense({
    id: `6b541f17-b5ce-4ead-8d26-${String(index).padStart(12, "0")}`,
    description: `Catatan ${index + 1}`
  }));
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method === "DELETE") {
      const payload = JSON.parse(options.body);
      assert.equal(payload.id, entries[10].id);
      deleted = true;
      return response({ deleted: true, id: payload.id });
    }
    const page = Number(new URL(url, "https://test.example").searchParams.get("expensePage"));
    pages.push(page);
    const remaining = deleted ? entries.slice(0, 10) : entries;
    const total = remaining.length;
    const expenseTotal = total * 12500;
    return response(reportForUrl(url, {
      summary: { ...report().summary, expenseCount: total, expenseTotal, recordedBalance: 135000 - expenseTotal },
      expenses: remaining.slice((page - 1) * 10, page * 10),
      expenseCategories: [{ category: "bahan_baku", total: expenseTotal, count: total }],
      expensePagination: { page, pageSize: 10, total, totalPages: Math.ceil(total / 10), hasMore: page < Math.ceil(total / 10) }
    }));
  });
  ui.element("#finance-expense-next").click();
  await flush();
  assert.equal(ui.state.report.expenses.length, 1);
  assert.equal(ui.state.report.expenses[0].description, "Catatan 11");
  ui.deleteExpense(ui.state.report.expenses[0]);
  await ui.saveExpense();
  assert.deepEqual(pages, [1, 2, 2, 1]);
  assert.equal(ui.state.expensePage, 1);
  assert.equal(ui.state.report.expenses.length, 10);
  assert.equal(ui.state.report.summary.expenseCount, 10);
  assert.equal(ui.element("#finance-expenses-total").textContent, "Rp 125.000");
  assert.equal(ui.element("#finance-expense-page-label").textContent, "Halaman 1 dari 1 · 10 catatan");
  assert.equal(ui.element("#finance-expense-next").disabled, true);
  assert.equal(ui.element("#expense-editor").open, false);
  assert.doesNotMatch(textOf(ui.element("#finance-expense-body")), /Belum ada pengeluaran/);
});

test("CSV uses one fresh snapshot with full-period totals even when expense details are paginated", async () => {
  const urls = [];
  const ui = await authenticatedDashboard(async url => { urls.push(url); return response(paginatedExportReport(url)); });
  assert.equal(ui.state.report.expenses.length, 10);
  await ui.exportCsv();
  assert.equal(ui.downloads.length, 1);
  assert.equal(urls.length, 2);
  const exportQueries = urls.slice(1).map(url => new URL(url, "https://test.example").searchParams);
  assert.deepEqual(exportQueries.map(query => query.get("expensePage")), ["1"]);
  const csv = await ui.downloads[0].text();
  assert.ok(csv.includes('"1262500"'));
  assert.ok(csv.includes('"101"'));
  assert.ok(csv.includes('"Bahan baku"'));
  assert.ok(csv.includes('"2026-10-06"'));
  assert.equal(csv.includes("ID pengeluaran"), false);
  assert.equal(csv.includes("Baris pengeluaran"), false);
});

test("CSV is built from a fresh report rather than the dashboard's older numbers", async () => {
  let reads = 0;
  const ui = await authenticatedDashboard(async () => {
    const summary = { ...report().summary, completedSales: ++reads === 1 ? 135000 : 222000 };
    return response(report({ summary, buckets: [{ date: "2026-10-06", ...summary }] }));
  });
  await ui.exportCsv();
  assert.equal(reads, 2);
  assert.equal(ui.downloads.length, 1);
  const csv = await ui.downloads[0].text();
  assert.ok(csv.includes('"Penjualan selesai","222000","5"'));
  assert.equal(ui.element("#finance-export").disabled, false);
});

test("an export response arriving after logout cannot download private financial data", async () => {
  let reads = 0;
  let finish;
  let signal;
  const ui = await authenticatedDashboard((url, options) => {
    if (++reads === 1) return Promise.resolve(response(report()));
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = ui.exportCsv();
  ui.setAuthenticated(false);
  assert.equal(signal.aborted, true);
  finish(response(report()));
  await pending;
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.state.report, null);
});

test("all download formats remain private and the selector starts with PDF before login", async () => {
  let requests = 0;
  let builds = 0;
  const ui = financeDashboard(async () => { requests++; return response(report()); }, {
    files: { async build() { builds++; return { blob: new Blob(["private"]), extension: "pdf" }; } }
  });
  assert.equal(ui.element("#finance-export-format").value, "pdf");
  assert.equal(ui.element("#finance-export-format").disabled, true);
  for (const format of ["pdf", "xlsx", "ods", "csv", "json", "txt"]) await ui.exportReport(format);
  ui.element("#finance-export").click();
  await flush();
  assert.equal(requests, 0);
  assert.equal(builds, 0);
  assert.equal(ui.downloads.length, 0);
});

test("the format selector downloads PDF, Excel, and ODS from a fresh WIB snapshot", async () => {
  let reads = 0;
  const builds = [];
  const blobs = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    assert.equal(options.cache, "no-store");
    const summary = { ...report().summary, completedSales: 100000 + ++reads };
    return response(reportForUrl(url, { summary, buckets: [{ date: "2026-10-06", ...summary }] }));
  }, {
    files: { async build(snapshot, options) {
      builds.push({ snapshot, options });
      const blob = new Blob([`${options.format}:${snapshot.summary.completedSales}`]);
      blobs.push(blob);
      return { blob, extension: options.format };
    } }
  });
  assert.equal(ui.element("#finance-export-format").value, "pdf");
  const dashboardSales = ui.state.report.summary.completedSales;
  for (const [index, format] of ["pdf", "xlsx", "ods"].entries()) {
    setField(ui, "#finance-export-format", format);
    ui.element("#finance-export").click();
    await flush();
    const built = builds[index];
    assert.equal(built.options.format, format);
    assert.equal(built.options.periodLabel, "Bulanan");
    assert.equal(built.options.generatedDate, "2026-10-06", "UTC evening downloads use the next WIB date");
    assert.equal(built.options.signal.aborted, false);
    assert.equal(built.snapshot.period.timeZone, "Asia/Jakarta");
    assert.equal(built.snapshot.summary.completedSales, 100002 + index);
    assert.notEqual(built.snapshot.summary.completedSales, dashboardSales);
    assert.equal(ui.downloads[index], blobs[index]);
    assert.equal(ui.downloadedFiles[index].name, `laporan-keuangan-monthly-2026-10-01-2026-10-31.${format}`);
    assert.equal(ui.element("#finance-export-format").disabled, false);
  }
  assert.equal(reads, 4, "each file gets exactly one fresh aggregate request");
  assert.equal(ui.state.report.summary.completedSales, dashboardSales);
});

test("a delayed file builder captures its selected format and prevents duplicate downloads", async () => {
  let reads = 0;
  let finishBuild;
  const builds = [];
  const ui = await authenticatedDashboard(async url => { reads++; return response(reportForUrl(url)); }, {
    files: { build(snapshot, options) {
      builds.push(options.format);
      return new Promise(resolve => { finishBuild = resolve; });
    } }
  });
  const pending = ui.exportSelected();
  await flush();
  assert.equal(ui.element("#finance-export-format").disabled, true);
  assert.equal(ui.element("#finance-export").disabled, true);
  assert.match(ui.element("#finance-export").textContent, /Menyiapkan PDF/);
  setField(ui, "#finance-export-format", "xlsx");
  ui.element("#finance-export").click();
  await ui.exportSelected();
  await ui.exportReport("ods");
  assert.equal(reads, 2);
  assert.deepEqual(builds, ["pdf"]);
  finishBuild({ blob: new Blob(["finished PDF"]), extension: "pdf" });
  await pending;
  assert.equal(ui.downloads.length, 1);
  assert.match(ui.downloadedFiles[0].name, /\.pdf$/);
  assert.match(ui.element("#finance-message").textContent, /Laporan PDF/);
  assert.equal(ui.element("#finance-export-format").value, "xlsx");
  assert.equal(ui.element("#finance-export-format").disabled, false);
});

test("files finishing after logout, a period change, or an order refresh cannot download stale private data", async () => {
  for (const invalidation of ["logout", "period", "order"]) {
    let reads = 0;
    let finishBuild;
    let builderSignal;
    const ui = await authenticatedDashboard(async url => {
      const summary = { ...report().summary, completedSales: 100000 + ++reads };
      return response(reportForUrl(url, { summary }));
    }, {
      files: { build(snapshot, options) {
        builderSignal = options.signal;
        return new Promise(resolve => { finishBuild = resolve; });
      } }
    });
    const pending = ui.exportSelected();
    await flush();
    assert.equal(builderSignal.aborted, false);
    if (invalidation === "logout") ui.document.dispatchEvent({ type: "dapoer:admin-session", detail: { authenticated: false } });
    else if (invalidation === "period") ui.element('[data-finance-period="daily"]').click();
    else ui.document.dispatchEvent({ type: "dapoer:stock-changed" });
    assert.equal(builderSignal.aborted, true, `${invalidation} aborts the file builder`);
    await flush();
    finishBuild({ blob: new Blob(["stale private report"]), extension: "pdf" });
    await pending;
    assert.equal(ui.downloads.length, 0, `${invalidation} suppresses a late download even if the builder ignores abort`);
    assert.equal(ui.state.exporting, null);
    assert.doesNotMatch(ui.element("#finance-message").textContent, /berhasil diunduh/);
    if (invalidation === "logout") {
      assert.equal(ui.state.report, null);
      assert.equal(ui.element("#finance-export-format").disabled, true);
    } else {
      assert.equal(ui.state.report.summary.completedSales, 100003);
      assert.equal(ui.element("#finance-export-format").disabled, false);
      assert.equal(ui.state.period, invalidation === "period" ? "daily" : "monthly");
    }
  }
});

test("builder failures leave the format controls usable for an explicit retry with fresh data", async () => {
  let reads = 0;
  let builds = 0;
  const ui = await authenticatedDashboard(async url => {
    const summary = { ...report().summary, completedSales: 100000 + ++reads };
    return response(reportForUrl(url, { summary }));
  }, {
    files: { async build(snapshot) {
      if (++builds === 1) throw new Error("PDF belum dapat disiapkan.");
      return { blob: new Blob([String(snapshot.summary.completedSales)]), extension: "pdf" };
    } }
  });
  ui.element("#finance-export").click();
  await flush();
  assert.equal(ui.downloads.length, 0);
  assert.match(ui.element("#finance-message").textContent, /PDF belum dapat disiapkan/);
  assert.equal(ui.element("#finance-message").classList.contains("error"), true);
  assert.equal(ui.state.exporting, null);
  assert.equal(ui.element("#finance-export-format").disabled, false);
  assert.equal(ui.element("#finance-export").disabled, false);
  ui.element("#finance-export").click();
  await flush();
  assert.equal(reads, 3);
  assert.equal(builds, 2);
  assert.equal(ui.downloads.length, 1);
  assert.equal(await ui.downloads[0].text(), "100003");
  assert.equal(ui.element("#finance-message").classList.contains("error"), false);
});

test("unavailable or malformed file builders never create mislabeled files and release the export controls", async () => {
  for (const files of [undefined,
    { async build() { return { blob: new Blob(["wrong type"]), extension: "xlsx" }; } },
    { async build() { return { blob: "not a Blob", extension: "pdf" }; } }
  ]) {
    const ui = await authenticatedDashboard(async url => response(reportForUrl(url)), { files });
    await ui.exportSelected();
    assert.equal(ui.downloads.length, 0);
    assert.equal(ui.state.exporting, null);
    assert.equal(ui.element("#finance-message").classList.contains("error"), true);
    assert.equal(ui.element("#finance-export-format").disabled, false);
    assert.equal(ui.element("#finance-export").disabled, false);
  }
});

test("unsupported selected formats are rejected before requesting private data or invoking the builder", async () => {
  let reads = 0;
  let builds = 0;
  const ui = await authenticatedDashboard(async url => { reads++; return response(reportForUrl(url)); }, {
    files: { async build() { builds++; throw new Error("must not build"); } }
  });
  for (const format of ["docx", "toString", "__proto__", ""]) {
    setField(ui, "#finance-export-format", format);
    await ui.exportSelected();
  }
  assert.equal(reads, 1);
  assert.equal(builds, 0);
  assert.equal(ui.downloads.length, 0);
  assert.match(ui.element("#finance-message").textContent, /Pilih format unduhan yang tersedia/);
});

test("JSON preserves numeric full-period aggregates while excluding the paginated expense ledger and customer data", async () => {
  const ui = await authenticatedDashboard(async url => response(paginatedExportReport(url, {
    summary: { ...report().summary, completedSales: 1000000000000, expenseTotal: 1000000000001, expenseCount: 101, recordedBalance: -1 },
    expenseCategories: [{ category: "bahan_baku", total: 1000000000001, count: 101 }],
    customerName: "Private Customer", customerPhone: "081234567890",
    orders: [{ customerName: "Private Customer", customerPhone: "081234567890" }]
  })));
  setField(ui, "#finance-export-format", "json");
  ui.element("#finance-export").click();
  await flush();
  assert.equal(ui.downloads.length, 1);
  assert.equal(ui.downloads[0].type, "application/json;charset=utf-8");
  assert.match(ui.downloadedFiles[0].name, /\.json$/);
  const text = await ui.downloads[0].text();
  const data = JSON.parse(text);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.generatedDate, "2026-10-06");
  assert.equal(data.summary.completedSales, 1000000000000);
  assert.equal(data.summary.expenseTotal, 1000000000001);
  assert.equal(data.summary.recordedBalance, -1);
  assert.equal(typeof data.summary.completedSales, "number");
  assert.equal(data.expenseCategories[0].count, 101);
  assert.equal(data.period.timeZone, "Asia/Jakarta");
  assert.deepEqual(data.buckets, JSON.parse(JSON.stringify(ui.state.report.buckets)));
  for (const excluded of ["expenses", "expensePagination", "orders", "customerName", "customerPhone"]) assert.equal(Object.hasOwn(data, excluded), false);
  assert.doesNotMatch(text, /Baris pengeluaran|Private Customer|081234567890/);
  assert.match(data.scope, /seluruh periode/);
});

test("text downloads preserve every bucket and negative amounts while keeping spreadsheet labels safe and rows intact", async () => {
  const summary = { ...report().summary, expenseTotal: 200000, expenseCount: 101, recordedBalance: -65000 };
  const buckets = Array.from({ length: 31 }, (_, index) => ({
    ...summary, date: `2026-10-${String(index + 1).padStart(2, "0")}`, recordedBalance: -(index + 1)
  }));
  const paymentMethods = ["=SUM(1,2)", " \t=SUM(1,\r\n2)", "\t+SUM(1,2)", "-2+3", "Cash\tTransfer\r\nWallet"]
    .map(paymentMethod => ({ paymentMethod, completedSales: 135000, completedCount: 5, orderValue: 216000, orderCount: 8 }));
  let reads = 0;
  const ui = await authenticatedDashboard(async url => {
    reads++;
    return response(paginatedExportReport(url, { summary, buckets, paymentMethods }));
  });
  setField(ui, "#finance-export-format", "txt");
  await ui.exportSelected();
  assert.equal(reads, 2);
  assert.equal(ui.downloads.length, 1);
  assert.equal(ui.downloads[0].type, "text/plain;charset=utf-8");
  assert.match(ui.downloadedFiles[0].name, /\.txt$/);
  const text = await ui.downloads[0].text();
  const lines = text.split("\r\n");
  const dateRows = lines.filter(row => /^2026-10-\d\d\t/.test(row));
  assert.equal(dateRows.length, 31);
  assert.equal(dateRows[0].split("\t").at(-1), "-1");
  assert.equal(dateRows.at(-1).split("\t").at(-1), "-31");
  assert.match(text, /Saldo tercatat\t-65000/);
  assert.match(text, /Pengeluaran tercatat\t200000\t101/);
  assert.match(text, /Tanggal unduhan WIB\t2026-10-06/);
  assert.doesNotMatch(text, /Baris pengeluaran/);
  const paymentStart = lines.indexOf("Metode pembayaran\tPesanan selesai\tPenjualan selesai (Rp)\tNilai pesanan aktif (Rp)") + 1;
  assert.ok(paymentStart > 0);
  const paymentRows = lines.slice(paymentStart, paymentStart + paymentMethods.length).map(row => row.split("\t"));
  assert.deepEqual(paymentRows.map(row => row[0]), ["'=SUM(1,2)", "'  =SUM(1,  2)", "' +SUM(1,2)", "'-2+3", "Cash Transfer  Wallet"]);
  assert.ok(paymentRows.every(row => row.length === 4 && row[1] === "5" && row[2] === "135000" && row[3] === "216000"));
  assert.ok(lines.every(line => !/[\r\n]/.test(line)), "untrusted label controls cannot introduce extra rows");
});
