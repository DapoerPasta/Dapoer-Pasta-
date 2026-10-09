const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FinanceValidationError, FINANCE_TIME_ZONE, EXPENSE_CATEGORIES, MAX_EXPENSE_AMOUNT,
  createFinanceOptions, parseFinanceQuery, createFinanceBuckets,
  validateExpenseCreate, validateExpenseUpdate, validateExpenseDelete
} = require("../api/_lib/finance");

const NOW = Date.parse("2026-10-09T08:00:00Z");
const ID = "8912c341-b153-41a6-b09e-2da1b709c9cf";
const VERSION = "2026-10-09T01:02:03.123456Z";
const expense = { id: ID, date: "2026-10-09", category: "bahan_baku", description: "Tepung pasta", amount: 150000 };

function invalid(fn) {
  assert.throws(fn, error => error instanceof FinanceValidationError && error.code === "INVALID_FINANCE_INPUT");
}

test("default report changes day at midnight WIB and uses Jakarta calendar month boundaries", () => {
  assert.equal(FINANCE_TIME_ZONE, "Asia/Jakarta");
  const before = createFinanceOptions({}, Date.parse("2026-09-30T16:59:59.999Z"));
  const after = createFinanceOptions({}, Date.parse("2026-09-30T17:00:00.000Z"));
  assert.equal(before.date, "2026-09-30");
  assert.equal(after.date, "2026-10-01");
  assert.equal(after.period, "monthly");
  assert.equal(after.startDate, "2026-10-01");
  assert.equal(after.endDate, "2026-10-31");
  assert.equal(after.endExclusiveDate, "2026-11-01");
  assert.equal(after.start, "2026-09-30T17:00:00.000Z");
  assert.equal(after.end, "2026-10-31T17:00:00.000Z");
  assert.equal(after.expensePage, 1);
  assert.equal(after.expensePageSize, 10);
  assert.equal(after.expenseOffset, 0);
});

test("daily ranges and adjacent comparisons cross calendar years correctly", () => {
  const options = createFinanceOptions({ period: "daily", date: "2026-01-01" });
  assert.equal(options.startDate, "2026-01-01");
  assert.equal(options.endDate, "2026-01-01");
  assert.equal(options.start, "2025-12-31T17:00:00.000Z");
  assert.equal(options.end, "2026-01-01T17:00:00.000Z");
  assert.deepEqual(options.previous, {
    period: "daily", date: "2025-12-31", startDate: "2025-12-31", endDate: "2025-12-31",
    endExclusiveDate: "2026-01-01", start: "2025-12-30T17:00:00.000Z", end: options.start
  });
});

test("weekly ranges run Monday to Sunday across month/year boundaries", () => {
  for (const date of ["2026-01-01", "2025-12-29", "2026-01-04"]) {
    const options = createFinanceOptions({ period: "weekly", date });
    assert.equal(options.startDate, "2025-12-29");
    assert.equal(options.endDate, "2026-01-04");
    assert.equal(options.endExclusiveDate, "2026-01-05");
    assert.equal(options.start, "2025-12-28T17:00:00.000Z");
    assert.equal(options.end, "2026-01-04T17:00:00.000Z");
    assert.equal(options.previous.startDate, "2025-12-22");
    assert.equal(options.previous.endDate, "2025-12-28");
    assert.equal(options.previous.end, options.start);
  }
  assert.equal(createFinanceOptions({ period: "weekly", date: "2026-01-05" }).startDate, "2026-01-05");
});

test("monthly and yearly comparisons use adjacent calendar periods, including leap years", () => {
  const february = createFinanceOptions({ date: "2024-02-29" });
  assert.equal(february.endDate, "2024-02-29");
  assert.equal(february.previous.startDate, "2024-01-01");
  assert.equal(february.previous.endDate, "2024-01-31");
  assert.equal(february.previous.end, february.start);
  const march = createFinanceOptions({ date: "2024-03-31" });
  assert.equal(march.previous.endDate, "2024-02-29");
  assert.equal(march.previous.end, march.start);
  const year = createFinanceOptions({ period: "yearly", date: "2024-07-09" });
  assert.equal(year.bucketUnit, "month");
  assert.equal(year.startDate, "2024-01-01");
  assert.equal(year.endDate, "2024-12-31");
  assert.equal(year.endExclusiveDate, "2025-01-01");
  assert.equal(year.previous.startDate, "2023-01-01");
  assert.equal(year.previous.endDate, "2023-12-31");
  assert.equal(year.previous.end, year.start);
});

