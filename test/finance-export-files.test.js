const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const assetRoot = path.join(__dirname, "../assets");
const vendorRoot = path.join(assetRoot, "vendor/finance-export");
const summary = {
  completedSales: 2000000, completedCount: 12, pendingValue: 500000,
  pendingCount: 3, expenseTotal: 1000000000000, expenseCount: 42,
  recordedBalance: -999998000000, orderValue: 2500000, orderCount: 15,
  cancelledValue: 125000, cancelledCount: 2, totalOrders: 17
};
function fixture() {
  return {
    period: { type: "yearly", date: "2026-10-09", startDate: "2026-01-01", endDate: "2026-12-31", timeZone: "Asia/Jakarta" },
    previousPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" },
    summary: { ...summary }, previousSummary: { ...summary, completedSales: 0, recordedBalance: -1000000000000 },
    buckets: Array.from({ length: 12 }, (_, i) => ({ ...summary, date: `2026-${String(i + 1).padStart(2, "0")}-01` })),
    paymentMethods: [{ paymentMethod: '=2+3 & <tag> "literal"', completedSales: 2000000, completedCount: 12, orderValue: 2500000, orderCount: 15 }],
    expenseCategories: [{ category: "bahan_baku", total: 1000000000000, count: 42 }],
    expenses: [{ description: "PRIVATE PAGE MUST NOT BE EXPORTED", amount: 1 }],
    expensePagination: { page: 1, total: 42 },
    basis: { income: "Penjualan selesai bukan verifikasi pembayaran lunas.", balance: "Saldo tercatat bukan laba bersih atau saldo rekening.", time: "WIB; pesanan berdasarkan tanggal dibuat." }
  };
}

function builder(options = {}) {
  let context;
  const loaded = [], requests = [], timers = new Map();
  let timerId = 0;
  const document = {
    createElement() { return { remove() { this.removed = true; }, style: {}, dispatchEvent() {}, click() {} }; },
    createElementNS() { return this.createElement(); },
    head: { appendChild(script) {
      loaded.push(script);
      if (options.holdScripts) return;
      queueMicrotask(() => {
        if (options.failScript?.()) return script.onerror();
        try { vm.runInContext(fs.readFileSync(path.join(vendorRoot, path.basename(script.src)), "utf8"), context); script.onload(); }
        catch (error) { script.onerror(); }
      });
    } }
  };
  context = vm.createContext({
    document, console, Blob, DOMException, AbortController, TextEncoder, TextDecoder,
    Uint8Array, ArrayBuffer, DataView, Date, Intl, queueMicrotask, Promise,
    atob, btoa, navigator: { userAgent: "test" }, location: { href: "http://localhost/admin/" },
    setTimeout(callback, delay) { if (!delay || delay < 1000) return setTimeout(callback, delay); const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { if (typeof id === "number") timers.delete(id); else clearTimeout(id); },
    setImmediate, clearImmediate,
    fetch: async (url, request) => {
      requests.push(url);
      if (options.holdFonts) return new Promise((resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Font request timed out", "AbortError")), { once: true }));
      const file = fs.readFileSync(path.join(vendorRoot, path.basename(url)));
      return { ok: true, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) };
    }
  });
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(assetRoot, "js/finance-export-files.js"), "utf8"), context);
  return { build: context.DapoerFinanceFiles.build, loaded, requests, timers };
}

