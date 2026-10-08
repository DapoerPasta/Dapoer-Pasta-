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
    const handlers = new Map();
    return {
      children: [], value: "", textContent: "", hidden: false, disabled: false, open: false,
      classList: {
        contains(name) { return classes.has(name); },
        toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }
      },
      append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
      dispatchEvent(event) {
        if (!event.target) event.target = this;
        (handlers.get(event.type) || []).forEach(handler => handler(event));
      },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      showModal() { this.open = true; },
      close() { this.open = false; },
      focus() { this.focused = true; },
      select() { this.selected = true; }
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
    .replace(/\}\)\(\);\s*$/, `globalThis.stockApi={state,init,setAuthenticated,loadStock,adjustStock,adjustment,openEditor,closeEditor,saveExactStock};})();`);
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

test("editing an existing stock quantity saves the reviewed count and displays the authoritative result", async () => {
  const writes = [];
  const ui = stockDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product()] });
    writes.push(JSON.parse(options.body));
    return response({ product: product(6) });
  });
  ui.setAuthenticated(true);
  await flush();
  const row = ui.state.rows.get("pasta");
  row.edit.dispatchEvent({ type: "click" });
  assert.equal(ui.element("#stock-editor").open, true);
  assert.equal(ui.state.editing.id, "pasta");
  assert.equal(ui.state.editing.expectedStock, 8);
  assert.equal(ui.element("#stock-edit-quantity").value, "8");
  ui.element("#stock-edit-quantity").value = "7";
  let prevented = false;
  ui.element("#stock-edit-form").dispatchEvent({ type: "submit", preventDefault() { prevented = true; } });
  await flush();
  assert.equal(prevented, true);
  assert.deepEqual(writes, [{ id: "pasta", stock: 7, expectedStock: 8 }]);
  assert.equal(row.count.textContent, "6 unit");
  assert.equal(ui.state.editing, null);
  assert.equal(ui.element("#stock-editor").open, false);
});

test("absolute edits reject invalid and unchanged quantities without sending a mutation", async () => {
  const writes = [];
  const ui = stockDashboard(async (url, options) => {
    if (options.method === "PATCH") writes.push(JSON.parse(options.body));
    return response({ products: [product()] });
  });
  ui.setAuthenticated(true);
  await flush();
  ui.openEditor("pasta");
  const input = ui.element("#stock-edit-quantity");
  for (const invalid of ["", "1.5", "-1", "1e2", "1000001", "Infinity", "8"]) {
    input.value = invalid;
    await ui.saveExactStock();
    assert.equal(ui.element("#stock-editor").open, true);
  }
  assert.deepEqual(writes, []);
  assert.equal(ui.state.editing.expectedStock, 8);
});

test("absolute edits accept zero and the supported maximum stock", async () => {
  let stock = 8;
  const writes = [];
  const ui = stockDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product(stock)] });
    const body = JSON.parse(options.body);
    writes.push(body);
    stock = body.stock;
    return response({ product: product(stock) });
  });
  ui.setAuthenticated(true);
  await flush();
  for (const quantity of [0, 1000000]) {
    ui.openEditor("pasta");
    ui.element("#stock-edit-quantity").value = String(quantity);
    await ui.saveExactStock();
    assert.equal(ui.state.products.get("pasta").stock, quantity);
  }
  assert.deepEqual(writes, [
    { id: "pasta", stock: 0, expectedStock: 8 },
    { id: "pasta", stock: 1000000, expectedStock: 0 }
  ]);
});