test("selection bounds permit metadata and prior periods beyond the selected year bounds", () => {
  const first = createFinanceOptions({ period: "yearly", date: "2000-01-01" });
  assert.equal(first.previous.startDate, "1999-01-01");
  assert.equal(first.start, "1999-12-31T17:00:00.000Z");
  const last = createFinanceOptions({ date: "2100-12-31" });
  assert.equal(last.endExclusiveDate, "2101-01-01");
  for (const date of ["1999-12-31", "2101-01-01", "1900-02-29", "2100-02-29", "2023-02-29", "2026-04-31",
    "2026-13-01", "2026-00-01", "2026-01-00", "2026-1-01", "2026-01-1", "2026-10-09T00:00:00Z", " 2026-10-09", "", null, []]) {
    invalid(() => createFinanceOptions({ date }));
  }
  assert.doesNotThrow(() => createFinanceOptions({ date: "2000-02-29" }));
  for (const period of ["", "Monthly", "month", "quarterly", null, [], {}]) {
    invalid(() => createFinanceOptions({ date: "2026-10-09", period }));
  }
});

test("chart buckets include every local calendar day or month, including zero-activity dates", () => {
  const daily = createFinanceBuckets(createFinanceOptions({ period: "daily", date: "2026-10-09" }));
  assert.deepEqual(daily, [{ date: "2026-10-09" }]);
  const weekly = createFinanceBuckets(createFinanceOptions({ period: "weekly", date: "2026-01-01" }));
  assert.equal(weekly.length, 7);
  assert.deepEqual(weekly[0], { date: "2025-12-29" });
  assert.deepEqual(weekly.at(-1), { date: "2026-01-04" });
  const leapMonth = createFinanceBuckets(createFinanceOptions({ date: "2000-02-29" }));
  assert.equal(leapMonth.length, 29);
  assert.deepEqual(leapMonth.at(-1), { date: "2000-02-29" });
  const nonLeapMonth = createFinanceBuckets(createFinanceOptions({ date: "2100-02-28" }));
  assert.equal(nonLeapMonth.length, 28);
  const yearly = createFinanceBuckets(createFinanceOptions({ period: "yearly", date: "2024-12-31" }));
  assert.equal(yearly.length, 12);
  assert.deepEqual(yearly[0], { date: "2024-01-01" });
  assert.deepEqual(yearly.at(-1), { date: "2024-12-01" });
  invalid(() => createFinanceBuckets({ startDate: "2026-01-01", endExclusiveDate: "2025-01-01", bucketUnit: "day" }));
});

test("strict query parsing merges URL and server query only when they agree", () => {
  const options = parseFinanceQuery({
    url: "/api/admin/finance?period=weekly&date=2026-10-09&expensePage=3&expensePageSize=100",
    query: { period: "weekly", date: "2026-10-09", expensePage: "3", expensePageSize: "100" }
  }, NOW);
  assert.equal(options.period, "weekly");
  assert.equal(options.expensePage, 3);
  assert.equal(options.expensePageSize, 100);
  assert.equal(options.expenseOffset, 200);
  assert.equal(parseFinanceQuery({ url: "/api/admin/finance?date=2024-02-29" }, NOW).date, "2024-02-29");
  assert.equal(parseFinanceQuery({ query: { period: "yearly" } }, NOW).date, "2026-10-09");
  for (const [name, value] of Object.entries({ period: "monthly", date: "2026-10-09", expensePage: "1", expensePageSize: "10" })) {
    invalid(() => parseFinanceQuery({ url: `/api/admin/finance?${name}=${value}&${name}=${value}`, query: { [name]: value } }, NOW));
    invalid(() => parseFinanceQuery({ url: `/api/admin/finance?${name}=${value}`, query: { [name]: "mismatch" } }, NOW));
    invalid(() => parseFinanceQuery({ query: { [name]: [value] } }, NOW));
  }
  for (const query of [null, [], "date=2026-10-09"]) invalid(() => parseFinanceQuery({ query }, NOW));
  invalid(() => parseFinanceQuery({ url: "http://[invalid" }, NOW));
});

test("expense pagination rejects coercion, numeric ambiguity, oversized pages and offsets", () => {
  const malformed = ["0", "-1", "1.5", "1e2", "Infinity", "NaN", "+1", "01", " 1", "1 ", "", "9007199254740992", 1, null, {}, []];
  for (const name of ["expensePage", "expensePageSize"]) {
    for (const value of malformed) invalid(() => parseFinanceQuery({ query: { [name]: value } }, NOW));
  }
  invalid(() => parseFinanceQuery({ query: { expensePageSize: "101" } }, NOW));
  invalid(() => parseFinanceQuery({ query: { expensePage: "9007199254740991", expensePageSize: "100" } }, NOW));
  for (const value of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    invalid(() => createFinanceOptions({ date: "2026-10-09", expensePage: value }));
  }
  for (const input of [null, [], "monthly"]) invalid(() => createFinanceOptions(input, NOW));
});

