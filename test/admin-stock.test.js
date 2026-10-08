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
  function node(tagName = "div") {
    const classes = new Set();
    const handlers = new Map();
    return {
      tagName: tagName.toUpperCase(), children: [], value: "", textContent: "", hidden: false, disabled: false, open: false,
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
      getAttribute(name) { return this[name] ?? null; },
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
    .replace(/\}\)\(\);\s*$/, `globalThis.stockApi={state,init,setAuthenticated,loadStock,openEditor,selectAction,saveStock,closeEditor};})();`);
  vm.runInContext(source, context);
  context.stockApi.init();
  return { ...context.stockApi, document, events, intervals, element: selector => document.querySelector(selector) };
}

const product = (stock = 8) => ({ id: "pasta", name: "Pasta brulee", price: 27000, stock });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return data; } });
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
async function authenticatedDashboard(fetch) {
  const ui = stockDashboard(fetch);
  ui.setAuthenticated(true);
  await flush();
  return ui;
}
function enterQuantity(ui, value) {
  const input = ui.element("#stock-edit-quantity");
  input.value = String(value);
  input.dispatchEvent({ type: "input" });
}
function chooseAction(ui, action) { ui.element(`#stock-action-${action}`).dispatchEvent({ type: "click" }); }
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }

test("each stock row has one manage button that opens the shared modal", async () => {
  const ui = await authenticatedDashboard(async () => response({ products: [product()] }));
  const row = ui.state.rows.get("pasta");
  const buttons = descendants(row.root).filter(node => node.tagName === "BUTTON");
  assert.deepEqual(buttons, [row.manage]);
  assert.match(row.manage.textContent, /Kelola stok/);
  row.manage.dispatchEvent({ type: "click" });
  assert.equal(ui.element("#stock-editor").open, true);
  assert.equal(ui.state.editing.id, "pasta");
  assert.equal(ui.state.editing.action, "add");
  assert.equal(ui.element("#stock-edit-quantity").value, "");
  assert.equal(ui.element("#stock-edit-save").disabled, true);
});

test("switching actions keeps separate input drafts and reveals clear confirmation", async () => {
  const ui = await authenticatedDashboard(async () => response({ products: [product()] }));
  ui.openEditor("pasta");
  enterQuantity(ui, 3);
  chooseAction(ui, "subtract");
  assert.equal(ui.element("#stock-edit-quantity").value, "");
  enterQuantity(ui, 2);
  chooseAction(ui, "set");
  assert.equal(ui.element("#stock-edit-quantity").value, "8");
  enterQuantity(ui, 6);
  chooseAction(ui, "clear");
  assert.equal(ui.element("#stock-edit-quantity").value, "0");
  assert.equal(ui.element("#stock-edit-field").hidden, true);
  assert.equal(ui.element("#stock-edit-warning").hidden, false);
  for (const [action, draft] of [["add", "3"], ["subtract", "2"], ["set", "6"]]) {
    chooseAction(ui, action);
    assert.equal(ui.state.editing.action, action);
    assert.equal(ui.element("#stock-edit-quantity").value, draft);
    assert.equal(ui.element("#stock-edit-field").hidden, false);
  }
});

test("authenticated polling updates live delta previews while preserving the modal draft", async () => {
  let stock = 8;
  const requests = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    requests.push(url);
    assert.equal(options.cache, "no-store");
    return response({ products: [product(stock)] });
  });
  const row = ui.state.rows.get("pasta");
  ui.openEditor("pasta");
  enterQuantity(ui, 3);
  assert.equal(ui.element("#stock-edit-before").textContent, "8 unit");
  assert.equal(ui.element("#stock-edit-after").textContent, "11 unit");
  stock = 6;
  await ui.loadStock(true);
  assert.equal(ui.state.rows.get("pasta"), row);
  assert.equal(row.count.textContent, "6 unit");
  assert.equal(ui.element("#stock-edit-quantity").value, "3");
  assert.equal(ui.element("#stock-edit-before").textContent, "6 unit");
  assert.equal(ui.element("#stock-edit-after").textContent, "9 unit");
  assert.equal(ui.intervals.size, 1);
  assert.deepEqual(requests, ["/api/admin/stock", "/api/admin/stock"]);
  ui.document.hidden = true;
  await ui.loadStock(true);
  assert.equal(requests.length, 2);
});

