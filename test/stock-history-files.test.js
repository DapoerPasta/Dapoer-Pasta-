const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const assetRoot = path.join(__dirname, "../assets");
const vendorRoot = path.join(assetRoot, "vendor/finance-export");

function fixture(pairs = 2) {
  const movements = [];
  for (let index = 0; index < pairs * 2; index++) {
    const incoming = index % 2 === 1;
    movements.push({ id: String(index + 1), createdAt: new Date(Date.UTC(2026, 9, 14, 23, 0, index)).toISOString(), productId: "pasta", productName: "=Pasta & <homemade>", stockBefore: incoming ? 99 : 100, quantityIn: incoming ? 1 : 0, quantityOut: incoming ? 0 : 1, stockAfter: incoming ? 100 : 99, source: incoming ? "cancellation" : "order", reason: ["=2+3 & <tag> \"literal\"", "  +SUM(A1:A2)", "@SUM(A1:A2)", "\t-SUM(A1:A2)"][index % 4], orderId: "ORDER-FULL-" + String(index + 1).padStart(5, "0") });
  }
  return {
    timeZone: "Asia/Jakarta", generatedAt: "2026-10-15T10:00:00Z",
    period: { type: "year", date: "2026-10-15", startDate: "2026-01-01", endDate: "2026-12-31", start: "2025-12-31T17:00:00Z", end: "2026-12-31T17:00:00Z" },
    coverage: { startedAt: "2026-10-01T00:00:00Z", available: true, partial: true, inProgress: true, effectiveStart: "2026-10-01T00:00:00Z", effectiveEnd: "2026-10-15T10:00:00Z" },
    summary: { movementCount: movements.length, incoming: pairs, outgoing: pairs, opening: 150, closing: 150 },
    products: [{ id: "pasta", name: "=Pasta & <homemade>", opening: 100, incoming: pairs, outgoing: pairs, closing: 100 }, { id: "chicken", name: "Chicken Cordon Bleu", opening: 50, incoming: 0, outgoing: 0, closing: 50 }],
    movements,
    pagination: { snapshot: "opaque-test-snapshot", cursor: null, nextCursor: null, total: movements.length, pageSize: 100, expiresAt: "2026-10-15T11:00:00Z" }
  };
}

function builder(options = {}) {
  let context, timerId = 0;
  const loaded = [], requests = [], timers = new Map();
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
      options.onFontRequest?.(context);
      if (options.holdFonts) return new Promise((resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Font request timed out", "AbortError")), { once: true }));
      const file = fs.readFileSync(path.join(vendorRoot, path.basename(url)));
      return { ok: true, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) };
    }
  });
  context.window = context; context.self = context; context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(assetRoot, "js/stock-history-files.js"), "utf8"), context);
  return { build: context.DapoerStockHistoryFiles.build, loaded, requests, timers };
}