test("creating an expense normalizes UUID and description while retaining precise rupiah", () => {
  const actual = validateExpenseCreate({ ...expense, id: ID.toUpperCase(), description: "  Tepung pasta  ", amount: MAX_EXPENSE_AMOUNT }, NOW);
  assert.deepEqual(actual, { ...expense, amount: MAX_EXPENSE_AMOUNT });
  assert.equal(EXPENSE_CATEGORIES.length, 6);
  assert.deepEqual(EXPENSE_CATEGORIES.map(category => category.id), ["bahan_baku", "kemasan", "operasional", "transportasi", "pemasaran", "lainnya"]);
  for (const category of EXPENSE_CATEGORIES) {
    assert.equal(typeof category.label, "string");
    assert.equal(validateExpenseCreate({ ...expense, category: category.id, amount: 1 }, NOW).category, category.id);
  }
});

test("expense dates cannot be in the future and follow the midnight WIB boundary", () => {
  const before = Date.parse("2026-10-08T16:59:59.999Z");
  const after = Date.parse("2026-10-08T17:00:00Z");
  invalid(() => validateExpenseCreate(expense, before));
  assert.doesNotThrow(() => validateExpenseCreate(expense, after));
  invalid(() => validateExpenseUpdate({ ...expense, expectedUpdatedAt: VERSION }, before));
  invalid(() => validateExpenseCreate({ ...expense, date: "2026-10-10" }, NOW));
  assert.doesNotThrow(() => createFinanceOptions({ date: "2027-01-01" }, NOW));
  for (const date of ["2026-02-29", "1999-12-31", "2101-01-01", null, "2026-10-09T00:00:00Z"]) {
    invalid(() => validateExpenseCreate({ ...expense, date }, NOW));
  }
});

test("expense IDs require valid UUID versions and variants", () => {
  for (const id of [null, 1, "", ` ${ID}`, ID.replace(/-/g, ""), "8912c341-b153-01a6-b09e-2da1b709c9cf",
    "8912c341-b153-91a6-b09e-2da1b709c9cf", "8912c341-b153-41a6-709e-2da1b709c9cf", "8912c341-b153-41a6-z09e-2da1b709c9cf"]) {
    invalid(() => validateExpenseCreate({ ...expense, id }, NOW));
    invalid(() => validateExpenseDelete({ id, expectedUpdatedAt: VERSION }));
  }
});

test("invalid expense amounts and categories cannot reach persistence", () => {
  for (const amount of [0, -1, 0.5, "150000", true, null, MAX_EXPENSE_AMOUNT + 1, Number.MAX_SAFE_INTEGER, Infinity, NaN]) {
    invalid(() => validateExpenseCreate({ ...expense, amount }, NOW));
  }
  for (const category of ["", "unknown", "Bahan Baku", " bahan_baku", null, [], {}]) {
    invalid(() => validateExpenseCreate({ ...expense, category }, NOW));
  }
  for (const body of [undefined, null, [], 1, "expense"]) {
    invalid(() => validateExpenseCreate(body, NOW));
    invalid(() => validateExpenseUpdate(body, NOW));
    invalid(() => validateExpenseDelete(body));
  }
});

test("expense descriptions require bounded visible text without control characters", () => {
  for (const description of [undefined, null, [], 1, "", "   ", "x".repeat(201), "two\nlines", "\ttext", "text\r",
    "null\u0000byte", "del\u007f", "next\u0085line"]) {
    invalid(() => validateExpenseCreate({ ...expense, description }, NOW));
  }
  assert.equal(validateExpenseCreate({ ...expense, description: "x".repeat(200) }, NOW).description.length, 200);
});

test("edits and deletes preserve full six-digit database version without truncation", () => {
  assert.deepEqual(validateExpenseUpdate({ ...expense, expectedUpdatedAt: VERSION }, NOW), { ...expense, expectedUpdatedAt: VERSION });
  assert.deepEqual(validateExpenseDelete({ id: ID.toUpperCase(), expectedUpdatedAt: VERSION }), { id: ID, expectedUpdatedAt: VERSION });
  for (const expectedUpdatedAt of ["2024-02-29T23:59:59.999999Z", "2026-10-09T01:02:03.000001Z", "2026-10-09T01:02:03.000000Z"]) {
    assert.equal(validateExpenseDelete({ id: ID, expectedUpdatedAt }).expectedUpdatedAt, expectedUpdatedAt);
  }
  for (const expectedUpdatedAt of [undefined, null, 1, "", "2026-10-09T01:02:03.123Z", "2026-10-09T01:02:03Z",
    "2026-10-09T01:02:03.1234567Z", "2026-10-09T01:02:03.123456+00:00", "2026-02-29T01:02:03.123456Z",
    "2026-10-09T24:02:03.123456Z", "2026-10-09T01:60:03.123456Z", "2026-10-09T01:02:60.123456Z", ` ${VERSION}`]) {
    invalid(() => validateExpenseUpdate({ ...expense, expectedUpdatedAt }, NOW));
    invalid(() => validateExpenseDelete({ id: ID, expectedUpdatedAt }));
  }
});