test("add and subtract send deltas and display authoritative saved quantities", async () => {
  let stock = 8;
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product(stock)] });
    const body = JSON.parse(options.body);
    writes.push(body);
    stock = writes.length === 1 ? 10 : 7;
    return response({ product: product(stock) });
  });
  ui.openEditor("pasta");
  enterQuantity(ui, 3);
  assert.equal(ui.element("#stock-edit-after").textContent, "11 unit");
  await ui.saveStock();
  assert.equal(ui.state.rows.get("pasta").count.textContent, "10 unit");
  assert.equal(ui.element("#stock-editor").open, false);
  ui.openEditor("pasta", "subtract");
  enterQuantity(ui, 2);
  assert.equal(ui.element("#stock-edit-after").textContent, "8 unit");
  await ui.saveStock();
  assert.deepEqual(writes, [{ id: "pasta", delta: 3 }, { id: "pasta", delta: -2 }]);
  assert.equal(ui.state.rows.get("pasta").count.textContent, "7 unit");
});

test("invalid deltas and excessive reductions never reach the stock API", async () => {
  let stock = 2;
  let writes = 0;
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method === "PATCH") writes++;
    return response({ products: [product(stock)] });
  });
  ui.openEditor("pasta");
  for (const invalid of ["", "1.5", "-1", "0", "1e2", "1000001"]) {
    enterQuantity(ui, invalid);
    assert.equal(ui.element("#stock-edit-save").disabled, true);
    await ui.saveStock();
  }
  chooseAction(ui, "subtract");
  enterQuantity(ui, 2);
  assert.equal(ui.element("#stock-edit-save").disabled, false);
  stock = 1;
  await ui.loadStock(true);
  assert.equal(ui.element("#stock-edit-quantity").value, "2");
  assert.equal(ui.element("#stock-edit-save").disabled, true);
  await ui.saveStock();
  assert.equal(writes, 0);
  assert.match(ui.element("#stock-edit-message").textContent, /melebihi stok/);
});

test("additions beyond the supported stock limit cannot be saved", async () => {
  let writes = 0;
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method === "PATCH") writes++;
    return response({ products: [product(999999)] });
  });
  ui.openEditor("pasta");
  enterQuantity(ui, 2);
  assert.equal(ui.element("#stock-edit-save").disabled, true);
  await ui.saveStock();
  assert.equal(writes, 0);
  enterQuantity(ui, 1);
  assert.equal(ui.element("#stock-edit-save").disabled, false);
});

test("menus without configured stock can initialize it through add only", async () => {
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product(null)] });
    writes.push(JSON.parse(options.body));
    return response({ product: product(3) });
  });
  const row = ui.state.rows.get("pasta");
  assert.equal(row.manage.disabled, false);
  row.manage.dispatchEvent({ type: "click" });
  assert.equal(ui.element("#stock-action-add").disabled, false);
  for (const action of ["subtract", "set", "clear"]) {
    assert.equal(ui.element(`#stock-action-${action}`).disabled, true);
    ui.selectAction(action);
    assert.equal(ui.state.editing.action, "add");
  }
  enterQuantity(ui, 3);
  await ui.saveStock();
  assert.deepEqual(writes, [{ id: "pasta", delta: 3 }]);
  assert.equal(row.count.textContent, "3 unit");
});

test("setting an exact count uses the reviewed snapshot and the form submit handler", async () => {
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product()] });
    writes.push(JSON.parse(options.body));
    return response({ product: product(6) });
  });
  ui.openEditor("pasta");
  chooseAction(ui, "set");
  assert.equal(ui.state.editing.expectedStock, 8);
  assert.equal(ui.element("#stock-edit-quantity").value, "8");
  enterQuantity(ui, 7);
  let prevented = false;
  ui.element("#stock-edit-form").dispatchEvent({ type: "submit", preventDefault() { prevented = true; } });
  await flush();
  assert.equal(prevented, true);
  assert.deepEqual(writes, [{ id: "pasta", stock: 7, expectedStock: 8 }]);
  assert.equal(ui.state.rows.get("pasta").count.textContent, "6 unit");
  assert.equal(ui.state.editing, null);
  assert.equal(ui.element("#stock-editor").open, false);
});

