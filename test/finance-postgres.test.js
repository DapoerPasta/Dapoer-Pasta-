// Optional real database suite. Only a dedicated LOCAL scratch database is
// accepted. Dependencies and cluster files may live outside the checkout:
// STOCK_TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55432/dapoer_stock_test \
// STOCK_TEST_PG_MODULE=/workspace/.dapoer-postgres/node_modules/pg \
// NODE_PATH=/workspace/.dapoer-cloud/node_modules node --test test/finance-postgres.test.js
const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");

const databaseUrl = process.env.STOCK_TEST_DATABASE_URL;
const schema = `finance_integration_${process.pid}`;
const previousDatabaseUrl = process.env.DATABASE_URL;
let adminPool, pool, finance;
let orderSequence = 0;

function newExpense(overrides = {}) {
  return { id: crypto.randomUUID(), date: "2026-01-02", category: "bahan_baku", description: "Bahan pasta", amount: 12000, ...overrides };
}

function requireThroughPostgres(sql) {
  const dbPath = require.resolve("../api/_lib/db");
  const financePath = require.resolve("../api/_lib/finance-db");
  delete require.cache[dbPath];
  delete require.cache[financePath];
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === dbPath && name === "@neondatabase/serverless") return { neon: () => sql };
    return originalLoad.call(this, name, parent, isMain);
  };
  try { return require(financePath); }
  finally { Module._load = originalLoad; }
}

async function addOrder({ total = 37000, status = "selesai", payment = "DANA", createdAt = "2026-01-02T05:00:00Z" } = {}) {
  await pool.query(`INSERT INTO orders(id, customer_name, customer_phone, address, payment_method, items, total, status, created_at)
    VALUES ($1, 'Test customer', '081234567890', 'Test address', $2, '[]'::jsonb, $3, $4, $5::timestamptz)`,
  [`finance-order-${++orderSequence}`, payment, total, status, createdAt]);
}

function report(overrides = {}) {
  return finance.getFinanceReport({ period: "monthly", date: "2026-01-02", ...overrides });
}

