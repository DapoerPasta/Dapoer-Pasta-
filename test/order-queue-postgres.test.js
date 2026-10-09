// Optional real PostgreSQL suite. Only a dedicated LOCAL scratch database is
// accepted; no application or production database is used.
// STOCK_TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55432/dapoer_stock_test \
// STOCK_TEST_PG_MODULE=/workspace/.dapoer-postgres/node_modules/pg \
// NODE_PATH=/workspace/.dapoer-cloud/node_modules node --test test/order-queue-postgres.test.js
const { describe, test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { PRODUCTS } = require("../api/_lib/catalog");
const { ensureOrderQueueSchema } = require("../api/_lib/order-queue");

const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const previousDatabaseUrl = process.env.DATABASE_URL;
const fixtures = [];
const [firstProduct, secondProduct] = [...PRODUCTS].sort((a, b) => a.id.localeCompare(b.id));
let adminPool;
let sequence = 0;
let fixtureSequence = 0;

function order(items = [[firstProduct, 1]], overrides = {}) {
  const id = `queue-order-${++sequence}`;
  return {
    id,
    trackingToken: `queue-tracking-${id}`,
    customer: { name: "Local queue customer", phone: "081234567890", address: "Test address", notes: "", paymentMethod: "DANA" },
    items: items.map(([product, quantity]) => ({ id: product.id, name: product.name, price: product.price, quantity })),
    total: items.reduce((sum, [product, quantity]) => sum + product.price * quantity, 0),
    ...overrides
  };
}

function loadDb(sql) {
  const path = require.resolve("../api/_lib/db");
  delete require.cache[path];
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === path && name === "@neondatabase/serverless") return { neon: () => sql };
    return originalLoad.call(this, name, parent, isMain);
  };
  try { return require(path); }
  finally { Module._load = originalLoad; }
}

async function fixture() {
  const schema = `queue_integration_${process.pid}_${fixtureSequence++}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 12,
    options: `-c search_path=${schema} -c statement_timeout=12000 -c lock_timeout=10000` });
  const sql = async (parts, ...values) => {
    const text = typeof parts === "string" ? parts : parts.reduce((result, part, index) => result + (index ? `$${index}` : "") + part, "");
    return (await pool.query(text, values)).rows;
  };
  sql.query = async (text, values = []) => (await pool.query(text, values)).rows;
  const result = { schema, pool, sql, db: loadDb(sql) };
  fixtures.push(result);
  return result;
}

async function cleanFixtures() {
  while (fixtures.length) {
    const { pool, schema } = fixtures.pop();
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function legacyOrders(pool, rows) {
  await pool.query(`CREATE TABLE orders (
    id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL,
    address TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', payment_method TEXT NOT NULL,
    items JSONB NOT NULL, total BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'baru',
    tracking_token TEXT, stock_reserved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  for (const row of rows) {
    await pool.query(`INSERT INTO orders(id, customer_name, customer_phone, address, payment_method,
      items, total, status, created_at, updated_at)
      VALUES($1, 'Historical customer', '081234567890', 'Old address', 'DANA', '[]'::jsonb,
      $2, $3, $4::timestamptz, $5::timestamptz)`,
    [row.id, row.total || 37000, row.status || "selesai", row.createdAt, row.updatedAt || row.createdAt]);
  }
}

async function stock(pool, product = firstProduct) {
  return (await pool.query("SELECT stock FROM inventory WHERE product_id = $1", [product.id])).rows[0].stock;
}

async function counter(pool) {
  return (await pool.query("SELECT COALESCE(SUM(last_number), 0)::integer AS value FROM order_queue_counters")).rows[0].value;
}

async function insertHistorical(pool, id, createdAt, queueNumber, queueDate) {
  const columns = queueNumber === undefined ? "" : ", queue_number, queue_date";
  const parameters = queueNumber === undefined ? "" : ", $3::integer, $4::date";
  const values = queueNumber === undefined ? [id, createdAt] : [id, createdAt, queueNumber, queueDate];
  return pool.query(`INSERT INTO orders(id, customer_name, customer_phone, address, payment_method, items, total, created_at${columns})
    VALUES($1, 'Import customer', '081234567890', 'Import address', 'DANA', '[]'::jsonb, 37000, $2::timestamptz${parameters})
    RETURNING id, queue_number, queue_date::text AS queue_date, created_at`, values);
}

async function installLegacyStockFirstSchema(pool) {
  const signature = "dapoer_save_order(text,text,text,text,text,text,jsonb,bigint,text)";
  const definition = (await pool.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [signature])).rows[0].definition;
  await pool.query("DROP TRIGGER dapoer_order_queue_insert_v1 ON orders");
  await pool.query("DROP TRIGGER dapoer_order_queue_immutable_v1 ON orders");
  await pool.query("ALTER TABLE orders DROP COLUMN queue_number CASCADE, DROP COLUMN queue_date CASCADE");
  await pool.query("DROP TABLE order_queue_counters");
  const legacyDefinition = definition.replace("LOCK TABLE orders IN ROW EXCLUSIVE MODE;", "")
    .replace("INSERT INTO orders (", "PERFORM pg_advisory_xact_lock(1885433957, 999);\n          INSERT INTO orders (");
  await pool.query(legacyDefinition);
  return definition;
}

