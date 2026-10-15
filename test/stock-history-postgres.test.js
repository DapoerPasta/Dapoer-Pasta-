// Optional integration tests. Only a dedicated LOCAL scratch database is
// accepted. The Neon transport is replaced; all application SQL executes on
// real PostgreSQL with its actual row locks, triggers and transaction rollback.
// STOCK_TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55432/dapoer_stock_test \
// STOCK_TEST_PG_MODULE=/workspace/.dapoer-postgres/node_modules/pg \
// NODE_PATH=/workspace/.dapoer-cloud/node_modules node --test test/stock-history-postgres.test.js
const { describe, test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const { PRODUCTS } = require("../api/_lib/catalog");

const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const previousDatabaseUrl = process.env.DATABASE_URL;
const [firstProduct, secondProduct] = [...PRODUCTS].sort((a, b) => a.id.localeCompare(b.id));
const fixtures = [];
let adminPool;
let fixtureSequence = 0;
let orderSequence = 0;

function loadWithMocks(targetName, mocks) {
  const target = require.resolve(targetName);
  delete require.cache[target];
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === target && Object.hasOwn(mocks, name)) return mocks[name];
    return originalLoad.call(this, name, parent, isMain);
  };
  try { return require(target); }
  finally { Module._load = originalLoad; }
}

function coldHistoryInstance() {
  const target = require.resolve("../api/_lib/stock-history");
  const instance = new Module(target, module);
  instance.filename = target;
  instance.paths = Module._nodeModulePaths(require("node:path").dirname(target));
  instance._compile(fs.readFileSync(target, "utf8"), target);
  return instance.exports;
}

function transport(pool) {
  const sql = async (parts, ...values) => {
    const text = typeof parts === "string" ? parts : parts.reduce((result, part, index) => result + (index ? `$${index}` : "") + part, "");
    return (await pool.query(text, values)).rows;
  };
  sql.query = async (text, values = []) => (await pool.query(text, values)).rows;
  return sql;
}

async function fixture({ legacy = false, initialize = true } = {}) {
  const schema = `history_integration_${process.pid}_${fixtureSequence++}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 16,
    options: `-c search_path=${schema} -c statement_timeout=20000 -c lock_timeout=15000` });
  const sql = transport(pool);
  const history = coldHistoryInstance();
  const db = loadWithMocks("../api/_lib/db", { "@neondatabase/serverless": { neon: () => sql } });
  const inventory = loadWithMocks("../api/_lib/inventory", { "./db": db });
  const result = { schema, pool, sql, db, inventory, history };
  fixtures.push(result);
  if (legacy) {
    await pool.query(`CREATE TABLE inventory(product_id TEXT PRIMARY KEY, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (let index = 0; index < PRODUCTS.length; index++) {
      await pool.query("INSERT INTO inventory(product_id,stock) VALUES($1,$2)", [PRODUCTS[index].id, 17 + index]);
    }
  }
  if (initialize) await db.ensureSchema();
  return result;
}

