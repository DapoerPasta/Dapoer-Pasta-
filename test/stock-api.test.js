const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const auth = require("../api/_lib/auth");
const { PRODUCTS } = require("../api/_lib/catalog");
const { validateStockAdjustment, validateStockSet, MAX_STOCK } = require("../api/_lib/inventory");
const { createRequestGuard } = require("../api/_lib/security");

const fixture = {
  ADMIN_EMAIL: "stock-admin@example.test",
  ADMIN_PASSWORD: "stock-test-only-password",
  ADMIN_SESSION_SECRET: "stock-test-only-secret-at-least-32-characters"
};
const previous = Object.fromEntries(Object.keys(fixture).map(name => [name, process.env[name]]));
test.beforeEach(() => Object.assign(process.env, fixture));
test.afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(method, body, headers = {}) {
  return {
    method, body, socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "shop.example.test",
      cookie: `dp_admin_session=${auth.createSession(fixture.ADMIN_EMAIL)}`,
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
      ...headers
    }
  };
}

function loadHandler(name, overrides = {}) {
  const target = require.resolve(`../api/admin/${name}`);
  delete require.cache[target];
  const guard = createRequestGuard({ getSql: () => null, environment: {} });
  const originalLoad = Module._load;
  Module._load = function (path, parent, isMain) {
    if (parent?.filename === target && path === "../_lib/security") return { guardRequest: guard };
    if (parent?.filename === target && path === "../_lib/inventory") return {
      listInventory: async () => [], adjustStock: async () => {}, setStock: async () => {},
      validateStockAdjustment, validateStockSet, ...overrides
    };
    if (parent?.filename === target && path === "../_lib/db") return overrides;
    return originalLoad.call(this, path, parent, isMain);
  };
  try { return require(target); }
  finally { Module._load = originalLoad; }
}

test("only signed administrator sessions can read or adjust inventory", async () => {
  let queries = 0;
  const handler = loadHandler("stock", {
    listInventory: async () => { queries++; return []; },
    adjustStock: async () => { queries++; return {}; },
    setStock: async () => { queries++; return {}; }
  });
  for (const [method, body] of [
    ["GET", undefined],
    ["PATCH", { id: PRODUCTS[0].id, delta: 1 }],
    ["PATCH", { id: PRODUCTS[0].id, stock: 0, expectedStock: 3 }]
  ]) {
    const res = response();
    await handler(request(method, body, { cookie: "" }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["cache-control"], "private, no-store");
  }
  assert.equal(queries, 0);
});

test("inventory reads return current counts and adjustment sends an additive change", async () => {
  const product = { ...PRODUCTS[0], stock: 7 };
  const changes = [];
  const handler = loadHandler("stock", {
    listInventory: async () => [product],
    adjustStock: async (id, delta) => { changes.push({ id, delta }); return { ...product, stock: 9 }; }
  });
  const get = response();
  await handler(request("GET"), get);
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.body, { products: [product] });
  const patch = response();
  await handler(request("PATCH", { id: PRODUCTS[0].id, delta: 2 }), patch);
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.body.product.stock, 9);
  assert.deepEqual(changes, [{ id: PRODUCTS[0].id, delta: 2 }]);
});

