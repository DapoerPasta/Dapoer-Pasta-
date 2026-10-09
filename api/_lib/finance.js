const FINANCE_TIME_ZONE = "Asia/Jakarta";
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXPENSE_AMOUNT = 1000000000000;
const EXPENSE_CATEGORIES = Object.freeze([
  { id: "bahan_baku", label: "Bahan baku" },
  { id: "kemasan", label: "Kemasan" },
  { id: "operasional", label: "Operasional" },
  { id: "transportasi", label: "Transportasi" },
  { id: "pemasaran", label: "Pemasaran" },
  { id: "lainnya", label: "Lainnya" }
].map(category => Object.freeze(category)));
const categoryIds = new Set(EXPENSE_CATEGORIES.map(category => category.id));
const periods = new Set(["daily", "weekly", "monthly", "yearly"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class FinanceValidationError extends Error {
  constructor(message = "Data keuangan tidak valid.") {
    super(message);
    this.name = "FinanceValidationError";
    this.code = "INVALID_FINANCE_INPUT";
  }
}

function todayInJakarta(now) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || Number.isNaN(new Date(timestamp + WIB_OFFSET_MS).getTime())) {
    throw new FinanceValidationError("Waktu tidak valid.");
  }
  return new Date(timestamp + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

function parseCalendarDate(value, restrictYear = true) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FinanceValidationError("Tanggal harus berformat YYYY-MM-DD dan valid.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if ((restrictYear && (year < 2000 || year > 2100)) ||
      date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new FinanceValidationError("Tanggal harus valid dan berada antara tahun 2000 dan 2100.");
  }
  return date;
}

function calendarString(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function rangeMetadata(period, date, anchor) {
  let start;
  let end;
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  if (period === "yearly") {
    start = Date.UTC(year, 0, 1);
    end = Date.UTC(year + 1, 0, 1);
  } else if (period === "monthly") {
    start = Date.UTC(year, month, 1);
    end = Date.UTC(year, month + 1, 1);
  } else if (period === "weekly") {
    // ISO weeks begin on Monday; JavaScript numbers Sunday as zero.
    start = anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * DAY_MS;
    end = start + 7 * DAY_MS;
  } else {
    start = anchor.getTime();
    end = start + DAY_MS;
  }
  return {
    period,
    date,
    startDate: calendarString(start),
    endDate: calendarString(end - DAY_MS),
    endExclusiveDate: calendarString(end),
    start: new Date(start - WIB_OFFSET_MS).toISOString(),
    end: new Date(end - WIB_OFFSET_MS).toISOString()
  };
}

function createFinanceOptions(input = {}, now = Date.now()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FinanceValidationError("Parameter keuangan tidak valid.");
  }
  const { period = "monthly", date = todayInJakarta(now), expensePage = 1, expensePageSize = 10 } = input;
  if (!periods.has(period)) {
    throw new FinanceValidationError("Periode harus harian, mingguan, bulanan, atau tahunan.");
  }
  const anchor = parseCalendarDate(date);
  if (!Number.isSafeInteger(expensePage) || expensePage < 1) {
    throw new FinanceValidationError("Halaman pengeluaran harus berupa bilangan bulat positif.");
  }
  if (!Number.isSafeInteger(expensePageSize) || expensePageSize < 1 || expensePageSize > 100) {
    throw new FinanceValidationError("Jumlah pengeluaran per halaman harus antara 1 dan 100.");
  }
  const expenseOffset = (expensePage - 1) * expensePageSize;
  if (!Number.isSafeInteger(expenseOffset)) {
    throw new FinanceValidationError("Nomor halaman pengeluaran terlalu besar.");
  }
  const current = rangeMetadata(period, date, anchor);
  // The immediately preceding day belongs to the adjacent previous period.
  // Range metadata can cross 2000 or 2100 even though selectable dates cannot.
  const previousAnchor = new Date(parseCalendarDate(current.startDate, false).getTime() - DAY_MS);
  const previousDate = calendarString(previousAnchor.getTime());
  return {
    ...current,
    previous: rangeMetadata(period, previousDate, previousAnchor),
    bucketUnit: period === "yearly" ? "month" : "day",
    expensePage,
    expensePageSize,
    expenseOffset
  };
}

function parseFinanceQuery(req, now = Date.now()) {
  const query = req.query === undefined ? {} : req.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new FinanceValidationError("Parameter keuangan tidak valid.");
  }
  let params;
  try {
    params = new URL(req.url || "/api/admin/finance", "https://localhost").searchParams;
  } catch {
    throw new FinanceValidationError("Parameter keuangan tidak valid.");
  }
  function single(name) {
    const values = params.getAll(name);
    const value = query[name];
    if (values.length > 1 || (value !== undefined && typeof value !== "string") ||
        (values.length === 1 && value !== undefined && value !== values[0])) {
      throw new FinanceValidationError("Parameter keuangan tidak valid.");
    }
    return values.length === 1 ? values[0] : value;
  }
  function positiveInteger(name, fallback) {
    const value = single(name);
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new FinanceValidationError("Parameter halaman harus berupa bilangan bulat positif.");
    }
    return Number(value);
  }
  return createFinanceOptions({
    period: single("period"),
    date: single("date"),
    expensePage: positiveInteger("expensePage", 1),
    expensePageSize: positiveInteger("expensePageSize", 10)
  }, now);
}

