const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function handlerWithInventory(listInventory) {
  const filename = require.resolve("../api/menu");
  delete require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function(name, parent, isMain) {
    if (parent?.filename === filename && name === "./_lib/inventory") return { listInventory };
    return originalLoad.call(this, name, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = originalLoad; }
}

function response() {
  return {
    headers: {}, setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test("public menu reads current stock on every request and disables response caching", async () => {
  let stock = 5;
  const handler = handlerWithInventory(async () => [{ id: "test-menu", stock }]);
  const first = response();
  await handler({ method: "GET" }, first);
  assert.equal(first.body.products[0].stock, 5);
  stock = 2;
  const next = response();
  await handler({ method: "GET" }, next);
  assert.equal(next.statusCode, 200);
  assert.equal(next.body.products[0].stock, 2);
  assert.equal(next.headers["Cache-Control"], "no-store");
  assert.equal(typeof next.body.store.name, "string");
});

test("public menu fails closed when inventory is unavailable without inventing stock", async () => {
  const handler = handlerWithInventory(async () => { throw new Error("private database detail"); });
  const res = response();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.products, undefined);
  assert.doesNotMatch(res.body.error, /private database detail/);
});

test("public menu rejects mutations before reading inventory", async () => {
  const handler = handlerWithInventory(async () => { throw new Error("Unexpected inventory read"); });
  const res = response();
  await handler({ method: "POST" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET");
});