describe("real PostgreSQL daily queue allocation and migration", { skip: !databaseUrl, concurrency: false }, () => {
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
    delete require.cache[require.resolve("../api/_lib/db")];
  });

  test("24 concurrent checkouts allocate unique contiguous numbers without changing stock reservations", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock = 100");
    const purchases = Array.from({ length: 24 }, () => order());
    const results = await Promise.all(purchases.map(purchase => db.saveOrder(purchase)));
    assert.ok(results.every(result => result === true));
    const rows = (await pool.query(`SELECT id, queue_number, queue_date::text AS queue_date,
      (created_at AT TIME ZONE 'Asia/Jakarta')::date::text AS created_day FROM orders ORDER BY queue_number`)).rows;
    assert.deepEqual(rows.map(row => row.queue_number), Array.from({ length: 24 }, (_, index) => index + 1));
    assert.equal(new Set(rows.map(row => `${row.queue_date}/${row.queue_number}`)).size, 24);
    assert.ok(rows.every(row => row.queue_date === row.created_day));
    for (const purchase of purchases) {
      const row = rows.find(row => row.id === purchase.id);
      assert.equal(purchase.queueNumber, row.queue_number);
      assert.equal(purchase.queueDate, row.queue_date);
      assert.equal(purchase.queueLabel, `A${String(row.queue_number).padStart(3, "0")}`);
    }
    assert.equal(await stock(pool), 76);
    assert.equal(await counter(pool), 24);
  });

  test("insufficient stock rolls back every deduction and does not consume an order queue number", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock = 3 WHERE product_id = $1", [firstProduct.id]);
    await assert.rejects(() => db.saveOrder(order([[firstProduct, 2], [secondProduct, 1]])), /INSUFFICIENT_STOCK/);
    assert.equal(await stock(pool), 3);
    assert.equal(await stock(pool, secondProduct), 0);
    assert.equal(await counter(pool), 0);
    const purchase = order();
    await db.saveOrder(purchase);
    assert.equal(purchase.queueNumber, 1);
    assert.equal(await stock(pool), 2);
  });

  test("an INSERT failure after allocation rolls back both counter increment and inventory", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock = 10");
    const first = order();
    await db.saveOrder(first);
    await assert.rejects(() => db.saveOrder(order([[firstProduct, 2]], { id: first.id })), error => error.code === "23505");
    assert.equal(await stock(pool), 9);
    assert.equal(await counter(pool), 1);
    const next = order();
    await db.saveOrder(next);
    assert.equal(next.queueNumber, 2);
    assert.equal(await stock(pool), 8);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM orders")).rows[0].count, 2);
  });

  test("legacy boolean saves remain compatible and the atomic wrapper returns the same row metadata", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock=5");
    const first = order();
    const parameters = purchase => [purchase.id, purchase.customer.name, purchase.customer.phone,
      purchase.customer.address, purchase.customer.notes, purchase.customer.paymentMethod,
      JSON.stringify(purchase.items), purchase.total, purchase.trackingToken];
    const placeholders = "$1,$2,$3,$4,$5,$6,$7::jsonb,$8::bigint,$9";
    assert.equal((await pool.query(`SELECT dapoer_save_order(${placeholders}) AS saved`, parameters(first))).rows[0].saved, true);
    const second = order();
    const saved = (await pool.query(`SELECT dapoer_save_order_with_queue(${placeholders}) AS saved`, parameters(second))).rows[0].saved;
    const row = (await pool.query(`SELECT jsonb_build_object('queueNumber', queue_number, 'queueDate', queue_date,
      'createdAt', created_at, 'updatedAt', updated_at) AS saved FROM orders WHERE id=$1`, [second.id])).rows[0].saved;
    assert.deepEqual(saved, row);
    assert.equal(saved.queueNumber, 2);
    assert.equal(saved.queueDate, new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(saved.createdAt)));
    assert.equal(await stock(pool), 3);
    assert.equal(await counter(pool), 2);
  });

  test("repeated cancellation restores stock once while retaining its queue number", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock = 5");
    const purchase = order([[firstProduct, 2]]);
    await db.saveOrder(purchase);
    await Promise.all([db.updateOrderStatus(purchase.id, "dibatalkan"), db.updateOrderStatus(purchase.id, "dibatalkan")]);
    assert.equal(await stock(pool), 5);
    const cancelled = (await pool.query("SELECT status, queue_number, queue_date::text AS queue_date FROM orders WHERE id=$1", [purchase.id])).rows[0];
    assert.deepEqual(cancelled, { status: "dibatalkan", queue_number: purchase.queueNumber, queue_date: purchase.queueDate });
    await assert.rejects(() => db.updateOrderStatus(purchase.id, "baru"), /ORDER_CANCELLED/);
    const next = order();
    await db.saveOrder(next);
    assert.equal(next.queueNumber, 2);
    assert.equal(await counter(pool), 2);
  });

  test("assigned queue identities cannot be altered by later updates", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock = 5");
    const purchase = order();
    await db.saveOrder(purchase);
    await assert.rejects(() => pool.query("UPDATE orders SET queue_number=2 WHERE id=$1", [purchase.id]), /ORDER_QUEUE_IMMUTABLE/);
    await assert.rejects(() => pool.query("UPDATE orders SET queue_date=queue_date+1 WHERE id=$1", [purchase.id]), /ORDER_QUEUE_IMMUTABLE/);
    await db.updateOrderStatus(purchase.id, "diproses");
    assert.equal((await pool.query("SELECT queue_number FROM orders WHERE id=$1", [purchase.id])).rows[0].queue_number, 1);
    assert.equal(await counter(pool), 1);
  });

  test("allocator resets by WIB calendar day exactly at UTC 17:00 and preserves earlier-day high water", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    const cases = [
      ["2026-01-01T16:59:59.999999Z", "2026-01-01", 1],
      ["2026-01-01T17:00:00Z", "2026-01-02", 1],
      ["2026-01-02T16:59:59.999999Z", "2026-01-02", 2],
      ["2026-01-02T17:00:00Z", "2026-01-03", 1],
      ["2026-01-01T08:00:00Z", "2026-01-01", 2],
      ["2025-12-31T17:00:00Z", "2026-01-01", 3]
    ];
    for (const [timestamp, date, number] of cases) {
      const allocation = (await pool.query("SELECT dapoer_allocate_order_queue($1::timestamptz) AS allocation", [timestamp])).rows[0].allocation;
      assert.equal(allocation.date, date);
      assert.equal(allocation.number, number);
      assert.equal(new Date(allocation.createdAt).getTime(), new Date(timestamp).getTime());
    }
    assert.deepEqual((await pool.query("SELECT queue_date::text AS date, last_number FROM order_queue_counters ORDER BY queue_date")).rows,
      [{ date: "2026-01-01", last_number: 3 }, { date: "2026-01-02", last_number: 2 }, { date: "2026-01-03", last_number: 1 }]);
  });

  test("a checkout waiting for allocation samples created_at after the wait, with matching WIB queue date", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock = 5");
    const holder = await pool.connect();
    let pending;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(1885433957, 113)");
      const purchase = order();
      pending = db.saveOrder(purchase);
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND classid=1885433957 AND objid=113 AND NOT granted) AS waiting`)).rows[0].waiting;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(waiting, "Checkout must be blocked on the allocation lock before it is released");
      const release = (await holder.query("SELECT clock_timestamp() AS released_at")).rows[0].released_at;
      await holder.query("COMMIT");
      await pending;
      const row = (await pool.query(`SELECT created_at, updated_at, queue_date::text AS queue_date,
        (created_at AT TIME ZONE 'Asia/Jakarta')::date::text AS created_day FROM orders WHERE id=$1`, [purchase.id])).rows[0];
      assert.ok(row.created_at.getTime() >= release.getTime(), "created_at must be sampled after allocation lock waiting");
      assert.equal(row.updated_at.getTime(), row.created_at.getTime());
      assert.equal(row.queue_date, row.created_day);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (pending) await pending;
    }
  });

  test("historical backfill is deterministic per WIB day and preserves business data and timestamps", async () => {
    const { db, pool, sql } = await fixture();
    await legacyOrders(pool, [
      { id: "day2-z", createdAt: "2026-01-01T17:00:00Z", updatedAt: "2026-01-05T08:04:03.123456Z", status: "dibatalkan" },
      { id: "day1", createdAt: "2026-01-01T16:59:59.999999Z", status: "selesai" },
      { id: "day2-a", createdAt: "2026-01-01T17:00:00Z", status: "diproses" },
      { id: "day3", createdAt: "2026-01-02T17:00:00Z", status: "baru" }
    ]);
    const before = (await pool.query("SELECT row_to_json(orders) AS value FROM orders ORDER BY id")).rows.map(row => row.value);
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock=9");
    const rows = (await pool.query("SELECT row_to_json(orders) AS value FROM orders ORDER BY id")).rows.map(row => row.value);
    assert.deepEqual(rows.map(({ queue_number, queue_date, ...value }) => value), before);
    assert.deepEqual(rows.map(row => [row.id, row.queue_number, row.queue_date]),
      [["day1", 1, "2026-01-01"], ["day2-a", 1, "2026-01-02"], ["day2-z", 2, "2026-01-02"], ["day3", 1, "2026-01-03"]]);
    for (let attempt = 0; attempt < 3; attempt++) await loadDb(sql).ensureSchema();
    assert.deepEqual((await pool.query("SELECT row_to_json(orders) AS value FROM orders ORDER BY id")).rows.map(row => row.value), rows);
    assert.equal(await stock(pool), 9);
    assert.equal(await counter(pool), 4);
  });

  test("partial historical assignments and existing counter high water survive migration", async () => {
    const { db, pool } = await fixture();
    await legacyOrders(pool, [
      { id: "assigned", createdAt: "2026-01-02T05:00:00Z" },
      { id: "missing-b", createdAt: "2026-01-02T04:00:00Z" },
      { id: "missing-a", createdAt: "2026-01-02T04:00:00Z" }
    ]);
    await pool.query("ALTER TABLE orders ADD COLUMN queue_number INTEGER, ADD COLUMN queue_date DATE");
    await pool.query("UPDATE orders SET queue_number=50 WHERE id='assigned'");
    await pool.query("CREATE TABLE order_queue_counters(queue_date DATE PRIMARY KEY, last_number INTEGER NOT NULL CHECK(last_number>0))");
    await pool.query("INSERT INTO order_queue_counters VALUES('2026-01-02', 100)");
    await db.ensureSchema();
    assert.deepEqual((await pool.query("SELECT id, queue_number, queue_date::text AS queue_date FROM orders ORDER BY id")).rows,
      [{ id: "assigned", queue_number: 50, queue_date: "2026-01-02" }, { id: "missing-a", queue_number: 101, queue_date: "2026-01-02" }, { id: "missing-b", queue_number: 102, queue_date: "2026-01-02" }]);
    assert.equal(await counter(pool), 102);
    const imported = (await insertHistorical(pool, "import-after-migration", "2026-01-02T07:00:00Z")).rows[0];
    assert.equal(imported.queue_number, 103);
    assert.equal(imported.queue_date, "2026-01-02");
  });

  test("explicit historical imports reserve their queue number while rejecting invalid or duplicate identities", async () => {
    const { db, pool } = await fixture();
    await db.ensureSchema();
    const createdAt = "2026-01-02T03:04:05.123456Z";
    const assigned = (await insertHistorical(pool, "import-assigned", createdAt, 99, "2026-01-02")).rows[0];
    assert.equal(assigned.created_at.toISOString(), "2026-01-02T03:04:05.123Z");
    assert.equal(await counter(pool), 99);
    await assert.rejects(() => insertHistorical(pool, "import-invalid", createdAt, 100, "2026-01-03"), /INVALID_ORDER_QUEUE/);
    await assert.rejects(() => insertHistorical(pool, "import-duplicate", createdAt, 99, "2026-01-02"), error => error.code === "23505");
    const next = (await insertHistorical(pool, "import-next", createdAt)).rows[0];
    assert.equal(next.queue_number, 100);
    assert.equal(await counter(pool), 100);
  });

  test("concurrent migration statements commit exactly one complete schema and deterministic backfill", async () => {
    const { pool, sql } = await fixture();
    await legacyOrders(pool, Array.from({ length: 20 }, (_, index) => ({ id: `legacy-${String(index).padStart(2, "0")}`, createdAt: "2026-01-02T05:00:00Z" })));
    await Promise.all(Array.from({ length: 8 }, () => ensureOrderQueueSchema(sql)));
    assert.deepEqual((await pool.query("SELECT queue_number FROM orders ORDER BY id")).rows.map(row => row.queue_number), Array.from({ length: 20 }, (_, index) => index + 1));
    assert.equal(await counter(pool), 20);
    const triggers = (await pool.query("SELECT tgname FROM pg_trigger WHERE tgrelid='orders'::regclass AND NOT tgisinternal ORDER BY tgname")).rows.map(row => row.tgname);
    assert.deepEqual(triggers, ["dapoer_order_queue_immutable_v1", "dapoer_order_queue_insert_v1"]);
    const imported = (await insertHistorical(pool, "after-concurrent-migration", "2026-01-02T06:00:00Z")).rows[0];
    assert.equal(imported.queue_number, 21);
  });

  test("cold schema checks alongside checkouts and cancellation preserve queues, stock and status", async () => {
    const { db, pool, sql } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock=100");
    const existing = order([[firstProduct, 2]]);
    await db.saveOrder(existing);
    const purchases = Array.from({ length: 12 }, () => order());
    await Promise.all([
      ...Array.from({ length: 6 }, () => loadDb(sql).ensureSchema()),
      ...purchases.map(purchase => db.saveOrder(purchase)),
      db.updateOrderStatus(existing.id, "dibatalkan")
    ]);
    assert.equal(await stock(pool), 88);
    const rows = (await pool.query("SELECT id, status, queue_number FROM orders ORDER BY queue_number")).rows;
    assert.deepEqual(rows.map(row => row.queue_number), Array.from({ length: 13 }, (_, index) => index + 1));
    assert.equal(rows.find(row => row.id === existing.id).status, "dibatalkan");
    assert.equal(await counter(pool), 13);
  });

  test("an in-flight legacy stock-first save remains valid during migration and concurrent new save plus cancellation", async () => {
    const { db, pool, sql } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock=5");
    const previous = order();
    await db.saveOrder(previous);
    // Recreate a pre-queue schema and the former stock-before-orders function.
    // The second advisory lock is only a test gate after inventory deduction,
    // making the deployment overlap deterministic without modifying app code.
    const definition = await installLegacyStockFirstSchema(pool);
    const holder = await pool.connect();
    let legacyPending, newPending, cancelPending;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(1885433957, 999)");
      const legacy = order([[firstProduct, 2]]);
      legacyPending = pool.query("SELECT dapoer_save_order($1,$2,$3,$4,$5,$6,$7::jsonb,$8::bigint,$9) AS saved",
        [legacy.id, legacy.customer.name, legacy.customer.phone, legacy.customer.address, legacy.customer.notes,
          legacy.customer.paymentMethod, JSON.stringify(legacy.items), legacy.total, legacy.trackingToken]);
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND classid=1885433957 AND objid=999 AND NOT granted) AS waiting`)).rows[0].waiting;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(waiting, "Legacy save must already hold inventory before migration begins");
      await ensureOrderQueueSchema(sql);
      await pool.query(definition);
      const next = order();
      newPending = db.saveOrder(next);
      cancelPending = db.updateOrderStatus(previous.id, "dibatalkan");
      await holder.query("COMMIT");
      assert.equal((await legacyPending).rows[0].saved, true);
      await Promise.all([newPending, cancelPending]);
      const rows = (await pool.query("SELECT id, status, queue_number FROM orders ORDER BY queue_number")).rows;
      assert.deepEqual(rows.map(row => row.queue_number), [1, 2, 3]);
      assert.equal(rows.find(row => row.id === previous.id).status, "dibatalkan");
      assert.equal(rows.find(row => row.id === legacy.id).queue_number, 2);
      assert.equal(next.queueNumber, 3);
      assert.equal(await stock(pool), 2);
      assert.equal(await counter(pool), 3);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled([legacyPending, newPending, cancelPending].filter(Boolean));
    }
  });

  test("migration overlapping a cancellation waiting on legacy stock cannot abort either customer operation", async () => {
    const { db, pool, sql } = await fixture();
    await db.ensureSchema();
    await pool.query("UPDATE inventory SET stock=5");
    const previous = order();
    await db.saveOrder(previous);
    await installLegacyStockFirstSchema(pool);
    const holder = await pool.connect();
    let legacyPending, cancelPending, migrationPending;
    const failures = [];
    const observe = async (...args) => {
      try { return await sql(...args); }
      catch (error) { failures.push(error.code); throw error; }
    };
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(1885433957, 999)");
      const legacy = order([[firstProduct, 2]]);
      legacyPending = pool.query("SELECT dapoer_save_order($1,$2,$3,$4,$5,$6,$7::jsonb,$8::bigint,$9) AS saved",
        [legacy.id, legacy.customer.name, legacy.customer.phone, legacy.customer.address, legacy.customer.notes,
          legacy.customer.paymentMethod, JSON.stringify(legacy.items), legacy.total, legacy.trackingToken]);
      legacyPending.catch(() => {});
      const waitFor = async query => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          if ((await pool.query(query)).rows[0].waiting) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail("Expected database operation to be blocked before releasing the test gate");
      };
      await waitFor(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
        AND classid=1885433957 AND objid=999 AND NOT granted) AS waiting`);
      cancelPending = db.updateOrderStatus(previous.id, "dibatalkan");
      cancelPending.catch(() => {});
      await waitFor(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE '%dapoer_update_order_status%') AS waiting`);
      migrationPending = ensureOrderQueueSchema(observe);
      migrationPending.catch(() => {});
      const deadline = Date.now() + 3000;
      let migrationBlocked = false;
      while (Date.now() < deadline && failures.length === 0) {
        migrationBlocked = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='relation'
          AND relation='orders'::regclass AND NOT granted) AS waiting`)).rows[0].waiting;
        if (migrationBlocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(migrationBlocked || failures.includes("55P03"), "Migration must overlap the held cancellation relation lock");
      await holder.query("COMMIT");
      const results = await Promise.allSettled([legacyPending, cancelPending, migrationPending]);
      assert.ok(results.every(result => result.status === "fulfilled"),
        `Customer operations and migration must all complete: ${results.map(result => result.status === "fulfilled" ? "ok" : `${result.reason.code}: ${result.reason.message}`).join(", ")}`);
      assert.ok(failures.includes("55P03"), "Migration must retry its NOWAIT lock failure instead of blocking customer operations");
      assert.equal((await pool.query("SELECT status FROM orders WHERE id=$1", [previous.id])).rows[0].status, "dibatalkan");
      assert.equal(await stock(pool), 3);
      assert.deepEqual((await pool.query("SELECT queue_number FROM orders ORDER BY created_at,id")).rows.map(row => row.queue_number), [1, 2]);
      assert.equal(await counter(pool), 2);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled([legacyPending, cancelPending, migrationPending].filter(Boolean));
    }
  });
});