// Independently parse standard ZIP directory and DEFLATE, without the XLSX writer.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "ZIP end record exists");
  const entries = buffer.readUInt16LE(end + 10), files = new Map();
  let position = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50);
    const method = buffer.readUInt16LE(position + 10), length = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28), extraLength = buffer.readUInt16LE(position + 30), commentLength = buffer.readUInt16LE(position + 32), local = buffer.readUInt32LE(position + 42);
    const name = buffer.toString("utf8", position + 46, position + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const bytes = buffer.subarray(start, start + length);
    files.set(name, method === 0 ? bytes : zlib.inflateRawSync(bytes));
    position += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test("stock XLSX contains all 242 movements, numeric balances, plain-text notes and honest activation coverage", async () => {
  const files = builder(), report = fixture(121);
  const result = await files.build(report, { format: "xlsx", generatedDate: "2026-10-15" });
  assert.equal(result.extension, "xlsx");
  assert.equal(result.blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const entries = unzip(Buffer.from(await result.blob.arrayBuffer()));
  const workbook = entries.get("xl/workbook.xml").toString();
  assert.equal((workbook.match(/<sheet /g) || []).length, 3);
  for (const label of ["Ringkasan Stok", "Riwayat Stok", "Dasar Laporan"]) assert.ok(workbook.includes(label));
  const strings = entries.get("xl/sharedStrings.xml").toString();
  assert.match(strings, /=Pasta &amp; &lt;homemade&gt;/);
  assert.match(strings, /=2\+3 &amp; &lt;tag&gt;/);
  assert.match(strings, /15 Okt 2026 WIB/);
  assert.match(strings, /15 Okt 2026, 06\.00\.00 WIB/);
  assert.match(strings, /ORDER-FULL-00242/);
  assert.match(strings, /1 Okt 2026, 07\.00\.00 WIB/);
  assert.match(strings, /bukan transaksi stok masuk/);
  assert.match(strings, /riwayat sebelum aktivasi tidak tersedia/);
  const movements = entries.get("xl/worksheets/sheet2.xml").toString();
  assert.equal((movements.match(/<row /g) || []).length, 245);
  assert.match(movements, /<c r="C4" s="\d+"><v>100<\/v><\/c>/);
  assert.match(movements, /<c r="D4" s="\d+"><v>0<\/v><\/c>/);
  assert.match(movements, /<c r="E4" s="\d+"><v>1<\/v><\/c>/);
  for (const [name, bytes] of entries) if (name.startsWith("xl/worksheets/")) assert.doesNotMatch(bytes.toString(), /<f[ >]/);
  assert.equal(files.loaded.length, 1);
  assert.equal(files.timers.size, 0);
});

test("stock CSV protects formula-looking text, preserves quoted/newline notes and includes summaries plus all movements", async () => {
  const files = builder(), report = fixture();
  report.movements[0].reason = '=HYPERLINK("https://example.invalid")\nCatatan lanjutan, aman';
  const result = await files.build(report, { format: "csv" });
  const bytes = Buffer.from(await result.blob.arrayBuffer()), source = bytes.toString("utf8");
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(source, /"'=Pasta & <homemade>"/);
  assert.match(source, /"'=HYPERLINK\(""https:\/\/example.invalid""\)\nCatatan lanjutan, aman"/);
  assert.match(source, /"'  \+SUM\(A1:A2\)"/);
  assert.match(source, /"'@SUM\(A1:A2\)"/);
  assert.match(source, /"'\t-SUM\(A1:A2\)"/);
  assert.match(source, /"100","0","1","99"/);
  assert.match(source, /"ORDER-FULL-00004"/);
  assert.match(source, /"TOTAL UNIT","150","2","2","150"/);
  assert.equal(files.loaded.length, 0, "CSV requires no download libraries");
});

test("stock PDF is a real multipage landscape document with embedded fonts and local-only asset loads", async () => {
  const files = builder(), result = await files.build(fixture(121), { format: "pdf" });
  assert.equal(result.blob.type, "application/pdf");
  const source = Buffer.from(await result.blob.arrayBuffer()).toString("latin1");
  assert.match(source, /^%PDF-/);
  assert.match(source, /\/FontFile2/);
  assert.match(source, /\/ToUnicode/);
  assert.ok((source.match(/\/Type \/Page\b/g) || []).length >= 10);
  const boxes = [...source.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];
  assert.ok(boxes.length >= 10);
  assert.ok(boxes.every(box => Number(box[1]) > Number(box[2])));
  assert.deepEqual(files.loaded.map(script => path.basename(script.src)), ["jspdf-4.2.1.umd.min.js", "jspdf-autotable-5.0.8.min.js"]);
  assert.ok(files.requests.every(url => url.startsWith("/assets/vendor/finance-export/")));
  assert.equal(files.timers.size, 0);
});

test("stock PDF retains its plugin-ready constructor when another export replaces global jsPDF during font loading", async () => {
  let replacements = 0;
  const files = builder({ onFontRequest(context) {
    vm.runInContext(fs.readFileSync(path.join(vendorRoot, "jspdf-4.2.1.umd.min.js"), "utf8"), context);
    assert.equal(typeof context.jspdf.jsPDF.API.autoTable, "undefined", "the replacement constructor has no AutoTable plugin");
    replacements++;
  } });
  const result = await files.build(fixture(), { format: "pdf" });
  assert.equal(replacements, 2);
  assert.match(Buffer.from(await result.blob.arrayBuffer()).toString("latin1"), /^%PDF-/);
});

test("a period predating activation exports unknown balances instead of fabricated zero or current stock", async () => {
  const files = builder(), report = fixture(0);
  report.period = { type: "year", date: "2025-10-15", startDate: "2025-01-01", endDate: "2025-12-31" };
  report.coverage = { ...report.coverage, available: false, inProgress: false, effectiveStart: null, effectiveEnd: null };
  report.summary.opening = null; report.summary.closing = null;
  report.products.forEach(product => { product.opening = null; product.closing = null; });
  const result = await files.build(report, { format: "xlsx" });
  const entries = unzip(Buffer.from(await result.blob.arrayBuffer()));
  const strings = entries.get("xl/sharedStrings.xml").toString();
  assert.match(strings, /Tidak tersedia/);
  assert.match(strings, /Saldo awal dan saldo akhir tidak tersedia/);
  const movements = entries.get("xl/worksheets/sheet2.xml").toString();
  assert.equal((movements.match(/<row /g) || []).length, 3);
  const summary = entries.get("xl/worksheets/sheet1.xml").toString();
  assert.doesNotMatch(summary, /<v>100<\/v>|<v>150<\/v>|<v>50<\/v>/);
});

test("empty known period retains real opening stock and zero changes", async () => {
  const files = builder(), report = fixture(0);
  const result = await files.build(report, { format: "csv" });
  const source = await result.blob.text();
  assert.match(source, /"TOTAL UNIT","150","0","0","150"/);
  assert.match(source, /seluruh 0 perubahan/);
});

test("partial pages, duplicate records and inconsistent movement balances reject before a library load", async () => {
  const files = builder();
  let report = fixture(); report.movements.pop();
  await assert.rejects(files.build(report, { format: "xlsx" }), /Riwayat belum lengkap/);
  report = fixture(); report.movements[1].id = report.movements[0].id;
  await assert.rejects(files.build(report, { format: "xlsx" }), /Data laporan tidak lengkap/);
  report = fixture(); report.movements[0].stockAfter = 98;
  await assert.rejects(files.build(report, { format: "pdf" }), /Data laporan tidak lengkap/);
  report = fixture(); report.products[0].incoming++;
  await assert.rejects(files.build(report, { format: "xlsx" }), /Data laporan tidak lengkap/);
  report = fixture(); report.summary.incoming = "2";
  await assert.rejects(files.build(report, { format: "xlsx" }), /Data laporan tidak lengkap/);
  report = fixture(); report.period.startDate = "2026-02-30";
  await assert.rejects(files.build(report, { format: "xlsx" }), /Data laporan tidak lengkap/);
  assert.equal(files.loaded.length, 0);
});

test("unknown formats cannot select inherited functions", async () => {
  const files = builder();
  for (const format of ["xml", "constructor", "toString"]) await assert.rejects(files.build(fixture(), { format }), /Format unduhan tidak tersedia/);
  assert.equal(files.loaded.length, 0);
});

test("canceled downloads return no blob before or during a pending public library request", async () => {
  const files = builder({ holdScripts: true });
  const first = new AbortController(); first.abort();
  await assert.rejects(files.build(fixture(), { format: "xlsx", signal: first.signal }), { name: "AbortError" });
  assert.equal(files.loaded.length, 0);
  const second = new AbortController();
  const pending = files.build(fixture(), { format: "xlsx", signal: second.signal });
  second.abort();
  await assert.rejects(pending, { name: "AbortError" });
  files.loaded[0].onerror();
  assert.equal(files.timers.size, 0);
});

test("a stalled export library has a bounded timeout and can be retried", async () => {
  const files = builder({ holdScripts: true });
  const pending = files.build(fixture(), { format: "xlsx" });
  const timer = [...files.timers.values()][0];
  assert.equal(timer.delay, 30000); timer.callback();
  await assert.rejects(pending, /terlalu lama/);
  assert.equal(files.loaded[0].removed, true);
  const retry = files.build(fixture(), { format: "xlsx" });
  assert.equal(files.loaded.length, 2); files.loaded[1].onerror();
  await assert.rejects(retry, /gagal dimuat/);
});

test("font timeout gives a useful error and a later retry builds a real PDF", async () => {
  const options = { holdFonts: true }, files = builder(options);
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