test("absolute edits reject invalid and unchanged quantities without sending a mutation", async () => {
  let writes = 0;
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method === "PATCH") writes++;
    return response({ products: [product()] });
  });
  ui.openEditor("pasta", "set");
  for (const invalid of ["", "1.5", "-1", "1e2", "1000001", "Infinity", "8"]) {
    enterQuantity(ui, invalid);
    assert.equal(ui.element("#stock-edit-save").disabled, true);
    await ui.saveStock();
    assert.equal(ui.element("#stock-editor").open, true);
  }
  assert.equal(writes, 0);
  assert.equal(ui.state.editing.expectedStock, 8);
});

test("absolute edits accept zero and the supported maximum stock", async () => {
  let stock = 8;
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product(stock)] });
    const body = JSON.parse(options.body);
    writes.push(body);
    stock = body.stock;
    return response({ product: product(stock) });
  });
  for (const quantity of [0, 1000000]) {
    ui.openEditor("pasta", "set");
    enterQuantity(ui, quantity);
    await ui.saveStock();
    assert.equal(ui.state.products.get("pasta").stock, quantity);
  }
  assert.deepEqual(writes, [
    { id: "pasta", stock: 0, expectedStock: 8 },
    { id: "pasta", stock: 1000000, expectedStock: 0 }
  ]);
});

test("clearing stock requires confirmation, supports cancel, and keeps the menu row", async () => {
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product()] });
    writes.push(JSON.parse(options.body));
    return response({ product: product(0) });
  });
  const row = ui.state.rows.get("pasta");
  row.manage.dispatchEvent({ type: "click" });
  chooseAction(ui, "clear");
  assert.equal(ui.state.editing.action, "clear");
  assert.equal(ui.element("#stock-edit-after").textContent, "0 unit");
  assert.equal(writes.length, 0);
  ui.element("#stock-edit-cancel").dispatchEvent({ type: "click" });
  assert.equal(ui.state.editing, null);
  assert.equal(ui.element("#stock-editor").open, false);
  assert.equal(ui.state.products.get("pasta").stock, 8);
  assert.equal(writes.length, 0);
  ui.openEditor("pasta", "clear");
  await ui.saveStock();
  assert.deepEqual(writes, [{ id: "pasta", stock: 0, expectedStock: 8 }]);
  assert.equal(ui.state.rows.get("pasta"), row);
  assert.equal(row.count.textContent, "0 unit");
  assert.equal(row.status.textContent, "Habis");
  assert.equal(ui.element("#stock-list").children.length, 1);
});

test("polling preserves exact input and the original snapshot while other actions use live counts", async () => {
  let stock = 8;
  const ui = await authenticatedDashboard(async () => response({ products: [product(stock)] }));
  ui.openEditor("pasta", "set");
  const editing = ui.state.editing;
  enterQuantity(ui, 4);
  stock = 5;
  await ui.loadStock(true);
  assert.equal(ui.state.products.get("pasta").stock, 5);
  assert.equal(ui.state.editing, editing);
  assert.equal(ui.state.editing.expectedStock, 8);
  assert.equal(ui.element("#stock-edit-quantity").value, "4");
  assert.equal(ui.element("#stock-edit-before").textContent, "8 unit");
  assert.equal(ui.element("#stock-edit-after").textContent, "4 unit");
  chooseAction(ui, "add");
  enterQuantity(ui, 3);
  assert.equal(ui.element("#stock-edit-before").textContent, "5 unit");
  assert.equal(ui.element("#stock-edit-after").textContent, "8 unit");
  chooseAction(ui, "set");
  assert.equal(ui.element("#stock-edit-quantity").value, "4");
  assert.equal(ui.element("#stock-edit-before").textContent, "8 unit");
});

