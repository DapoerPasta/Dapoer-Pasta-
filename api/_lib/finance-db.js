const { ensureSchema } = require("./db");
const {
  FINANCE_TIME_ZONE, EXPENSE_CATEGORIES, createFinanceOptions,
  validateExpenseCreate, validateExpenseUpdate, validateExpenseDelete
} = require("./finance");

let expenseSchemaPromise;
let expenseSchemaDatabaseUrl;

function financeError(code) {
  return Object.assign(new Error(code), { code });
}

async function ensureFinanceSchema() {
  const sql = await ensureSchema();
  if (!sql) throw financeError("DATABASE_NOT_CONFIGURED");
  if (expenseSchemaDatabaseUrl !== process.env.DATABASE_URL) {
    expenseSchemaPromise = undefined;
    expenseSchemaDatabaseUrl = process.env.DATABASE_URL;
  }
  if (!expenseSchemaPromise) {
    expenseSchemaPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS finance_expenses (
          id UUID PRIMARY KEY,
          expense_date DATE NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('bahan_baku', 'kemasan', 'operasional', 'transportasi', 'pemasaran', 'lainnya')),
          description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
          amount BIGINT NOT NULL CHECK (amount BETWEEN 1 AND 1000000000000),
          created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          deleted_at TIMESTAMPTZ,
          original_payload JSONB NOT NULL
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS finance_expenses_date_id_idx ON finance_expenses(expense_date DESC, id DESC) WHERE deleted_at IS NULL`;
    })().catch(error => {
      expenseSchemaPromise = undefined;
      throw error;
    });
  }
  await expenseSchemaPromise;
  return sql;
}

function checkedNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw financeError("FINANCE_TOTAL_TOO_LARGE");
  return number;
}

const SUMMARY_FIELDS = [
  "completedSales", "completedCount", "orderValue", "orderCount", "pendingValue", "pendingCount",
  "cancelledValue", "cancelledCount", "totalOrders", "expenseTotal", "expenseCount", "recordedBalance"
];

function summaryNumbers(summary) {
  return Object.fromEntries(SUMMARY_FIELDS.map(field => [field, checkedNumber(summary[field])]));
}

function periodMetadata(options) {
  return {
    type: options.period, date: options.date, startDate: options.startDate,
    endDate: options.endDate, timeZone: FINANCE_TIME_ZONE
  };
}

function compare(current, previous) {
  return Object.fromEntries(["completedSales", "expenseTotal", "recordedBalance"].map(key => [key, {
    difference: checkedNumber(current[key] - previous[key]),
    percent: previous[key] === 0 ? null : Math.round((current[key] - previous[key]) / Math.abs(previous[key]) * 1000) / 10
  }]));
}

async function getFinanceReport(input = {}) {
  // Validate direct calls too, before initializing or querying the database.
  const options = createFinanceOptions(input);
  const sql = await ensureFinanceSchema();
  const previous = options.previous;
  const step = options.bucketUnit === "month" ? "1 month" : "1 day";
  // One statement gives every total, chart, comparison and expense page the
  // same snapshot. Aggregates include the entire period, never just a page.
  const rows = await sql`
    WITH ranges(name, start_at, end_at, start_date, end_date) AS (
      VALUES ('current', ${options.start}::timestamptz, ${options.end}::timestamptz, ${options.startDate}::date, ${options.endExclusiveDate}::date),
             ('previous', ${previous.start}::timestamptz, ${previous.end}::timestamptz, ${previous.startDate}::date, ${previous.endExclusiveDate}::date)
    ), period_orders AS (
      SELECT ranges.name AS range_name, orders.* FROM ranges JOIN orders
        ON orders.created_at >= ranges.start_at AND orders.created_at < ranges.end_at
    ), period_expenses AS (
      SELECT ranges.name AS range_name, finance_expenses.* FROM ranges JOIN finance_expenses
        ON finance_expenses.expense_date >= ranges.start_date AND finance_expenses.expense_date < ranges.end_date
       AND finance_expenses.deleted_at IS NULL
    ), order_totals AS (
      SELECT ranges.name,
        COALESCE(SUM(total) FILTER (WHERE status = 'selesai'), 0) AS completed_sales,
        COUNT(id) FILTER (WHERE status = 'selesai') AS completed_count,
        COALESCE(SUM(total) FILTER (WHERE status <> 'dibatalkan'), 0) AS order_value,
        COUNT(id) FILTER (WHERE status <> 'dibatalkan') AS order_count,
        COALESCE(SUM(total) FILTER (WHERE status NOT IN ('selesai', 'dibatalkan')), 0) AS pending_value,
        COUNT(id) FILTER (WHERE status NOT IN ('selesai', 'dibatalkan')) AS pending_count,
        COALESCE(SUM(total) FILTER (WHERE status = 'dibatalkan'), 0) AS cancelled_value,
        COUNT(id) FILTER (WHERE status = 'dibatalkan') AS cancelled_count,
        COUNT(id) AS total_orders
      FROM ranges LEFT JOIN period_orders ON period_orders.range_name = ranges.name GROUP BY ranges.name
    ), expense_totals AS (
      SELECT ranges.name, COALESCE(SUM(amount), 0) AS expense_total, COUNT(id) AS expense_count
      FROM ranges LEFT JOIN period_expenses ON period_expenses.range_name = ranges.name GROUP BY ranges.name
    ), summaries AS (
      SELECT order_totals.name, jsonb_build_object(
        'completedSales', completed_sales, 'completedCount', completed_count,
        'orderValue', order_value, 'orderCount', order_count,
        'pendingValue', pending_value, 'pendingCount', pending_count,
        'cancelledValue', cancelled_value, 'cancelledCount', cancelled_count,
        'totalOrders', total_orders, 'expenseTotal', expense_total, 'expenseCount', expense_count,
        'recordedBalance', completed_sales - expense_total
      ) AS summary FROM order_totals JOIN expense_totals USING (name)
    ), order_buckets AS (
      SELECT date_trunc(${options.bucketUnit}, created_at AT TIME ZONE 'Asia/Jakarta')::date AS date,
        COALESCE(SUM(total) FILTER (WHERE status = 'selesai'), 0) AS completed_sales,
        COUNT(*) FILTER (WHERE status = 'selesai') AS completed_count,
        COALESCE(SUM(total) FILTER (WHERE status <> 'dibatalkan'), 0) AS order_value,
        COUNT(*) FILTER (WHERE status <> 'dibatalkan') AS order_count,
        COALESCE(SUM(total) FILTER (WHERE status NOT IN ('selesai', 'dibatalkan')), 0) AS pending_value,
        COUNT(*) FILTER (WHERE status NOT IN ('selesai', 'dibatalkan')) AS pending_count,
        COALESCE(SUM(total) FILTER (WHERE status = 'dibatalkan'), 0) AS cancelled_value,
        COUNT(*) FILTER (WHERE status = 'dibatalkan') AS cancelled_count,
        COUNT(*) AS total_orders
      FROM period_orders WHERE range_name = 'current' GROUP BY 1
    ), expense_buckets AS (
      SELECT date_trunc(${options.bucketUnit}, expense_date::timestamp)::date AS date,
        SUM(amount) AS expense_total, COUNT(*) AS expense_count
      FROM period_expenses WHERE range_name = 'current' GROUP BY 1
    ), bucket_dates AS (
      SELECT generate_series(${options.startDate}::date::timestamp, ${options.endDate}::date::timestamp, ${step}::interval)::date AS date
    ), buckets AS (
      SELECT dates.date, jsonb_build_object(
        'date', to_char(dates.date, 'YYYY-MM-DD'),
        'completedSales', COALESCE(completed_sales, 0), 'completedCount', COALESCE(completed_count, 0),
        'orderValue', COALESCE(order_value, 0), 'orderCount', COALESCE(order_count, 0),
        'pendingValue', COALESCE(pending_value, 0), 'pendingCount', COALESCE(pending_count, 0),
        'cancelledValue', COALESCE(cancelled_value, 0), 'cancelledCount', COALESCE(cancelled_count, 0),
        'totalOrders', COALESCE(total_orders, 0), 'expenseTotal', COALESCE(expense_total, 0),
        'expenseCount', COALESCE(expense_count, 0),
        'recordedBalance', COALESCE(completed_sales, 0) - COALESCE(expense_total, 0)
      ) AS bucket FROM bucket_dates dates LEFT JOIN order_buckets USING (date) LEFT JOIN expense_buckets USING (date)
    ), payment_totals AS (
      SELECT payment_method AS "paymentMethod",
        COALESCE(SUM(total) FILTER (WHERE status = 'selesai'), 0) AS "completedSales",
        COUNT(*) FILTER (WHERE status = 'selesai') AS "completedCount",
        COALESCE(SUM(total) FILTER (WHERE status <> 'dibatalkan'), 0) AS "orderValue",
        COUNT(*) FILTER (WHERE status <> 'dibatalkan') AS "orderCount"
      FROM period_orders WHERE range_name = 'current' AND status <> 'dibatalkan' GROUP BY payment_method
    ), category_totals AS (
      SELECT category, SUM(amount) AS total, COUNT(*) AS count FROM period_expenses
      WHERE range_name = 'current' GROUP BY category
    ), expense_page AS (
      SELECT id, expense_date, jsonb_build_object(
        'id', id, 'date', to_char(expense_date, 'YYYY-MM-DD'), 'category', category,
        'description', description, 'amount', amount,
        'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) AS expense FROM period_expenses WHERE range_name = 'current'
      ORDER BY expense_date DESC, id DESC LIMIT ${options.expensePageSize} OFFSET ${options.expenseOffset}
    )
    SELECT (SELECT summary FROM summaries WHERE name = 'current') AS summary,
      (SELECT summary FROM summaries WHERE name = 'previous') AS previous_summary,
      (SELECT COALESCE(jsonb_agg(bucket ORDER BY date), '[]'::jsonb) FROM buckets) AS buckets,
      (SELECT COALESCE(jsonb_agg(payment_totals ORDER BY "paymentMethod"), '[]'::jsonb) FROM payment_totals) AS payment_methods,
      (SELECT COALESCE(jsonb_agg(category_totals ORDER BY category), '[]'::jsonb) FROM category_totals) AS expense_categories,
      (SELECT COALESCE(jsonb_agg(expense ORDER BY expense_date DESC, id DESC), '[]'::jsonb) FROM expense_page) AS expenses
  `;
  const result = rows[0];
  const summary = summaryNumbers(result.summary);
  const previousSummary = summaryNumbers(result.previous_summary);
  const totalPages = Math.ceil(summary.expenseCount / options.expensePageSize);
  return {
    period: periodMetadata(options), previousPeriod: periodMetadata(previous),
    summary, previousSummary, comparison: compare(summary, previousSummary),
    buckets: result.buckets.map(bucket => ({ date: bucket.date, ...summaryNumbers(bucket) })),
    paymentMethods: result.payment_methods.map(payment => ({
      paymentMethod: payment.paymentMethod,
      ...Object.fromEntries(["completedSales", "completedCount", "orderValue", "orderCount"].map(key => [key, checkedNumber(payment[key])]))
    })),
    expenseCategories: result.expense_categories.map(category => ({ category: category.category, total: checkedNumber(category.total), count: checkedNumber(category.count) })),
    expenses: result.expenses.map(expense => ({ ...expense, amount: checkedNumber(expense.amount) })),
    expensePagination: { page: options.expensePage, pageSize: options.expensePageSize, total: summary.expenseCount, totalPages, hasMore: options.expensePage < totalPages },
    categories: EXPENSE_CATEGORIES,
    basis: {
      income: "Penjualan selesai dihitung dari pesanan berstatus selesai; status ini bukan verifikasi pembayaran lunas.",
      balance: "Saldo tercatat = penjualan selesai dikurangi pengeluaran yang dicatat. Angka ini bukan laba bersih atau saldo rekening.",
      time: "Pesanan dikelompokkan berdasarkan tanggal dibuat dalam WIB; pengeluaran berdasarkan tanggal yang dicatat."
    }
  };
}

function expenseFromRow(row) {
  return {
    id: row.id, date: row.date, category: row.category, description: row.description,
    amount: checkedNumber(row.amount), createdAt: row.created_at, updatedAt: row.updated_at
  };
}

async function createExpense(input) {
  const expense = validateExpenseCreate(input);
  const sql = await ensureFinanceSchema();
  // The original payload is retained across edits and soft deletion. Retrying
  // a timed-out create must not insert twice, undo an edit, or resurrect a row.
  const rows = await sql`
    INSERT INTO finance_expenses(id, expense_date, category, description, amount, original_payload)
    VALUES (${expense.id}::uuid, ${expense.date}::date, ${expense.category}, ${expense.description}, ${expense.amount}, ${JSON.stringify(expense)}::jsonb)
    ON CONFLICT (id) DO NOTHING
    RETURNING id, to_char(expense_date, 'YYYY-MM-DD') AS date, category, description, amount,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
  `;
  if (rows[0]) return { expense: expenseFromRow(rows[0]), created: true };
  const existing = await sql`
    SELECT id, to_char(expense_date, 'YYYY-MM-DD') AS date, category, description, amount,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
      deleted_at IS NOT NULL AS deleted, original_payload = ${JSON.stringify(expense)}::jsonb AS same_request
    FROM finance_expenses WHERE id = ${expense.id}::uuid
  `;
  if (!existing[0] || existing[0].deleted || !existing[0].same_request) throw financeError("EXPENSE_CONFLICT");
  return { expense: expenseFromRow(existing[0]), created: false };
}

async function updateExpense(input) {
  const expense = validateExpenseUpdate(input);
  const sql = await ensureFinanceSchema();
  const rows = await sql`
    UPDATE finance_expenses SET expense_date = ${expense.date}::date, category = ${expense.category},
      description = ${expense.description}, amount = ${expense.amount},
      updated_at = GREATEST(clock_timestamp(), updated_at + INTERVAL '1 microsecond')
    WHERE id = ${expense.id}::uuid AND updated_at = ${expense.expectedUpdatedAt}::timestamptz AND deleted_at IS NULL
    RETURNING id, to_char(expense_date, 'YYYY-MM-DD') AS date, category, description, amount,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
  `;
  if (!rows[0]) await throwExpenseMissingOrConflict(sql, expense.id);
  return { expense: expenseFromRow(rows[0]) };
}

async function throwExpenseMissingOrConflict(sql, id) {
  const rows = await sql`SELECT id FROM finance_expenses WHERE id = ${id}::uuid AND deleted_at IS NULL`;
  throw financeError(rows[0] ? "EXPENSE_CONFLICT" : "EXPENSE_NOT_FOUND");
}

async function deleteExpense(input) {
  const expense = validateExpenseDelete(input);
  const sql = await ensureFinanceSchema();
  const rows = await sql`
    UPDATE finance_expenses SET deleted_at = clock_timestamp(),
      updated_at = GREATEST(clock_timestamp(), updated_at + INTERVAL '1 microsecond')
    WHERE id = ${expense.id}::uuid AND updated_at = ${expense.expectedUpdatedAt}::timestamptz AND deleted_at IS NULL
    RETURNING id
  `;
  if (!rows[0]) await throwExpenseMissingOrConflict(sql, expense.id);
  return { deleted: true, id: rows[0].id };
}

module.exports = { ensureFinanceSchema, getFinanceReport, createExpense, updateExpense, deleteExpense };