test("clearing stock requires confirmation, supports cancel, and keeps the menu row", async () => {
  const writes = [];
  const ui = stockDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product()] });
    writes.push(JSON.parse(options.body));
    return response({ product: product(0) });
  });
  ui.setAuthenticated(true);
  await flush();
  const row = ui.state.rows.get("pasta");
  row.clear.dispatchEvent({ type: "click" });
  assert.equal(ui.state.editing.action, "clear");
  assert.equal(ui.element("#stock-edit-quantity").value, "0");
  assert.equal(ui.element("#stock-editor").open, true);
  assert.equal(writes.length, 0);
  ui.element("#stock-edit-cancel").dispatchEvent({ type: "click" });
  assert.equal(ui.state.editing, null);
  assert.equal(ui.element("#stock-editor").open, false);
  assert.equal(ui.state.products.get("pasta").stock, 8);
  assert.equal(writes.length, 0);
  row.clear.dispatchEvent({ type: "click" });
  await ui.saveExactStock();
  assert.deepEqual(writes, [{ id: "pasta", stock: 0, expectedStock: 8 }]);
  assert.equal(ui.state.rows.get("pasta"), row);
  assert.equal(row.count.textContent, "0 unit");
  assert.equal(row.status.textContent, "Habis");
  assert.equal(ui.element("#stock-list").children.length, 1);
});

test("background stock polls preserve the editor input and the quantity originally reviewed", async () => {
  let stock = 8;
  const ui = stockDashboard(async () => response({ products: [product(stock)] }));
  ui.setAuthenticated(true);
  await flush();
  ui.openEditor("pasta");
  const editing = ui.state.editing;
  ui.element("#stock-edit-quantity").value = "4";
  stock = 5;
  await ui.loadStock(true);
  assert.equal(ui.state.products.get("pasta").stock, 5);
  assert.equal(ui.state.editing, editing);
  assert.equal(ui.state.editing.expectedStock, 8);
  assert.equal(ui.element("#stock-edit-quantity").value, "4");
  assert.equal(ui.element("#stock-editor").open, true);
});

test("a stale absolute edit preserves input and requires reviewing fresh stock before another save", async () => {
  let stock = 8;
  const writes = [];
  const ui = stockDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product(stock)] });
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) {
      stock = 5;
      return response({ code: "STOCK_CONFLICT", error: "Stok telah berubah. Periksa jumlah terbaru." }, 409);
    }
    stock = JSON.parse(options.body).stock;
    return response({ product: product(stock) });
  });
  ui.setAuthenticated(true);
  await flush();
  ui.openEditor("pasta");
  ui.element("#stock-edit-quantity").value = "4";
  await ui.saveExactStock();
  assert.equal(ui.state.products.get("pasta").stock, 5);
  assert.equal(ui.state.editing.expectedStock, 8);
  assert.equal(ui.state.editing.conflicted, true);
  assert.equal(ui.element("#stock-edit-quantity").value, "4");
  assert.equal(ui.element("#stock-editor").open, true);
  assert.equal(ui.element("#stock-edit-save").disabled, true);
  await ui.saveExactStock();
  assert.equal(writes.length, 1);
  ui.closeEditor();
  ui.openEditor("pasta");
  assert.equal(ui.state.editing.expectedStock, 5);
  assert.equal(ui.element("#stock-edit-quantity").value, "5");
  ui.element("#stock-edit-quantity").value = "4";
  await ui.saveExactStock();
  assert.deepEqual(writes, [
    { id: "pasta", stock: 4, expectedStock: 8 },
    { id: "pasta", stock: 4, expectedStock: 5 }
  ]);
  assert.equal(ui.state.products.get("pasta").stock, 4);
});

test("an absolute edit disables duplicate mutations and closing while its save is pending", async () => {
  let finish;
  let writes = 0;
  const ui = stockDashboard((url, options) => {
    if (options.method !== "PATCH") return Promise.resolve(response({ products: [product()] }));
    writes++;
    return new Promise(resolve => { finish = resolve; });
  });
  ui.setAuthenticated(true);
  await flush();
  ui.openEditor("pasta");
  ui.element("#stock-edit-quantity").value = "2";
  const pending = ui.saveExactStock();
  assert.equal(ui.element("#stock-edit-save").disabled, true);
  assert.equal(ui.element("#stock-edit-quantity").disabled, true);
  assert.equal(ui.element("#stock-edit-cancel").disabled, true);
  assert.equal(ui.state.rows.get("pasta").add.disabled, true);
  assert.equal(ui.state.rows.get("pasta").edit.disabled, true);
  await ui.saveExactStock();
  await ui.adjustStock("pasta", 1);
  ui.closeEditor();
  assert.equal(writes, 1);
  assert.equal(ui.element("#stock-editor").open, true);
  finish(response({ product: product(2) }));
  await pending;
  assert.equal(ui.state.products.get("pasta").stock, 2);
  assert.equal(ui.state.editing, null);
});

