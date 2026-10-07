const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function customer(fetch) {
  const elements = new Map();
  const saved = new Map();
  const opened = [];
  function node() {
    return { children: [], value: "", textContent: "", disabled: false,
      classList: { add() {}, remove() {}, toggle() {} },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener() {}, setAttribute() {}, reset() {} };
  }
  const document = { addEventListener() {}, createElement: node, hidden: false,
    body: node(), querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, node());
      return elements.get(selector);
    } };
  const context = vm.createContext({ document, fetch,
    localStorage: { getItem: name => saved.get(name), setItem: (name, value) => saved.set(name, value) },
    window: { open: (...args) => opened.push(args), location: {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1 });
  const source = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
  vm.runInContext(source + "\nglobalThis.api={state,loadMenu,addToCart,updateQuantity,renderCart,submitCheckout,openCheckout};", context);
  return { ...context.api, element: selector => document.querySelector(selector), opened, saved };
}

const product = stock => ({ id: "chicken-pop-corn-250gr", name: "Chicken pop corn 250gr", price: 37000, stock, image: "/8.png", badge: "Casa", description: "Ayam" });
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test("customer sees stock and cannot add or increment beyond available units", async () => {
  const ui = customer(async (url, options) => {
    assert.equal(url, "/api/menu");
    assert.equal(options.cache, "no-store");
    return reply({ products: [product(2)] });
  });
  await ui.loadMenu();
  assert.ok(descendants(ui.element("#menu-grid")).some(node => node.textContent === "Stok tersedia: 2"));
  ui.addToCart(product(2).id); ui.addToCart(product(2).id); ui.addToCart(product(2).id);
  assert.equal(ui.state.cart[0].quantity, 2);
  ui.updateQuantity(product(2).id, 1);
  assert.equal(ui.state.cart[0].quantity, 2);
  assert.equal(ui.element("#checkout-button").disabled, false);
});

test("refresh exposes sold-out products and preserves an old cart for explicit correction", async () => {
  let stock = 2;
  const ui = customer(async () => reply({ products: [product(stock)] }));
  await ui.loadMenu(); ui.addToCart(product(stock).id); ui.addToCart(product(stock).id);
  stock = 0;
  await ui.loadMenu();
  assert.equal(ui.state.cart[0].quantity, 2);
  assert.equal(ui.element("#checkout-button").disabled, true);
  const menu = descendants(ui.element("#menu-grid"));
  assert.ok(menu.some(node => node.className === "add-button" && node.disabled));
  assert.ok(descendants(ui.element("#cart-items")).some(node => /Hapus produk yang habis/.test(node.textContent)));
});

test("unavailable menu disables stale stock instead of trusting persisted cart quantities", async () => {
  let failed = false;
  const ui = customer(async () => failed ? reply({ error: "Unavailable" }, 503) : reply({ products: [product(2)] }));
  await ui.loadMenu(); ui.addToCart(product(2).id);
  failed = true;
  await ui.loadMenu();
  ui.updateQuantity(product(2).id, 1);
  assert.equal(ui.state.cart[0].quantity, 1);
  assert.equal(ui.element("#checkout-button").disabled, true);
});

test("checkout stock conflict refreshes quantities without opening WhatsApp or clearing the cart", async () => {
  let stock = 2;
  const ui = customer(async url => {
    if (url === "/api/menu") return reply({ products: [product(stock)] });
    assert.equal(url, "/api/order"); stock = 0;
    return reply({ code: "INSUFFICIENT_STOCK", error: "Stok tidak mencukupi." }, 409);
  });
  await ui.loadMenu(); ui.addToCart(product(2).id);
  await ui.submitCheckout({ preventDefault() {} });
  assert.equal(ui.opened.length, 0);
  assert.equal(ui.state.cart[0].quantity, 1);
  assert.equal(ui.state.menu[0].stock, 0);
  assert.equal(ui.element("#checkout-button").disabled, true);
  assert.equal(ui.element("#toast-message").textContent, "Stok tidak mencukupi.");
  assert.equal(ui.element("#checkout-submit").disabled, false);
});