describe("real PostgreSQL financial reports and expense concurrency", { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    const url = new URL(databaseUrl);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only a local scratch database is allowed");
    assert.match(url.pathname, /^\/dapoer_stock_test(?:_[a-z0-9_]+)?$/, "Use a dedicated dapoer_stock_test database");
    const { Pool } = require(process.env.STOCK_TEST_PG_MODULE || "pg");
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, max: 8,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=8000` });
    const sql = async (parts, ...values) => {
      const text = typeof parts === "string" ? parts : parts.reduce((result, part, index) => result + (index ? `$${index}` : "") + part, "");
      return (await pool.query(text, values)).rows;
    };
    sql.query = async (text, values = []) => (await pool.query(text, values)).rows;
    process.env.DATABASE_URL = databaseUrl;
    finance = requireThroughPostgres(sql);
    await finance.ensureFinanceSchema();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE orders, finance_expenses");
  });

  after(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    delete require.cache[require.resolve("../api/_lib/db")];
    delete require.cache[require.resolve("../api/_lib/finance-db")];
  });

  test("empty reports include all calendar buckets, zero totals and adjacent previous periods", async () => {
    for (const [period, bucketCount] of [["daily", 1], ["weekly", 7], ["monthly", 31], ["yearly", 12]]) {
      const result = await report({ period });
      assert.equal(result.buckets.length, bucketCount);
      assert.ok(Object.values(result.summary).every(value => value === 0));
      assert.ok(Object.values(result.previousSummary).every(value => value === 0));
      assert.equal(result.comparison.completedSales.percent, null);
      assert.deepEqual(result.expenses, []);
      assert.equal(result.expensePagination.total, 0);
      assert.equal(result.period.timeZone, "Asia/Jakarta");
    }
    const result = await report({ period: "weekly", date: "2026-01-01" });
    assert.equal(result.period.startDate, "2025-12-29");
    assert.equal(result.period.endDate, "2026-01-04");
    assert.equal(result.previousPeriod.endDate, "2025-12-28");
  });

  test("WIB midnight boundaries and statuses distinguish completed sales, pending value and cancellations", async () => {
    await addOrder({ total: 1000, createdAt: "2026-01-01T16:59:59.999999Z" });
    await addOrder({ total: 37000, createdAt: "2026-01-01T17:00:00Z", payment: "DANA" });
    await addOrder({ total: 32000, status: "baru", createdAt: "2026-01-02T16:59:59.999999Z", payment: "OVO" });
    await addOrder({ total: 27000, status: "diproses", createdAt: "2026-01-02T08:00:00Z", payment: "OVO" });
    await addOrder({ total: 15000, status: "dibatalkan", createdAt: "2026-01-02T03:00:00Z" });
    await addOrder({ total: 999000, createdAt: "2026-01-02T17:00:00Z" });
    await finance.createExpense(newExpense());
    const result = await report({ period: "daily" });
    assert.deepEqual(result.summary, {
      completedSales: 37000, completedCount: 1, orderValue: 96000, orderCount: 3,
      pendingValue: 59000, pendingCount: 2, cancelledValue: 15000, cancelledCount: 1,
      totalOrders: 4, expenseTotal: 12000, expenseCount: 1, recordedBalance: 25000
    });
    assert.equal(result.previousSummary.completedSales, 1000);
    assert.deepEqual(result.comparison.completedSales, { difference: 36000, percent: 3600 });
    assert.deepEqual(result.paymentMethods, [
      { paymentMethod: "DANA", completedSales: 37000, completedCount: 1, orderValue: 37000, orderCount: 1 },
      { paymentMethod: "OVO", completedSales: 0, completedCount: 0, orderValue: 59000, orderCount: 2 }
    ]);
    assert.equal(result.buckets[0].completedSales, result.summary.completedSales);
    assert.match(result.basis.income, /bukan verifikasi pembayaran/);
  });

  test("reports aggregate every order beyond admin order pagination and every expense beyond its page", async () => {
    await pool.query(`INSERT INTO orders(id, customer_name, customer_phone, address, payment_method, items, total, status, created_at)
      SELECT 'bulk-finance-' || value, 'Test', '081234567890', 'Test', 'DANA', '[]'::jsonb, 100, 'selesai', '2026-01-02T05:00:00Z'::timestamptz
      FROM generate_series(1, 225) AS value`);
    for (let index = 0; index < 11; index++) await finance.createExpense(newExpense({ amount: 100 + index }));
    const result = await report({ expensePage: 2, expensePageSize: 10 });
    assert.equal(result.summary.completedCount, 225);
    assert.equal(result.summary.completedSales, 22500);
    assert.equal(result.summary.expenseCount, 11);
    assert.equal(result.summary.expenseTotal, 1155);
    assert.equal(result.expenses.length, 1);
    assert.deepEqual(result.expensePagination, { page: 2, pageSize: 10, total: 11, totalPages: 2, hasMore: false });
    assert.deepEqual(result.expenseCategories, [{ category: "bahan_baku", total: 1155, count: 11 }]);
    const emptyPage = await report({ expensePage: 50, expensePageSize: 10 });
    assert.deepEqual(emptyPage.expenses, []);
    assert.deepEqual(emptyPage.summary, result.summary);
  });

  test("yearly reports use monthly WIB buckets and exact calendar comparison", async () => {
    await addOrder({ total: 30000, createdAt: "2025-12-31T16:59:59.999999Z" });
    await addOrder({ total: 37000, createdAt: "2025-12-31T17:00:00Z" });
    await addOrder({ total: 27000, createdAt: "2026-01-31T17:00:00Z" });
    await finance.createExpense(newExpense({ date: "2026-02-01", category: "kemasan", amount: 7000 }));
    const result = await report({ period: "yearly" });
    assert.equal(result.summary.completedSales, 64000);
    assert.equal(result.previousSummary.completedSales, 30000);
    assert.equal(result.buckets[0].date, "2026-01-01");
    assert.equal(result.buckets[0].completedSales, 37000);
    assert.equal(result.buckets[1].date, "2026-02-01");
    assert.equal(result.buckets[1].completedSales, 27000);
    assert.equal(result.buckets[1].expenseTotal, 7000);
    assert.equal(result.buckets[1].recordedBalance, 20000);
    assert.ok(result.buckets.slice(2).every(bucket => bucket.totalOrders === 0 && bucket.expenseTotal === 0));
  });

  test("simultaneous identical creates insert one expense and reject UUID reuse with a changed payload", async () => {
    const input = newExpense();
    const results = await Promise.all([finance.createExpense(input), finance.createExpense(input)]);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(results[0].expense.id, results[1].expense.id);
    assert.match(results[0].expense.updatedAt, /\.\d{6}Z$/);
    assert.equal((await report()).summary.expenseCount, 1);
    await assert.rejects(() => finance.createExpense({ ...input, amount: input.amount + 1 }), error => error.code === "EXPENSE_CONFLICT");
    assert.equal((await report()).summary.expenseTotal, input.amount);
  });

  test("a timed-out create retry preserves later edits and cannot resurrect a soft-deleted expense", async () => {
    const input = newExpense();
    const created = await finance.createExpense(input);
    const edited = await finance.updateExpense({ ...input, amount: 5000, expectedUpdatedAt: created.expense.updatedAt });
    const retry = await finance.createExpense(input);
    assert.equal(retry.created, false);
    assert.equal(retry.expense.amount, 5000);
    assert.equal(retry.expense.updatedAt, edited.expense.updatedAt);
    await finance.deleteExpense({ id: input.id, expectedUpdatedAt: edited.expense.updatedAt });
    await assert.rejects(() => finance.createExpense(input), error => error.code === "EXPENSE_CONFLICT");
    const result = await report();
    assert.equal(result.summary.expenseTotal, 0);
    assert.equal(result.summary.expenseCount, 0);
    assert.deepEqual(result.expenses, []);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM finance_expenses WHERE deleted_at IS NOT NULL")).rows[0].count, 1);
  });

  test("two editors using one microsecond version cannot overwrite each other's amount", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const input = newExpense();
      const created = await finance.createExpense(input);
      const results = await Promise.allSettled([
        finance.updateExpense({ ...input, amount: 15000, expectedUpdatedAt: created.expense.updatedAt }),
        finance.updateExpense({ ...input, amount: 18000, expectedUpdatedAt: created.expense.updatedAt })
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.find(result => result.status === "rejected").reason.code, "EXPENSE_CONFLICT");
      const winner = results.find(result => result.status === "fulfilled").value.expense;
      assert.notEqual(winner.updatedAt, created.expense.updatedAt);
      assert.equal((await pool.query("SELECT amount FROM finance_expenses WHERE id = $1", [input.id])).rows[0].amount, String(winner.amount));
    }
  });

  test("edit racing deletion preserves the successful edit or soft deletion and rejects stale mutations", async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const input = newExpense();
      const created = await finance.createExpense(input);
      const results = await Promise.allSettled([
        finance.updateExpense({ ...input, amount: 15000, expectedUpdatedAt: created.expense.updatedAt }),
        finance.deleteExpense({ id: input.id, expectedUpdatedAt: created.expense.updatedAt })
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const failure = results.find(result => result.status === "rejected");
      assert.ok(["EXPENSE_CONFLICT", "EXPENSE_NOT_FOUND"].includes(failure.reason.code));
      const row = (await pool.query("SELECT amount, deleted_at IS NOT NULL AS deleted FROM finance_expenses WHERE id = $1", [input.id])).rows[0];
      if (results[0].status === "fulfilled") {
        assert.equal(row.deleted, false);
        assert.equal(row.amount, "15000");
      } else assert.equal(row.deleted, true);
    }
  });

  test("missing rows and stale versions fail without changing totals", async () => {
    const input = newExpense();
    const created = await finance.createExpense(input);
    const stale = "2026-01-02T03:04:05.123456Z";
    await assert.rejects(() => finance.updateExpense({ ...input, amount: 1, expectedUpdatedAt: stale }), error => error.code === "EXPENSE_CONFLICT");
    await assert.rejects(() => finance.deleteExpense({ id: input.id, expectedUpdatedAt: stale }), error => error.code === "EXPENSE_CONFLICT");
    await assert.rejects(() => finance.deleteExpense({ id: crypto.randomUUID(), expectedUpdatedAt: created.expense.updatedAt }), error => error.code === "EXPENSE_NOT_FOUND");
    assert.equal((await report()).summary.expenseTotal, input.amount);
  });
});