test("failed absolute stock saves preserve the editor and allow an explicit retry", async () => {
  let writes = 0;
  const ui = stockDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product()] });
    if (++writes === 1) throw new Error("Koneksi terputus");
    return response({ product: product(3) });
  });
  ui.setAuthenticated(true);
  await flush();
  ui.openEditor("pasta");
  ui.element("#stock-edit-quantity").value = "3";
  await ui.saveExactStock();
  assert.equal(ui.element("#stock-editor").open, true);
  assert.equal(ui.element("#stock-edit-quantity").value, "3");
  assert.equal(ui.state.editing.expectedStock, 8);
  assert.equal(ui.element("#stock-edit-save").disabled, false);
  assert.match(ui.element("#stock-edit-message").textContent, /Koneksi terputus/);
  await ui.saveExactStock();
  assert.equal(writes, 2);
  assert.equal(ui.state.editing, null);
  assert.equal(ui.state.products.get("pasta").stock, 3);
});

test("a saved absolute quantity invalidates a stale stock poll", async () => {
  let reads = 0;
  let finishOld;
  let oldSignal;
  const ui = stockDashboard((url, options) => {
    if (options.method === "PATCH") return Promise.resolve(response({ product: product(4) }));
    if (++reads === 1) return Promise.resolve(response({ products: [product()] }));
    oldSignal = options.signal;
    return new Promise(resolve => { finishOld = resolve; });
  });
  ui.setAuthenticated(true);
  await flush();
  ui.openEditor("pasta");
  ui.element("#stock-edit-quantity").value = "4";
  const poll = ui.loadStock(true);
  await ui.saveExactStock();
  assert.equal(oldSignal.aborted, true);
  finishOld(response({ products: [product(8)] }));
  await poll;
  assert.equal(ui.state.products.get("pasta").stock, 4);
  assert.equal(ui.element("#stock-editor").open, false);
});

test("logout closes the editor and ignores a pending absolute stock save", async () => {
  let finish;
  const ui = stockDashboard((url, options) => options.method === "PATCH"
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(response({ products: [product()] })));
  ui.setAuthenticated(true);
  await flush();
  ui.openEditor("pasta");
  ui.element("#stock-edit-quantity").value = "3";
  const pending = ui.saveExactStock();
  ui.setAuthenticated(false);
  assert.equal(ui.state.editing, null);
  assert.equal(ui.element("#stock-editor").open, false);
  finish(response({ product: product(3) }));
  await pending;
  assert.equal(ui.state.products.size, 0);
  assert.equal(ui.element("#stock-list").children.length, 0);
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.element("#stock-message").textContent, "");
});

test("an expired session during an absolute edit closes it and returns to the existing login flow", async () => {
  const ui = stockDashboard(async (url, options) => options.method === "PATCH"
    ? response({ error: "Unauthorized" }, 401)
    : response({ products: [product()] }));
  ui.setAuthenticated(true);
  await flush();
  ui.openEditor("pasta");
  ui.element("#stock-edit-quantity").value = "3";
  await ui.saveExactStock();
  assert.equal(ui.state.authenticated, false);
  assert.equal(ui.state.editing, null);
  assert.equal(ui.element("#stock-editor").open, false);
  assert.equal(ui.state.products.size, 0);
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.events[0].type, "dapoer:admin-session-expired");
});