function createFinanceBuckets(options) {
  const start = parseCalendarDate(options.startDate, false);
  const end = parseCalendarDate(options.endExclusiveDate, false);
  if (!["day", "month"].includes(options.bucketUnit) || end <= start || end - start > 366 * DAY_MS) {
    throw new FinanceValidationError("Rentang grafik keuangan tidak valid.");
  }
  const buckets = [];
  for (let cursor = start; cursor < end;) {
    buckets.push({ date: calendarString(cursor.getTime()) });
    cursor = options.bucketUnit === "month"
      ? new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
      : new Date(cursor.getTime() + DAY_MS);
  }
  return buckets;
}

function requireBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FinanceValidationError("Data pengeluaran tidak valid.");
  }
}

function expenseId(id) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new FinanceValidationError("ID pengeluaran tidak valid.");
  }
  return id.toLowerCase();
}

function validateExpenseCreate(body, now = Date.now()) {
  requireBody(body);
  const id = expenseId(body.id);
  parseCalendarDate(body.date);
  if (body.date > todayInJakarta(now)) {
    throw new FinanceValidationError("Tanggal pengeluaran tidak boleh melebihi hari ini.");
  }
  if (!categoryIds.has(body.category)) {
    throw new FinanceValidationError("Kategori pengeluaran tidak valid.");
  }
  if (typeof body.description !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(body.description)) {
    throw new FinanceValidationError("Keterangan pengeluaran harus berupa teks tanpa karakter kontrol.");
  }
  const description = body.description.trim();
  if (description.length < 1 || description.length > 200) {
    throw new FinanceValidationError("Keterangan pengeluaran harus antara 1 dan 200 karakter.");
  }
  if (!Number.isSafeInteger(body.amount) || body.amount < 1 || body.amount > MAX_EXPENSE_AMOUNT) {
    throw new FinanceValidationError("Nominal pengeluaran harus berupa rupiah bulat antara 1 dan 1.000.000.000.000.");
  }
  return { id, date: body.date, category: body.category, description, amount: body.amount };
}

function expenseVersion(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) {
    throw new FinanceValidationError("Versi pengeluaran diperlukan untuk menyimpan perubahan.");
  }
  // Validate calendar and clock fields without losing PostgreSQL microseconds.
  parseCalendarDate(value.slice(0, 10), false);
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new FinanceValidationError("Versi pengeluaran tidak valid.");
  }
  return value;
}

function validateExpenseUpdate(body, now = Date.now()) {
  return { ...validateExpenseCreate(body, now), expectedUpdatedAt: expenseVersion(body.expectedUpdatedAt) };
}

function validateExpenseDelete(body) {
  requireBody(body);
  return { id: expenseId(body.id), expectedUpdatedAt: expenseVersion(body.expectedUpdatedAt) };
}

module.exports = {
  FinanceValidationError,
  FINANCE_TIME_ZONE,
  EXPENSE_CATEGORIES,
  MAX_EXPENSE_AMOUNT,
  createFinanceOptions,
  parseFinanceQuery,
  createFinanceBuckets,
  validateExpenseCreate,
  validateExpenseUpdate,
  validateExpenseDelete
};