// Read standard ZIP headers and DEFLATE directly, independently of the writer.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "ZIP end record exists");
  const entries = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < entries; index++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50);
    const method = buffer.readUInt16LE(position + 10);
    const length = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const local = buffer.readUInt32LE(position + 42);
    const name = buffer.toString("utf8", position + 46, position + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const bytes = buffer.subarray(start, start + length);
    files.set(name, method === 0 ? bytes : zlib.inflateRawSync(bytes));
    position += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test("XLSX contains six real worksheets, literal unsafe-looking text, all yearly buckets and numeric negative balances", async () => {
  const files = builder();
  const result = await files.build(fixture(), { format: "xlsx", periodLabel: "Tahunan", generatedDate: "2026-10-09" });
  assert.equal(result.extension, "xlsx");
  assert.equal(result.blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const entries = unzip(Buffer.from(await result.blob.arrayBuffer()));
  const workbook = entries.get("xl/workbook.xml").toString();
  assert.equal((workbook.match(/<sheet /g) || []).length, 6);
  const strings = entries.get("xl/sharedStrings.xml").toString();
  assert.match(strings, /=2\+3 &amp; &lt;tag&gt;/);
  assert.match(strings, /1 Jan 2026/);
  assert.match(strings, /31 Des 2026/);
  assert.match(strings, /9 Okt 2026 WIB/);
  assert.doesNotMatch(strings, /07\.00|PRIVATE PAGE/);
  assert.equal((strings.match(/2026-\d{2}-01/g) || []).length, 12);
  const period = entries.get("xl/worksheets/sheet2.xml").toString();
  assert.match(period, /<v>-999998000000<\/v>/);
  assert.match(period, /<v>1000000000000<\/v>/);
  for (const [name, bytes] of entries) if (name.startsWith("xl/worksheets/")) assert.doesNotMatch(bytes.toString(), /<f[ >]/);
  assert.equal(files.loaded.length, 1);
  assert.equal(files.timers.size, 0);
});

test("ODS has the ODF-required stored first mimetype and real numeric/text cells without formulas", async () => {
  const files = builder();
  const result = await files.build(fixture(), { format: "ods", periodLabel: "Tahunan", generatedDate: "2026-10-09" });
  const buffer = Buffer.from(await result.blob.arrayBuffer());
  assert.equal(result.blob.type, "application/vnd.oasis.opendocument.spreadsheet");
  assert.equal(buffer.readUInt16LE(8), 0, "first entry is uncompressed");
  const nameLength = buffer.readUInt16LE(26);
  assert.equal(buffer.toString("utf8", 30, 30 + nameLength), "mimetype");
  const entries = unzip(buffer);
  assert.equal(entries.get("mimetype").toString(), "application/vnd.oasis.opendocument.spreadsheet");
  const content = entries.get("content.xml").toString();
  assert.equal((content.match(/<table:table table:name=/g) || []).length, 6);
  assert.match(content, /office:value-type="float" office:value="-999998000000"/);
  assert.match(content, /office:value-type="string"><text:p>=2\+3 &amp; &lt;tag&gt;/);
  assert.doesNotMatch(content, /table:formula=|PRIVATE PAGE/);
  assert.match(content, /2026-12-01/);
  assert.match(content, /9 Okt 2026 WIB/);
  assert.equal(files.timers.size, 0);
});

test("PDF is a real paginated document with embedded Unicode fonts and locally loaded libraries", async () => {
  const files = builder();
  const result = await files.build(fixture(), { format: "pdf", periodLabel: "Tahunan", generatedDate: "2026-10-09" });
  assert.equal(result.blob.type, "application/pdf");
  const source = Buffer.from(await result.blob.arrayBuffer()).toString("latin1");
  assert.match(source, /^%PDF-/);
  assert.match(source, /\/FontFile2/);
  assert.match(source, /\/ToUnicode/);
  assert.ok((source.match(/\/Type \/Page\b/g) || []).length >= 2);
  assert.deepEqual(files.loaded.map(script => path.basename(script.src)), ["jspdf-4.2.1.umd.min.js", "jspdf-autotable-5.0.8.min.js"]);
  assert.ok(files.requests.every(url => url.startsWith("/assets/vendor/finance-export/")));
  assert.equal(files.timers.size, 0);
});

test("unknown and inherited formats reject before loading any libraries", async () => {
  const files = builder();
  for (const format of ["xml", "toString", "constructor"]) await assert.rejects(files.build(fixture(), { format }), /Format unduhan tidak tersedia/);
  assert.equal(files.loaded.length, 0);
});

test("a pre-canceled or canceled pending library build returns no report blob", async () => {
  const files = builder({ holdScripts: true });
  const first = new AbortController(); first.abort();
  await assert.rejects(files.build(fixture(), { format: "pdf", signal: first.signal }), { name: "AbortError" });
  assert.equal(files.loaded.length, 0);
  const second = new AbortController();
  const pending = files.build(fixture(), { format: "pdf", signal: second.signal });
  assert.equal(files.loaded.length, 1);
  second.abort();
  await assert.rejects(pending, { name: "AbortError" });
  // Shared public-library request has its own bounded timeout and can finish for
  // another caller; no report data is sent or returned for the canceled caller.
  files.loaded[0].onerror();
  assert.equal(files.timers.size, 0);
});

test("library timeout removes the failed script and allows a clean retry", async () => {
  const files = builder({ holdScripts: true });
  const pending = files.build(fixture(), { format: "ods" });
  const timer = [...files.timers.values()][0];
  assert.equal(timer.delay, 30000);
  timer.callback();
  await assert.rejects(pending, /terlalu lama/);
  assert.equal(files.loaded[0].removed, true);
  const retry = files.build(fixture(), { format: "ods" });
  assert.equal(files.loaded.length, 2);
  files.loaded[1].onerror();
  await assert.rejects(retry, /gagal dimuat/);
});

test("font timeout becomes an actionable load error, and a later download retries successfully", async () => {
  const options = { holdFonts: true };
  const files = builder(options);
  const pending = files.build(fixture(), { format: "pdf" });
  const rejection = assert.rejects(pending, /Font laporan terlalu lama dimuat/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(files.requests.length, 2);
  [...files.timers.values()].forEach(timer => timer.callback());
  await rejection;
  options.holdFonts = false;
  const result = await files.build(fixture(), { format: "pdf" });
  assert.equal(result.blob.type, "application/pdf");
  assert.equal(files.requests.length, 4);
  assert.equal(files.timers.size, 0);
});