async function cleanFixtures() {
  while (fixtures.length) {
    const { pool, schema } = fixtures.pop();
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

function purchase(items = [[firstProduct, 1]], overrides = {}) {
  const id = `stock-history-order-${++orderSequence}`;
  return { id, trackingToken: crypto.randomBytes(24).toString("hex"),
    customer: { name: "Local history customer", phone: "081234567890", address: "Local test address", notes: "", paymentMethod: "DANA" },
    items: items.map(([product, quantity]) => ({ id: product.id, name: product.name, price: product.price, quantity, subtotal: product.price * quantity })),
    total: items.reduce((sum, [product, quantity]) => sum + product.price * quantity, 0), ...overrides };
}

async function stock(pool, product = firstProduct) {
  return (await pool.query("SELECT stock FROM inventory WHERE product_id=$1", [product.id])).rows[0].stock;
}

async function movements(pool, product = null) {
  return (await pool.query(`SELECT id::text, product_id, stock_before, stock_after, delta, source, reason, order_id, created_at
    FROM inventory_movements ${product ? "WHERE product_id=$1" : ""} ORDER BY id`, product ? [product.id] : [])).rows;
}

async function version(pool, id) {
  return (await pool.query("SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS version FROM orders WHERE id=$1", [id])).rows[0].version;
}

async function fixtureTimestamps(pool, timestamps, startedAt = "2024-12-01T00:00:00Z") {
  // Date fixtures only: this connection belongs to an isolated scratch schema.
  // Application SQL never receives a flag that can disable its audit trail.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of ["inventory_movements", "inventory_baselines", "inventory_history_meta"]) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await client.query("UPDATE inventory_baselines SET started_at=$1", [startedAt]);
    await client.query("UPDATE inventory_history_meta SET started_at=$1", [startedAt]);
    const ids = (await client.query("SELECT id FROM inventory_movements ORDER BY id")).rows.map(row => row.id);
    assert.equal(ids.length, timestamps.length);
    for (let index = 0; index < ids.length; index++) await client.query("UPDATE inventory_movements SET created_at=$1 WHERE id=$2", [timestamps[index], ids[index]]);
    for (const table of ["inventory_movements", "inventory_baselines", "inventory_history_meta"]) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

function todayInJakarta() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function restoreLegacyContextFreeProcedures(pool) {
  // Simulate an older, still-running serverless instance replacing the shared
  // original function definitions after the new deployment has initialized.
  for (const signature of [
    "dapoer_save_order(text,text,text,text,text,text,jsonb,bigint,text)",
    "dapoer_update_order_status(text,text)"
  ]) {
    const definition = (await pool.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [signature])).rows[0].definition;
    const legacy = definition
      .replace(/^\s*previous_stock_context:=current_setting[^\n]*\n/gm, "")
      .replace(/^\s*PERFORM set_config\('dapoer\.stock_context',[^\n]*\n/gm, "");
    assert.notEqual(legacy, definition, "fixture must remove the new context behavior from the original procedure");
    assert.doesNotMatch(legacy, /set_config\('dapoer\.stock_context'/);
    await pool.query(legacy);
  }
}

function orderArguments(order) {
  return [order.id, order.customer.name, order.customer.phone, order.customer.address, order.customer.notes,
    order.customer.paymentMethod, JSON.stringify(order.items), order.total, order.trackingToken];
}

describe("real PostgreSQL inventory ledger and stock history reports", { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    const url = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only a local scratch database is allowed");
    assert.match(url.pathname, /^\/dapoer_stock_test(?:_[a-z0-9_]+)?$/, "Use a dedicated dapoer_stock_test database");
    const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    process.env.DATABASE_URL = databaseUrl;
  });

  afterEach(cleanFixtures);

  after(async () => {
    await cleanFixtures();
    if (adminPool) await adminPool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    for (const path of ["../api/_lib/db", "../api/_lib/inventory", "../api/_lib/stock-history"]) delete require.cache[require.resolve(path)];
  });

  test("migration preserves existing nonzero inventory as opening balances without invented movements", async () => {
    const { pool, db, history, sql } = await fixture({ legacy: true, initialize: false });
    const beforeStocks = (await pool.query("SELECT product_id,stock FROM inventory ORDER BY product_id")).rows;
    await history.ensureStockHistorySchema(sql);
    const baselines = (await pool.query("SELECT product_id,stock FROM inventory_baselines ORDER BY product_id")).rows;
    assert.deepEqual(baselines, beforeStocks);
    assert.equal((await movements(pool)).length, 0);
    await db.ensureSchema();
    await db.ensureSchema();
    await history.ensureStockHistorySchema(sql);
    assert.deepEqual((await pool.query("SELECT product_id,stock FROM inventory_baselines ORDER BY product_id")).rows, beforeStocks);
    assert.deepEqual((await pool.query("SELECT product_id,stock FROM inventory ORDER BY product_id")).rows, beforeStocks);
    assert.equal((await movements(pool)).length, 0);
  });

  test("six independent first-use migrations retain one baseline and one recording trigger", async () => {
    const { pool, sql } = await fixture({ legacy: true, initialize: false });
    const beforeStocks = (await pool.query("SELECT product_id,stock FROM inventory ORDER BY product_id")).rows;
    const workers = Array.from({ length: 6 }, () => coldHistoryInstance());
    const results = await Promise.allSettled(workers.map(worker => worker.ensureStockHistorySchema(sql)));
    assert.deepEqual(results.map(result => result.status), Array(6).fill("fulfilled"), results.filter(result => result.status === "rejected").map(result => result.reason.message).join("; "));
    assert.deepEqual((await pool.query("SELECT product_id,stock FROM inventory_baselines ORDER BY product_id")).rows, beforeStocks);
    assert.equal((await movements(pool)).length, 0);
    await pool.query("UPDATE inventory SET stock=stock+2 WHERE product_id=$1", [firstProduct.id]);
    assert.equal((await movements(pool)).length, 1, "one physical stock change must record once even after concurrent setup");
  });

  test("legacy add, subtract, exact edit and clear each record their actual before and after values", async () => {
    const { pool, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 12, undefined, "Produksi pagi");
    await inventory.adjustStock(firstProduct.id, -2, undefined, "Kemasan rusak");
    await inventory.setStock(firstProduct.id, 7, 10, undefined, "Hitung fisik");
    await inventory.setStock(firstProduct.id, 0, 7, undefined, "Kosongkan stok lama");
    const rows = await movements(pool);
    assert.deepEqual(rows.map(row => [row.stock_before, row.delta, row.stock_after]), [[0, 12, 12], [12, -2, 10], [10, -3, 7], [7, -7, 0]]);
    assert.deepEqual(rows.map(row => row.reason), ["Produksi pagi", "Kemasan rusak", "Hitung fisik", "Kosongkan stok lama"]);
    assert.ok(rows.every(row => row.order_id === null));
    assert.equal(await stock(pool), 0);
  });

  test("UUID retries record one movement, preserve the first result and reject a changed reason", async () => {
    const { pool, inventory } = await fixture();
    const id = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => inventory.adjustStock(firstProduct.id, 9, id, "Produksi batch A")));
    assert.ok(results.every(result => result.stock === 9));
    await inventory.adjustStock(firstProduct.id, 1, crypto.randomUUID(), "Tambahan lain");
    assert.equal((await inventory.adjustStock(firstProduct.id, 9, id, "Produksi batch A")).stock, 9);
    await assert.rejects(() => inventory.adjustStock(firstProduct.id, 9, id, "Alasan diubah"), error => error.code === "REQUEST_CONFLICT");
    assert.equal(await stock(pool), 10);
    assert.equal((await movements(pool)).length, 2);
    const setId = crypto.randomUUID();
    await Promise.all(Array.from({ length: 8 }, () => inventory.setStock(firstProduct.id, 4, 10, setId, "Koreksi akhir")));
    assert.deepEqual((await movements(pool)).map(row => row.delta), [9, 1, -6]);
    assert.equal(await stock(pool), 4);
  });

  test("no-change edits, stale comparisons, insufficient stock and invalid adjustments add no movements", async () => {
    const { pool, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 5, crypto.randomUUID());
    const before = await movements(pool);
    await inventory.setStock(firstProduct.id, 5, 5, crypto.randomUUID());
    await inventory.setStock(firstProduct.id, 5, 5);
    await assert.rejects(() => inventory.setStock(firstProduct.id, 3, 6, crypto.randomUUID()), error => error.code === "STOCK_CONFLICT");
    await assert.rejects(() => inventory.adjustStock(firstProduct.id, -6, crypto.randomUUID()), error => error.code === "INSUFFICIENT_STOCK");
    await assert.rejects(() => inventory.adjustStock(firstProduct.id, 0, crypto.randomUUID()));
    await assert.rejects(() => inventory.setStock(firstProduct.id, -1, 5));
    assert.deepEqual(await movements(pool), before);
    assert.equal(await stock(pool), 5);
  });

  test("a successful reservation and eligible cancellation each record once with the order reference", async () => {
    const { pool, db, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 10);
    await inventory.adjustStock(secondProduct.id, 10);
    const order = purchase([[firstProduct, 2], [secondProduct, 3]], { requestId: crypto.randomUUID() });
    await Promise.all(Array.from({ length: 8 }, () => db.saveOrder(structuredClone(order))));
    let rows = (await movements(pool)).filter(row => row.order_id === order.id);
    assert.deepEqual(rows.map(row => [row.product_id, row.delta]), [[firstProduct.id, -2], [secondProduct.id, -3]]);
    assert.ok(rows.every(row => row.source === "order"));
    const expected = { expectedStatus: "baru", expectedUpdatedAt: await version(pool, order.id) };
    await Promise.all(Array.from({ length: 8 }, () => db.updateOrderStatus(order.id, "dibatalkan", expected)));
    await db.updateOrderStatus(order.id, "dibatalkan");
    rows = (await movements(pool)).filter(row => row.order_id === order.id);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(row => row.delta), [-2, -3, 2, 3]);
    assert.ok(rows.slice(2).every(row => row.source === "cancellation"));
    assert.equal(await stock(pool), 10);
    assert.equal(await stock(pool, secondProduct), 10);
  });

  test("fulfilment status changes and forbidden late cancellations do not change the stock ledger", async () => {
    const { pool, db, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 5);
    const order = purchase();
    await db.saveOrder(order);
    const before = await movements(pool);
    await db.updateOrderStatus(order.id, "diproses");
    await db.updateOrderStatus(order.id, "dikirim");
    await assert.rejects(() => db.updateOrderStatus(order.id, "dibatalkan"), /CANCELLATION_NOT_ALLOWED/);
    await db.updateOrderStatus(order.id, "selesai");
    assert.deepEqual(await movements(pool), before);
    assert.equal(await stock(pool), 4);
  });

  test("failure on a later order item rolls back earlier deductions and their movements", async () => {
    const { pool, db, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 5);
    const before = await movements(pool);
    await assert.rejects(() => db.saveOrder(purchase([[firstProduct, 2], [secondProduct, 1]], { requestId: crypto.randomUUID() })), /INSUFFICIENT_STOCK/);
    assert.deepEqual(await movements(pool), before);
    assert.equal(await stock(pool), 5);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM orders")).rows[0].count, 0);
  });

  test("concurrent checkouts keep an unbroken stock chain and never record failed reservations", async () => {
    const { pool, db, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 6);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => db.saveOrder(purchase([[firstProduct, 1]], { requestId: crypto.randomUUID() }))));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 6);
    assert.equal(results.filter(result => result.status === "rejected").length, 6);
    const rows = await movements(pool);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map(row => [row.stock_before, row.stock_after]), [[0, 6], [6, 5], [5, 4], [4, 3], [3, 2], [2, 1], [1, 0]]);
    assert.equal(rows.filter(row => row.order_id).length, 6);
    assert.equal(await stock(pool), 0);
  });

  test("recorded movements and opening baselines cannot be rewritten or deleted", async () => {
    const { pool, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 3);
    const before = await movements(pool);
    for (const statement of [
      "UPDATE inventory_movements SET delta=999",
      "DELETE FROM inventory_movements",
      "UPDATE inventory_baselines SET stock=999",
      "DELETE FROM inventory_baselines"
    ]) await assert.rejects(() => pool.query(statement));
    assert.deepEqual(await movements(pool), before);
    assert.equal((await pool.query("SELECT stock FROM inventory_baselines WHERE product_id=$1", [firstProduct.id])).rows[0].stock, 0);
  });

  test("day, Monday week, calendar month and year reports apply exact WIB boundaries", async () => {
    const { pool, sql, inventory, history } = await fixture();
    for (const delta of [1, 2, 3, 4, -2, 6, 7, 8, 9, 10]) await inventory.adjustStock(firstProduct.id, delta);
    await fixtureTimestamps(pool, [
      "2024-12-31T16:59:59.999999Z", "2024-12-31T17:00:00Z", "2025-01-01T16:59:59.999999Z",
      "2025-01-01T17:00:00Z", "2025-01-02T16:59:59.999999Z", "2025-01-02T17:00:00Z",
      "2025-01-05T17:00:00Z", "2025-01-31T17:00:00Z", "2025-12-31T16:59:59.999999Z", "2025-12-31T17:00:00Z"
    ]);
    for (const [period, count, opening, incoming, outgoing, closing, startDate, endDate] of [
      ["day", 2, 6, 4, 2, 8, "2025-01-02", "2025-01-02"],
      ["week", 6, 0, 16, 2, 14, "2024-12-30", "2025-01-05"],
      ["month", 6, 1, 22, 2, 21, "2025-01-01", "2025-01-31"],
      ["year", 8, 1, 39, 2, 38, "2025-01-01", "2025-12-31"]
    ]) {
      const report = await history.listStockHistory({ period, date: "2025-01-02" }, sql);
      assert.equal(report.timeZone, "Asia/Jakarta");
      assert.deepEqual(report.summary, { movementCount: count, opening, incoming, outgoing, closing }, period);
      assert.equal(report.period.startDate, startDate);
      assert.equal(report.period.endDate, endDate);
      assert.equal(report.movements.length, count);
      assert.equal(report.products.length, PRODUCTS.length);
      assert.equal(report.coverage.partial, false);
      assert.equal(report.coverage.available, true);
      assert.equal(report.products.find(product => product.id === firstProduct.id).closing, closing);
      assert.ok(report.products.filter(product => product.id !== firstProduct.id).every(product => product.opening === 0 && product.closing === 0));
    }
  });

  test("periods before activation show unknown balances and never assign today's stock to the past", async () => {
    const { pool, sql, history } = await fixture({ legacy: true });
    const old = await history.listStockHistory({ period: "year", date: "2020-01-01" }, sql);
    assert.equal(old.coverage.available, false);
    assert.equal(old.coverage.partial, true);
    assert.equal(old.coverage.effectiveStart, null);
    assert.equal(old.coverage.effectiveEnd, null);
    assert.equal(old.summary.opening, null);
    assert.equal(old.summary.closing, null);
    assert.equal(old.summary.movementCount, 0);
    assert.deepEqual(old.movements, []);
    assert.ok(old.products.every(product => product.opening === null && product.closing === null));
    const today = await history.listStockHistory({ period: "day", date: todayInJakarta() }, sql);
    const baselineTotal = (await pool.query("SELECT SUM(stock)::int AS stock FROM inventory_baselines")).rows[0].stock;
    assert.equal(today.summary.opening, baselineTotal);
    assert.equal(today.summary.closing, baselineTotal);
    assert.equal(today.coverage.available, true);
    assert.equal(today.coverage.partial, true);
    assert.equal(today.coverage.effectiveStart, today.coverage.startedAt);
    assert.equal(today.summary.movementCount, 0);
  });

  test("product filtering, full totals and all pages stay frozen after later inventory changes", async () => {
    const { pool, sql, history } = await fixture();
    await pool.query(`DO $test$ BEGIN
      FOR item IN 1..137 LOOP UPDATE inventory SET stock=stock+1 WHERE product_id='${firstProduct.id}'; END LOOP;
      FOR item IN 1..7 LOOP UPDATE inventory SET stock=stock+1 WHERE product_id='${secondProduct.id}'; END LOOP;
    END $test$;`);
    const first = await history.listStockHistory({ period: "day", date: todayInJakarta(), productId: firstProduct.id, pageSize: 33 }, sql);
    assert.equal(first.movements.length, 33);
    assert.equal(first.pagination.total, 137);
    assert.deepEqual(first.summary, { movementCount: 137, opening: 0, incoming: 137, outgoing: 0, closing: 137 });
    assert.deepEqual(first.products.map(product => product.id), [firstProduct.id]);
    await pool.query("UPDATE inventory SET stock=stock+9 WHERE product_id=$1", [firstProduct.id]);
    const all = [...first.movements];
    let cursor = first.pagination.nextCursor;
    while (cursor !== null) {
      const page = await history.listStockHistory({ snapshot: first.pagination.snapshot, cursor, pageSize: 33 }, sql);
      assert.deepEqual(page.summary, first.summary);
      assert.deepEqual(page.coverage, first.coverage);
      assert.equal(page.generatedAt, first.generatedAt);
      assert.deepEqual(page.products, first.products);
      assert.equal(page.pagination.total, 137);
      all.push(...page.movements);
      cursor = page.pagination.nextCursor;
    }
    assert.equal(all.length, 137);
    assert.equal(new Set(all.map(row => row.id)).size, 137);
    assert.ok(all.every(row => row.productId === firstProduct.id));
    assert.equal(all[0].stockAfter, 137);
    assert.equal(all.at(-1).stockBefore, 0);
    const fresh = await history.listStockHistory({ period: "day", date: todayInJakarta() }, sql);
    assert.equal(fresh.summary.movementCount, 145);
    assert.equal(fresh.summary.closing, 153);
    assert.equal(fresh.summary.incoming, 153);
  });

  test("a transaction committing later with an older movement id cannot enter an existing report", async () => {
    const { pool, sql, history } = await fixture();
    const late = await pool.connect();
    try {
      await late.query("BEGIN");
      await late.query("UPDATE inventory SET stock=stock+4 WHERE product_id=$1", [firstProduct.id]);
      const held = (await late.query("SELECT id::text FROM inventory_movements WHERE product_id=$1", [firstProduct.id])).rows[0].id;
      await pool.query("UPDATE inventory SET stock=stock+6 WHERE product_id=$1", [secondProduct.id]);
      const before = await history.listStockHistory({ period: "day", date: todayInJakarta(), pageSize: 1 }, sql);
      assert.equal(before.pagination.total, 1);
      assert.equal(before.movements[0].productId, secondProduct.id);
      assert.ok(BigInt(held) < BigInt(before.movements[0].id));
      assert.equal(before.summary.closing, 6);
      await late.query("COMMIT");
      const after = await history.listStockHistory({ snapshot: before.pagination.snapshot, cursor: 0, pageSize: 1 }, sql);
      assert.deepEqual(after, before);
      const fresh = await history.listStockHistory({ period: "day", date: todayInJakarta() }, sql);
      assert.equal(fresh.pagination.total, 2);
      assert.equal(fresh.summary.closing, 10);
    } finally {
      await late.query("ROLLBACK");
      late.release();
    }
  });

  test("expired snapshots fail explicitly rather than mixing current data into an older report", async () => {
    const { pool, sql, history, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 5);
    const report = await history.listStockHistory({ period: "day", date: todayInJakarta() }, sql);
    await pool.query("UPDATE inventory_report_snapshots SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [report.pagination.snapshot]);
    await assert.rejects(() => history.listStockHistory({ snapshot: report.pagination.snapshot }, sql), error => error.code === "STOCK_HISTORY_EXPIRED");
    assert.equal(await stock(pool), 5);
    assert.equal((await movements(pool)).length, 1);
  });

  test("snapshot quota rejection commits expired cleanup and allows creation once capacity returns", async () => {
    const { pool, sql, history } = await fixture();
    await pool.query(`INSERT INTO inventory_report_snapshots(id,report,expires_at)
      SELECT md5('history-quota-'||value::text)::uuid,'{}'::jsonb,clock_timestamp()+INTERVAL '1 hour'
      FROM generate_series(1,240) AS value`);
    const expiredId = crypto.randomUUID();
    await pool.query("INSERT INTO inventory_report_snapshots(id,report,expires_at) VALUES($1,'{}'::jsonb,clock_timestamp()-INTERVAL '1 minute')", [expiredId]);
    await assert.rejects(() => history.listStockHistory({ period: "day", date: todayInJakarta() }, sql), error => error.code === "STOCK_HISTORY_BUSY");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM inventory_report_snapshots WHERE id=$1", [expiredId])).rows[0].count, 0,
      "quota rejection must not roll back deletion of expired snapshots");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM inventory_report_snapshots")).rows[0].count, 240);
    await pool.query("DELETE FROM inventory_report_snapshots WHERE id=(SELECT id FROM inventory_report_snapshots ORDER BY id LIMIT 1)");
    const report = await history.listStockHistory({ period: "day", date: todayInJakarta() }, sql);
    assert.equal(report.summary.movementCount, 0);
    assert.equal(report.summary.opening, 0);
    assert.equal(report.summary.closing, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM inventory_report_snapshots")).rows[0].count, 240);
  });

  test("recorded wrappers retain order metadata after an older worker replaces the original procedures", async () => {
    const { pool, inventory, db } = await fixture();
    await inventory.adjustStock(firstProduct.id, 20);
    await inventory.adjustStock(secondProduct.id, 20);
    await restoreLegacyContextFreeProcedures(pool);
    const legacyOrder = purchase([[firstProduct, 2]]);
    const uuidOrder = purchase([[secondProduct, 3]], { requestId: crypto.randomUUID() });
    await db.saveOrder(legacyOrder);
    await db.saveOrder(uuidOrder);
    await db.updateOrderStatus(legacyOrder.id, "dibatalkan", { expectedStatus: "baru", expectedUpdatedAt: await version(pool, legacyOrder.id) });
    await db.updateOrderStatus(uuidOrder.id, "dibatalkan");
    for (const [order, quantity] of [[legacyOrder, 2], [uuidOrder, 3]]) {
      const rows = (await movements(pool)).filter(row => row.order_id === order.id);
      assert.deepEqual(rows.map(row => [row.source, row.delta]), [["order", -quantity], ["cancellation", quantity]]);
    }
    assert.equal(await stock(pool), 20);
    assert.equal(await stock(pool, secondProduct), 20);
  });

  test("recorded wrappers restore an enclosing transaction's stock context after success and caught failure", async () => {
    const { pool, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 5);
    await restoreLegacyContextFreeProcedures(pool);
    const client = await pool.connect();
    const context = JSON.stringify({ source: "system", reason: "Context luar transaksi" });
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('dapoer.stock_context',$1,TRUE)", [context]);
      await client.query(`SELECT dapoer_save_order_with_queue_recorded($1,$2,$3,$4,$5,$6,$7::jsonb,$8::bigint,$9)`, orderArguments(purchase()));
      assert.equal((await client.query("SELECT current_setting('dapoer.stock_context',TRUE) AS context")).rows[0].context, context);
      await client.query("SAVEPOINT before_failed_order");
      await assert.rejects(() => client.query(`SELECT dapoer_save_order_with_queue_recorded($1,$2,$3,$4,$5,$6,$7::jsonb,$8::bigint,$9)`, orderArguments(purchase([[firstProduct, 99]]))), /INSUFFICIENT_STOCK/);
      await client.query("ROLLBACK TO SAVEPOINT before_failed_order");
      assert.equal((await client.query("SELECT current_setting('dapoer.stock_context',TRUE) AS context")).rows[0].context, context);
      await client.query("UPDATE inventory SET stock=stock+1 WHERE product_id=$1", [secondProduct.id]);
      await client.query("COMMIT");
      const last = (await movements(pool)).at(-1);
      assert.equal(last.source, "system");
      assert.equal(last.reason, "Context luar transaksi");
      assert.equal(last.order_id, null);
      assert.equal(await stock(pool), 4);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM orders")).rows[0].count, 1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("inventory removal, truncation and product identity changes cannot bypass the audit trail", async () => {
    const { pool, inventory } = await fixture();
    await inventory.adjustStock(firstProduct.id, 3);
    const before = await movements(pool);
    await assert.rejects(() => pool.query("DELETE FROM inventory WHERE product_id=$1", [firstProduct.id]));
    await assert.rejects(() => pool.query("TRUNCATE inventory"));
    await assert.rejects(() => pool.query("UPDATE inventory SET product_id=$2 WHERE product_id=$1", [firstProduct.id, `${firstProduct.id}-renamed`]));
    assert.deepEqual(await movements(pool), before);
    assert.equal(await stock(pool), 3);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM inventory")).rows[0].count, PRODUCTS.length);
  });
});