test("administrators can set an exact stock count and clear already entered stock", async () => {
  const changes = [];
  const handler = loadHandler("stock", {
    setStock: async (id, stock, expectedStock) => {
      changes.push({ id, stock, expectedStock });
      return { ...PRODUCTS[0], stock };
    },
    adjustStock: async () => { assert.fail("Exact stock updates must not use an additive adjustment"); }
  });
  for (const [stock, expectedStock] of [[12, 7], [3, 12], [0, 3], [5, 0], [5, 5]]) {
    const res = response();
    await handler(request("PATCH", { id: ` ${PRODUCTS[0].id} `, stock, expectedStock }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.product, { ...PRODUCTS[0], stock });
  }
  assert.deepEqual(changes, [
    { id: PRODUCTS[0].id, stock: 12, expectedStock: 7 },
    { id: PRODUCTS[0].id, stock: 3, expectedStock: 12 },
    { id: PRODUCTS[0].id, stock: 0, expectedStock: 3 },
    { id: PRODUCTS[0].id, stock: 5, expectedStock: 0 },
    { id: PRODUCTS[0].id, stock: 5, expectedStock: 5 }
  ]);
});

test("setting stock requires one unambiguous action and valid observed stock", async () => {
  let writes = 0;
  const handler = loadHandler("stock", {
    setStock: async () => { writes++; },
    adjustStock: async () => { writes++; }
  });
  const invalidCounts = ["2", 1.5, null, true, -1, MAX_STOCK + 1, Number.MAX_SAFE_INTEGER];
  for (const body of [
    { id: "unknown", stock: 1, expectedStock: 0 },
    { id: PRODUCTS[0].id, stock: 2 },
    { id: PRODUCTS[0].id, stock: 0, expectedStock: 2, delta: -2 },
    { id: PRODUCTS[0].id, stock: 2, expectedStock: 0, delta: null },
    ...invalidCounts.map(stock => ({ id: PRODUCTS[0].id, stock, expectedStock: 0 })),
    ...invalidCounts.map(expectedStock => ({ id: PRODUCTS[0].id, stock: 0, expectedStock }))
  ]) {
    const res = response();
    await handler(request("PATCH", body), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.body.code, "INVALID_STOCK_SET");
  }
  assert.equal(writes, 0);
  assert.doesNotThrow(() => validateStockSet(PRODUCTS[0].id, 0, MAX_STOCK));
  assert.doesNotThrow(() => validateStockSet(PRODUCTS[0].id, MAX_STOCK, 0));
});

test("a stale stock editor receives a conflict and cannot clear a newer count", async () => {
  const handler = loadHandler("stock", {
    setStock: async () => { throw Object.assign(new Error("STOCK_CONFLICT"), { code: "STOCK_CONFLICT" }); }
  });
  const res = response();
  await handler(request("PATCH", { id: PRODUCTS[0].id, stock: 0, expectedStock: 7 }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "STOCK_CONFLICT");
  assert.match(res.body.error, /Muat ulang stok/);
  assert.equal(res.body.product, undefined);
});

test("invalid changes are rejected before reaching persistence", async () => {
  let writes = 0;
  const handler = loadHandler("stock", { adjustStock: async () => { writes++; } });
  for (const body of [
    {}, { id: "unknown", delta: 1 }, { id: PRODUCTS[0].id, delta: 0 },
    ...["2", 1.5, null, true, MAX_STOCK + 1, -MAX_STOCK - 1].map(delta => ({ id: PRODUCTS[0].id, delta }))
  ]) {
    const res = response();
    await handler(request("PATCH", body), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_STOCK_ADJUSTMENT");
  }
  assert.equal(writes, 0);
  assert.doesNotThrow(() => validateStockAdjustment(PRODUCTS[0].id, MAX_STOCK));
  assert.doesNotThrow(() => validateStockAdjustment(PRODUCTS[0].id, -MAX_STOCK));
});

test("stock mutations retain same-origin, JSON, body size and HTTP method protections", async () => {
  let writes = 0;
  const handler = loadHandler("stock", {
    adjustStock: async () => { writes++; return {}; },
    setStock: async () => { writes++; return {}; }
  });
  const cases = [
    ["PATCH", { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }, 403],
    ["PATCH", { "content-type": "text/plain" }, 415],
    ["PATCH", { "content-length": "20000" }, 413],
    ["POST", {}, 405]
  ];
  for (const body of [
    { id: PRODUCTS[0].id, delta: 1 },
    { id: PRODUCTS[0].id, stock: 0, expectedStock: 3 }
  ]) {
    for (const [method, headers, status] of cases) {
      const res = response();
      await handler(request(method, body, headers), res);
      assert.equal(res.statusCode, status);
    }
  }
  assert.equal(writes, 0);
});

test("excessive administrator stock requests are limited", async () => {
  let reads = 0;
  const handler = loadHandler("stock", { listInventory: async () => { reads++; return []; } });
  for (let count = 0; count < 60; count++) {
    const res = response();
    await handler(request("GET"), res);
    assert.equal(res.statusCode, 200);
  }
  const blocked = response();
  await handler(request("GET"), blocked);
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  assert.equal(reads, 60);
});

test("inventory conflicts and unavailable databases return actionable failures", async () => {
  for (const [code, status] of [["INSUFFICIENT_STOCK", 409], ["DATABASE_NOT_CONFIGURED", 503]]) {
    const handler = loadHandler("stock", {
      adjustStock: async () => { throw Object.assign(new Error(code), { code }); }
    });
    const res = response();
    await handler(request("PATCH", { id: PRODUCTS[0].id, delta: -2 }), res);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.product, undefined);
  }
  const handler = loadHandler("stock", {
    setStock: async () => { throw Object.assign(new Error("DATABASE_NOT_CONFIGURED"), { code: "DATABASE_NOT_CONFIGURED" }); }
  });
  const res = response();
  await handler(request("PATCH", { id: PRODUCTS[0].id, stock: 0, expectedStock: 3 }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.product, undefined);
});

test("reopening a cancelled stock-reserved order reports a conflict", async () => {
  const handler = loadHandler("status", {
    updateOrderStatus: async () => { throw Object.assign(new Error("ORDER_CANCELLED"), { code: "ORDER_CANCELLED" }); }
  });
  const res = response();
  await handler(request("PATCH", { id: "DP-stock-test", status: "diproses" }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "ORDER_CANCELLED");
});