test("a stale absolute edit preserves input and requires reviewing fresh stock before another save", async () => {
  let stock = 8;
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product(stock)] });
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) {
      stock = 5;
      return response({ code: "STOCK_CONFLICT", error: "Stok telah berubah." }, 409);
    }
    stock = JSON.parse(options.body).stock;
    return response({ product: product(stock) });
  });
  ui.openEditor("pasta", "set");
  enterQuantity(ui, 4);
  await ui.saveStock();
  assert.equal(ui.state.products.get("pasta").stock, 5);
  assert.equal(ui.state.editing.expectedStock, 8);
  assert.equal(ui.state.editing.conflicted, true);
  assert.equal(ui.element("#stock-edit-quantity").value, "4");
  assert.equal(ui.element("#stock-editor").open, true);
  assert.equal(ui.element("#stock-edit-save").disabled, true);
  await ui.saveStock();
  assert.equal(writes.length, 1);
  ui.closeEditor();
  ui.openEditor("pasta", "set");
  assert.equal(ui.state.editing.expectedStock, 5);
  assert.equal(ui.element("#stock-edit-quantity").value, "5");
  enterQuantity(ui, 4);
  await ui.saveStock();
  assert.deepEqual(writes, [
    { id: "pasta", stock: 4, expectedStock: 8 },
    { id: "pasta", stock: 4, expectedStock: 5 }
  ]);
  assert.equal(ui.state.products.get("pasta").stock, 4);
});

test("a reduction conflict refreshes live stock, keeps the input, and permits a corrected delta", async () => {
  let stock = 3;
  const writes = [];
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product(stock)] });
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) {
      stock = 1;
      return response({ code: "INSUFFICIENT_STOCK", error: "Stok tidak mencukupi." }, 409);
    }
    stock = 0;
    return response({ product: product(stock) });
  });
  ui.openEditor("pasta", "subtract");
  enterQuantity(ui, 2);
  await ui.saveStock();
  assert.equal(ui.state.products.get("pasta").stock, 1);
  assert.equal(ui.element("#stock-edit-quantity").value, "2");
  assert.equal(ui.element("#stock-editor").open, true);
  assert.equal(ui.element("#stock-edit-before").textContent, "1 unit");
  assert.equal(ui.element("#stock-edit-save").disabled, true);
  enterQuantity(ui, 1);
  assert.equal(ui.element("#stock-edit-save").disabled, false);
  await ui.saveStock();
  assert.deepEqual(writes, [{ id: "pasta", delta: -2 }, { id: "pasta", delta: -1 }]);
  assert.equal(ui.state.products.get("pasta").stock, 0);
  assert.equal(ui.element("#stock-editor").open, false);
});

test("pending stock saves prevent duplicates, action switching, and closing", async () => {
  let finish;
  let writes = 0;
  const ui = await authenticatedDashboard((url, options) => {
    if (options.method !== "PATCH") return Promise.resolve(response({ products: [product()] }));
    writes++;
    return new Promise(resolve => { finish = resolve; });
  });
  ui.openEditor("pasta", "set");
  enterQuantity(ui, 2);
  const pending = ui.saveStock();
  assert.equal(ui.element("#stock-edit-save").disabled, true);
  assert.equal(ui.element("#stock-edit-quantity").disabled, true);
  assert.equal(ui.element("#stock-edit-cancel").disabled, true);
  assert.equal(ui.state.rows.get("pasta").manage.disabled, true);
  for (const action of ["add", "subtract", "set", "clear"]) assert.equal(ui.element(`#stock-action-${action}`).disabled, true);
  await ui.saveStock();
  ui.selectAction("clear");
  ui.closeEditor();
  assert.equal(writes, 1);
  assert.equal(ui.state.editing.action, "set");
  assert.equal(ui.element("#stock-editor").open, true);
  finish(response({ product: product(2) }));
  await pending;
  assert.equal(ui.state.products.get("pasta").stock, 2);
  assert.equal(ui.state.editing, null);
});

