const TIME_ZONE = "Asia/Jakarta";
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

class HistoryQueryError extends Error {}

function todayInJakarta(now = Date.now()) {
  return new Date(Number(now) + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

function dayRange(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HistoryQueryError("Tanggal harus berformat YYYY-MM-DD dan valid.");
  }
  const [year, month, day] = date.split("-").map(Number);
  const midnight = new Date(0);
  midnight.setUTCFullYear(year, month - 1, day);
  midnight.setUTCHours(0, 0, 0, 0);
  if (year < 1 || midnight.getUTCFullYear() !== year ||
      midnight.getUTCMonth() !== month - 1 || midnight.getUTCDate() !== day) {
    throw new HistoryQueryError("Tanggal harus berformat YYYY-MM-DD dan valid.");
  }
  const start = midnight.getTime() - WIB_OFFSET_MS;
  function timestamp(value) {
    const iso = new Date(value).toISOString();
    // PostgreSQL names astronomical year zero 1 BC. This can occur for the
    // UTC boundary of the first selectable calendar day, 0001-01-01 in WIB.
    return iso.startsWith("0000-") ? iso.replace(/^0000-/, "0001-") + " BC" : iso;
  }
  return { start: timestamp(start), end: timestamp(start + DAY_MS) };
}

function createHistoryOptions({ date, page = 1, pageSize = 100 } = {}, now = Date.now()) {
  const selectedDate = date === undefined ? todayInJakarta(now) : date;
  const range = dayRange(selectedDate);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new HistoryQueryError("Halaman harus berupa bilangan bulat positif.");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new HistoryQueryError("Jumlah pesanan per halaman harus antara 1 dan 200.");
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new HistoryQueryError("Nomor halaman terlalu besar.");
  }
  return { date: selectedDate, page, pageSize, offset, ...range };
}

function parseHistoryQuery(req, now = Date.now()) {
  const query = req.query === undefined ? {} : req.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new HistoryQueryError("Parameter riwayat tidak valid.");
  }
  let params;
  try {
    params = new URL(req.url || "/api/admin/orders", "https://localhost").searchParams;
  } catch {
    throw new HistoryQueryError("Parameter riwayat tidak valid.");
  }
  function single(name) {
    const values = params.getAll(name);
    const value = query[name];
    if (values.length > 1 || (value !== undefined && typeof value !== "string") ||
        (values.length === 1 && value !== undefined && value !== values[0])) {
      throw new HistoryQueryError("Parameter riwayat tidak valid.");
    }
    return values.length === 1 ? values[0] : value;
  }
  function positiveInteger(name, fallback) {
    const value = single(name);
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new HistoryQueryError("Parameter halaman harus berupa bilangan bulat positif.");
    }
    return Number(value);
  }
  return createHistoryOptions({
    date: single("date"),
    page: positiveInteger("page", 1),
    pageSize: positiveInteger("pageSize", 100)
  }, now);
}

module.exports = { TIME_ZONE, HistoryQueryError, todayInJakarta, dayRange, createHistoryOptions, parseHistoryQuery };
