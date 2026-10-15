const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SNAPSHOT = "c3d978a1-92ea-4a87-9dd5-d61e881efb55";
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return data; } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function dashboard(fetch, files = { async build() { return { blob: new Blob(["report"]), extension: "csv", label: "CSV" }; } }) {
  const nodes = new Map(), listeners = new Map(), intervals = new Map(), timeouts = new Map(), downloads = [];
  let timer = 0;
  function node(tag = "div") {
    const handlers = new Map(), classes = new Set();
    return {
      tagName: tag.toUpperCase(), value: "", textContent: "", children: [], dataset: {}, hidden: false, disabled: false,
      classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
      append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
      dispatchEvent(event) { (handlers.get(event.type) || []).forEach(handler => handler(event)); },
      setAttribute(name, value) { this[name] = value; },
      focus() {},
      click() { if (this.download) downloads.push(this.download); this.dispatchEvent({ type: "click" }); },
      set innerHTML(value) { throw new Error("Inventory report must use text nodes"); }
    };
  }
  const periods = ["day", "week", "month", "year"].map(period => { const button = node("button"); button.dataset.stockHistoryPeriod = period; return button; });
  const document = {
    readyState: "loading", hidden: false, body: node("body"),
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    querySelectorAll(selector) { return selector === "[data-stock-history-period]" ? periods : []; },
    createElement: node,
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); },
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach(handler => handler(event)); }
  };
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  class DownloadUrl extends URL { static createObjectURL() { return "blob:stock-history"; } static revokeObjectURL() {} }
  const context = vm.createContext({ document, window: { DapoerStockHistoryFiles: files }, fetch, AbortController, DOMException, CustomEvent, Date, Intl, URLSearchParams, URL: DownloadUrl, Blob,
    setInterval(callback) { const id = ++timer; intervals.set(id, callback); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++timer; timeouts.set(id, { callback, delay }); return id; }, clearTimeout(id) { timeouts.delete(id); } });
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/admin-stock-history.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, "globalThis.api={state,init,setAuthenticated,selectTab,selectPeriod,changeDate,movePeriod,changePage,exportReport,resetSelection,invalidate,tick};})();");
  vm.runInContext(source, context);
  context.api.init();
  return { ...context.api, document, intervals, downloads, element: selector => document.querySelector(selector),
    fireTimeouts(delay) { Array.from(timeouts.entries()).filter(([, value]) => value.delay === delay).forEach(([id, value]) => { timeouts.delete(id); value.callback(); }); } };
}
function movement(id) {
  return { id, createdAt: "2026-10-15T03:00:00Z", productId: "pasta", productName: "Pasta", stockBefore: id, quantityIn: 1, quantityOut: 0, stockAfter: id + 1, reason: "<img src=x onerror=alert(1)>", source: "restock", orderId: "ORDER-1" };
}
function report(options = {}) {
  const total = options.total ?? 205, cursor = options.cursor ?? 0, pageSize = options.pageSize ?? 100;
  return {
    generatedAt: "2026-10-15T03:00:00Z", period: { type: "month", date: "2026-10-15", startDate: "2026-10-01", endDate: "2026-10-31" },
    coverage: { startedAt: "2026-10-15T00:00:00Z", available: true, partial: true, inProgress: true },
    summary: { movementCount: total, incoming: total, outgoing: 0, opening: 0, closing: total },
    products: [{ id: "pasta", name: "Pasta", opening: 0, incoming: total, outgoing: 0, closing: total }],
    movements: Array.from({ length: Math.min(pageSize, total - cursor) }, (_, index) => movement(cursor + index)),
    pagination: { snapshot: SNAPSHOT, cursor, pageSize, total, nextCursor: cursor + pageSize < total ? cursor + pageSize : null, expiresAt: "2026-10-15T04:00:00Z" }
  };
}
async function open(ui) { ui.setAuthenticated(true); ui.selectTab("history"); await flush(); }

test("history is lazy and stock changes retain the frozen report for paging and complete export", async () => {
  const requests = [], built = [];
  const ui = dashboard(async url => {
    const params = new URL(url, "https://example.test").searchParams;
    requests.push(params);
    return response(report({ cursor: Number(params.get("cursor") || 0), pageSize: Number(params.get("pageSize") || 100) }));
  }, { async build(data) { built.push(data); return { blob: new Blob(["all rows"]), extension: "csv" }; } });
  ui.setAuthenticated(true);
  assert.equal(requests.length, 0);
  ui.selectTab("history"); await flush();
  assert.equal(requests.length, 1);
  ui.invalidate(); ui.tick();
  assert.equal(requests.length, 1);
  assert.equal(ui.element("#stock-history-export").disabled, false);
  assert.match(ui.element("#stock-history-message").textContent, /Ada perubahan/);
  await ui.changePage(200);
  assert.equal(requests[1].get("snapshot"), SNAPSHOT);
  assert.equal(requests[1].has("period"), false);
  await ui.exportReport("csv");
  assert.equal(requests[2].get("pageSize"), "1000");
  assert.equal(requests[2].get("snapshot"), SNAPSHOT);
  assert.equal(built[0].movements.length, 205);
  assert.equal(ui.downloads.length, 1);
  ui.selectTab("current"); ui.selectTab("history"); await flush();
  assert.equal(requests.length, 4);
  assert.equal(requests[3].get("period"), "month");
});