test("native dialog cancellation closes normally but cannot dismiss a pending save", async () => {
  let finish;
  const ui = await authenticatedDashboard((url, options) => options.method === "PATCH"
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(response({ products: [product()] })));
  ui.openEditor("pasta");
  let prevented = false;
  ui.element("#stock-editor").dispatchEvent({ type: "cancel", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(ui.state.editing, null);
  assert.equal(ui.element("#stock-editor").open, false);
  ui.openEditor("pasta");
  enterQuantity(ui, 1);
  const pending = ui.saveStock();
  ui.element("#stock-editor").dispatchEvent({ type: "cancel", preventDefault() {} });
  assert.equal(ui.state.editing.action, "add");
  assert.equal(ui.element("#stock-editor").open, true);
  finish(response({ product: product(9) }));
  await pending;
  assert.equal(ui.element("#stock-editor").open, false);
});

test("failed stock saves preserve input and allow an explicit retry", async () => {
  let writes = 0;
  const ui = await authenticatedDashboard(async (url, options) => {
    if (options.method !== "PATCH") return response({ products: [product()] });
    if (++writes === 1) throw new Error("Koneksi terputus");
    return response({ product: product(3) });
  });
  ui.openEditor("pasta", "set");
  enterQuantity(ui, 3);
  await ui.saveStock();
  assert.equal(ui.element("#stock-editor").open, true);
  assert.equal(ui.element("#stock-edit-quantity").value, "3");
  assert.equal(ui.state.editing.expectedStock, 8);
  assert.equal(ui.element("#stock-edit-save").disabled, false);
  assert.match(ui.element("#stock-edit-message").textContent, /Koneksi terputus/);
  await ui.saveStock();
  assert.equal(writes, 2);
  assert.equal(ui.state.editing, null);
  assert.equal(ui.state.products.get("pasta").stock, 3);
});

test("saved delta and exact changes both invalidate stale stock polls", async () => {
  for (const action of ["add", "set"]) {
    let reads = 0;
    let finishOld;
    let oldSignal;
    const ui = await authenticatedDashboard((url, options) => {
      if (options.method === "PATCH") return Promise.resolve(response({ product: product(4) }));
      if (++reads === 1) return Promise.resolve(response({ products: [product()] }));
      oldSignal = options.signal;
      return new Promise(resolve => { finishOld = resolve; });
    });
    ui.openEditor("pasta", action);
    enterQuantity(ui, 4);
    const poll = ui.loadStock(true);
    await ui.saveStock();
    assert.equal(oldSignal.aborted, true);
    finishOld(response({ products: [product(8)] }));
    await poll;
    assert.equal(ui.state.products.get("pasta").stock, 4);
    assert.equal(ui.element("#stock-editor").open, false);
  }
});

test("logout closes the editor and ignores pending stock changes", async () => {
  for (const action of ["add", "set"]) {
    let finish;
    const ui = await authenticatedDashboard((url, options) => options.method === "PATCH"
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve(response({ products: [product()] })));
    ui.openEditor("pasta", action);
    enterQuantity(ui, 3);
    const pending = ui.saveStock();
    ui.setAuthenticated(false);
    assert.equal(ui.state.editing, null);
    assert.equal(ui.element("#stock-editor").open, false);
    finish(response({ product: product(3) }));
    await pending;
    assert.equal(ui.state.products.size, 0);
    assert.equal(ui.element("#stock-list").children.length, 0);
    assert.equal(ui.intervals.size, 0);
    assert.equal(ui.element("#stock-message").textContent, "");
  }
});

test("expired read and save sessions close the modal and return to the existing login flow", async () => {
  const readUi = stockDashboard(async () => response({ error: "Unauthorized" }, 401));
  readUi.setAuthenticated(true);
  await flush();
  assert.equal(readUi.state.authenticated, false);
  assert.equal(readUi.intervals.size, 0);
  assert.equal(readUi.events[0].type, "dapoer:admin-session-expired");

  for (const action of ["add", "set"]) {
    const ui = await authenticatedDashboard(async (url, options) => options.method === "PATCH"
      ? response({ error: "Unauthorized" }, 401)
      : response({ products: [product()] }));
    ui.openEditor("pasta", action);
    enterQuantity(ui, 3);
    await ui.saveStock();
    assert.equal(ui.state.authenticated, false);
    assert.equal(ui.state.editing, null);
    assert.equal(ui.element("#stock-editor").open, false);
    assert.equal(ui.state.products.size, 0);
    assert.equal(ui.intervals.size, 0);
    assert.equal(ui.events[0].type, "dapoer:admin-session-expired");
  }
});
