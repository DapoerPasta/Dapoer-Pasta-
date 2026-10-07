const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function stockDashboard(fetch = async () => { throw new Error("Unexpected request"); }) {
  const nodes = new Map();
  const events = [];
  const listeners = new Map();
  const intervals = new Map();
  let timer = 0;
  function node() {
    const classes = new Set();
    return {
      children: [], value: "", textContent: "", hidden: false, disabled: false,
      classList: {
        contains(name) { return classes.has(name); },
        toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }
      },
      append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      addEventListener() {},
      setAttribute(name, value) { this[name] = value; },
      focus() { this.focused = true; }
    };
  }
  const document = {
    readyState: "loading", hidden: false,
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    createElement: node,
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(handler); },
    dispatchEvent(event) { events.push(event); (listeners.get(event.type) || []).forEach(handler => handler(event)); }
  };
  class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  const context = vm.createContext({
    document, window: {}, fetch, CustomEvent, AbortController, Date, Intl,
    setInterval(handler) { const id = ++timer; intervals.set(id, handler); return id; },
    clearInterval(id) { intervals.delete(id); }
  });
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/admin-stock.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, `globalThis.stockApi={state,init,setAuthenticated,loadStock,adjustStock,adjustment};})();`);
  vm.runInContext(source, context);
  context.stockApi.init();
  return { ...context.stockApi, document, events, intervals, element: selector => document.querySelector(selector) };
}

const product = (stock = 8) => ({ id: "pasta", name: "Pasta brulee", price: 27000, stock });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return data; } });
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

test("authenticated stock polling updates the count while preserving staff adjustment input", async () => {
  let stock = 8;
  const requests = [];
  const ui = stockDashboard(async (url, options) => {
    requests.push(url);
    assert.equal(options.cache, "no-store");
    return response({ products: [product(stock)] });
  });
  ui.setAuthenticated(true);
  await flush();
  const row = ui.state.rows.get("pasta");
  row.input.value = "3";
  stock = 6;
  await ui.loadStock(true);
  assert.equal(ui.state.rows.get("pasta"), row);
  assert.equal(row.input.value, "3");
  assert.equal(row.count.textContent, "6 unit");
  assert.equal(row.subtract.disabled, false);
  assert.equal(ui.intervals.size, 1);
  assert.deepEqual(requests, ["/api/admin/stock", "/api/admin/stock"]);
  ui.document.hidden = true;
  await ui.loadStock(true);
  assert.equal(requests.length, 2);
});

test("stock adjustment sends a delta and immediately displays the authoritative saved quantity", async () => {
  const writes = [];
  const ui = stockDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product()] });
    writes.push(JSON.parse(options.body));
    return response({ product: product(11) });
  });
  ui.setAuthenticated(true);
  await flush();
  const row = ui.state.rows.get("pasta");
  row.input.value = "3";
  await ui.adjustStock("pasta", 1);
  assert.deepEqual(writes, [{ id: "pasta", delta: 3 }]);
  assert.equal(row.count.textContent, "11 unit");
  assert.equal(row.input.value, "");
  assert.match(ui.element("#stock-message").textContent, /ditambah 3 unit/);
});

test("noninteger or excessive reductions never reach the stock API", async () => {
  let writes = 0;
  const ui = stockDashboard(async (url, options) => {
    if (options.method === "PATCH") writes++;
    return response({ products: [product(2)] });
  });
  ui.setAuthenticated(true);
  await flush();
  const input = ui.state.rows.get("pasta").input;
  for (const invalid of ["", "1.5", "-1", "0", "1e2", "1000001"]) {
    input.value = invalid;
    await ui.adjustStock("pasta", 1);
  }
  input.value = "3";
  await ui.adjustStock("pasta", -1);
  assert.equal(writes, 0);
  assert.match(ui.element("#stock-message").textContent, /melebihi stok/);
});

test("stock conflicts retain the quantity for review and prevent duplicate saves while pending", async () => {
  let finish;
  let writes = 0;
  const ui = stockDashboard((url, options) => {
    if (options.method !== "PATCH") return Promise.resolve(response({ products: [product(3)] }));
    writes++;
    return new Promise(resolve => { finish = resolve; });
  });
  ui.setAuthenticated(true);
  await flush();
  const row = ui.state.rows.get("pasta");
  row.input.value = "2";
  const pending = ui.adjustStock("pasta", -1);
  assert.equal(row.add.disabled, true);
  assert.equal(row.subtract.disabled, true);
  await ui.adjustStock("pasta", -1);
  assert.equal(writes, 1);
  finish(response({ error: "Stok tidak mencukupi. Refresh stok." }, 409));
  await pending;
  assert.equal(row.input.value, "2");
  assert.equal(row.count.textContent, "3 unit");
  assert.equal(ui.element("#stock-message").classList.contains("error"), true);
});

test("a saved adjustment invalidates a stale stock poll", async () => {
  let reads = 0;
  let finishOld;
  let oldSignal;
  const ui = stockDashboard((url, options) => {
    if (options.method === "PATCH") return Promise.resolve(response({ product: product(10) }));
    if (++reads === 1) return Promise.resolve(response({ products: [product()] }));
    oldSignal = options.signal;
    return new Promise(resolve => { finishOld = resolve; });
  });
  ui.setAuthenticated(true);
  await flush();
  const pending = ui.loadStock(true);
  ui.state.rows.get("pasta").input.value = "2";
  await ui.adjustStock("pasta", 1);
  assert.equal(oldSignal.aborted, true);
  finishOld(response({ products: [product(8)] }));
  await pending;
  assert.equal(ui.state.products.get("pasta").stock, 10);
});

test("logout clears stock rows and ignores a pending adjustment response", async () => {
  let finish;
  const ui = stockDashboard((url, options) => options.method === "PATCH"
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(response({ products: [product()] })));
  ui.setAuthenticated(true);
  await flush();
  ui.state.rows.get("pasta").input.value = "1";
  const pending = ui.adjustStock("pasta", 1);
  ui.setAuthenticated(false);
  finish(response({ product: product(9) }));
  await pending;
  assert.equal(ui.state.products.size, 0);
  assert.equal(ui.element("#stock-list").children.length, 0);
  assert.equal(ui.intervals.size, 0);
});

test("expired stock sessions stop polling and notify the existing admin login flow", async () => {
  const ui = stockDashboard(async () => response({ error: "Unauthorized" }, 401));
  ui.setAuthenticated(true);
  await flush();
  assert.equal(ui.state.authenticated, false);
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.events[0].type, "dapoer:admin-session-expired");
});