test("late report responses cannot repopulate private data after logout", async () => {
  let resolveRead;
  const ui = dashboard(() => new Promise(resolve => { resolveRead = resolve; }));
  ui.setAuthenticated(true); ui.selectTab("history");
  const controller = ui.state.request.controller;
  ui.setAuthenticated(false);
  assert.equal(controller.signal.aborted, true);
  resolveRead(response(report())); await flush();
  assert.equal(ui.state.report, null);
  assert.equal(ui.element("#stock-history-body").children.length, 0);
  assert.equal(ui.element("#stock-history-product").children.length, 1);
  assert.equal(ui.element("#stock-history-report").hidden, true);
});

test("logout during export pagination prevents file generation and download", async () => {
  let resolveExport, calls = 0, builds = 0;
  const ui = dashboard(async () => {
    if (++calls === 1) return response(report());
    return new Promise(resolve => { resolveExport = resolve; });
  }, { async build() { builds++; return { blob: new Blob(["private"]), extension: "csv" }; } });
  await open(ui);
  const pending = ui.exportReport("csv");
  const controller = ui.state.exporting.controller;
  ui.setAuthenticated(false);
  resolveExport(response(report({ pageSize: 1000 })));
  await pending;
  assert.equal(controller.signal.aborted, true);
  assert.equal(builds, 0);
  assert.equal(ui.downloads.length, 0);
});

test("changing filters while building a file prevents downloading the previous report", async () => {
  let resolveBuild;
  const ui = dashboard(async () => response(report({ total: 1 })), { build() { return new Promise(resolve => { resolveBuild = resolve; }); } });
  await open(ui);
  const pending = ui.exportReport("csv"); await flush();
  const controller = ui.state.exporting.controller;
  ui.selectPeriod("year");
  resolveBuild({ blob: new Blob(["old period"]), extension: "csv" }); await pending; await flush();
  assert.equal(controller.signal.aborted, true);
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.state.period, "year");
});

test("expired snapshots require a fresh report before another page or download", async () => {
  let calls = 0;
  const ui = dashboard(async () => ++calls === 1 ? response(report()) : response({ code: "SNAPSHOT_EXPIRED" }, 410));
  await open(ui);
  await ui.changePage(100);
  assert.equal(ui.element("#stock-history-export").disabled, true);
  assert.equal(ui.element("#stock-history-page-next").disabled, true);
  assert.equal(ui.element("#stock-history-refresh").disabled, false);
  assert.match(ui.element("#stock-history-message").textContent, /Klik Refresh/);
});

test("incomplete export pages never generate a partial downloadable file", async () => {
  let calls = 0, builds = 0;
  const ui = dashboard(async () => {
    if (++calls === 1) return response(report());
    const incomplete = report({ pageSize: 1000 }); incomplete.movements.pop();
    return response(incomplete);
  }, { async build() { builds++; return { blob: new Blob(["partial"]), extension: "csv" }; } });
  await open(ui);
  await ui.exportReport("csv");
  assert.equal(builds, 0);
  assert.equal(ui.downloads.length, 0);
  assert.match(ui.element("#stock-history-message").textContent, /belum lengkap/);
});

test("large exports resume the same frozen page after Retry-After and remain cancellable", async () => {
  for (const cancel of [false, true]) {
    const requests = [];
    const ui = dashboard(async url => {
      requests.push(url);
      if (requests.length === 1) return response(report());
      if (requests.length === 2) return { ...response({ error: "Terlalu banyak permintaan" }, 429), headers: { get() { return "1"; } } };
      return response(report({ pageSize: 1000 }));
    });
    await open(ui);
    const pending = ui.exportReport("csv"); await flush();
    assert.match(ui.element("#stock-history-message").textContent, /1 detik/);
    if (cancel) ui.setAuthenticated(false);
    else ui.fireTimeouts(1000);
    await pending;
    assert.equal(ui.downloads.length, cancel ? 0 : 1);
    assert.equal(requests.length, cancel ? 2 : 3);
    if (!cancel) assert.equal(requests[2], requests[1]);
  }
});

test("export retry attempts are bounded and never download a partial report", async () => {
  let requests = 0;
  const ui = dashboard(async () => ++requests === 1 ? response(report()) : { ...response({ error: "Batas permintaan tercapai" }, 429), headers: { get() { return "1"; } } });
  await open(ui);
  const pending = ui.exportReport("csv"); await flush();
  ui.fireTimeouts(1000); await flush();
  ui.fireTimeouts(1000); await pending;
  assert.equal(requests, 4);
  assert.equal(ui.downloads.length, 0);
  assert.match(ui.element("#stock-history-message").textContent, /Batas permintaan/);
});
