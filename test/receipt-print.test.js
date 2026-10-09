const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");

const assetRoot = path.join(__dirname, "../assets");
const vendorRoot = path.join(assetRoot, "vendor/finance-export");

function order(overrides = {}) {
  return {
    id: "DP-20261009-ABC123", createdAt: "2026-10-08T17:01:00.000Z",
    status: "diproses", queueNumber: 1, queueDate: "2026-10-09",
    queueLabel: "FORGED-QUEUE", paymentMethod: "Transfer BCA",
    items: [{ name: "Pasta à la crème", quantity: 2, price: 37000, subtotal: 74000 }],
    total: 74000, customerName: "PRIVATE-NAME", customerPhone: "PRIVATE-PHONE",
    address: "PRIVATE-ADDRESS", notes: "PRIVATE-NOTES",
    customer: { phone: "NESTED-PRIVATE-PHONE", email: "NESTED-PRIVATE-EMAIL" },
    ...overrides
  };
}

// The production helper and actual vendored PDF/font files run together in an
// isolated browser-like VM. No receipt data leaves this process.
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
        try {
          vm.runInContext(fs.readFileSync(path.join(vendorRoot, path.basename(script.src)), "utf8"), context);
          script.onload();
        } catch (error) { script.onerror(); }
      });
    } }
  };
  context = vm.createContext({
    document, console, Blob, DOMException, AbortController, TextEncoder, TextDecoder,
    Uint8Array, ArrayBuffer, DataView, Date, Intl, queueMicrotask, Promise,
    atob, btoa, navigator: { userAgent: "test" }, location: { href: "http://localhost/nota/" },
    setTimeout(callback, delay) {
      if (!delay || delay < 1000) return setTimeout(callback, delay);
      const id = ++timerId; timers.set(id, { callback, delay }); return id;
    },
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
  vm.runInContext(fs.readFileSync(path.join(assetRoot, "js/receipt-print-files.js"), "utf8"), context);
  return { ...context.DapoerReceiptPrint, loaded, requests, timers };
}

// Inspect standard PDF objects, DEFLATE streams and the embedded ToUnicode
// maps independently of the writer, so assertions read the actual file.
function readPdf(buffer) {
  const source = buffer.toString("latin1"), objects = new Map();
  for (const match of source.matchAll(/\b(\d+) 0 obj\s*\n([\s\S]*?)\nendobj/g)) objects.set(match[1], match[2]);
  function stream(body) {
    const start = body.indexOf("\nstream\n");
    if (start < 0) return "";
    const data = Buffer.from(body.slice(start + 8, body.lastIndexOf("\nendstream")), "latin1");
    return (body.slice(0, start).includes("/FlateDecode") ? zlib.inflateSync(data) : data).toString("latin1");
  }
  const fonts = new Map();
  for (const match of source.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const font = objects.get(match[2]) || "", unicodeId = /\/ToUnicode (\d+) 0 R/.exec(font)?.[1];
    if (!unicodeId) continue;
    const cmap = stream(objects.get(unicodeId)), chars = new Map();
    for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const char of section[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
        const bytes = Buffer.from(char[2], "hex");
        chars.set(char[1].toLowerCase().padStart(4, "0"), bytes.swap16().toString("utf16le"));
      }
    }
    const descendantId = /\/DescendantFonts \[\s*(\d+) 0 R\s*\]/.exec(font)?.[1];
    const descendant = objects.get(descendantId) || "", widths = new Map();
    for (const width of descendant.matchAll(/(\d+) \[(\d+)\]/g)) widths.set(Number(width[1]), Number(width[2]));
    fonts.set(match[1], { chars, widths });
  }
  const pages = [], texts = [], runs = [];
  for (const body of objects.values()) {
    if (!/\/Type \/Page\b/.test(body)) continue;
    const box = /\/MediaBox \[([^\]]+)\]/.exec(body)[1].trim().split(/\s+/).map(Number);
    pages.push({ box });
    const contentId = /\/Contents (\d+) 0 R/.exec(body)?.[1];
    if (!contentId) continue;
    let font = null, size = 0, x = 0, y = 0, leading = 0;
    for (const token of stream(objects.get(contentId)).matchAll(/\bBT\b|\/(F\d+) ([\d.]+) Tf|(-?[\d.]+) (-?[\d.]+) Td|([\d.]+) TL|T\*|<([0-9a-f]+)> Tj/g)) {
      if (token[0] === "BT") { x = 0; y = 0; }
      else if (token[1]) { font = fonts.get(token[1]); size = Number(token[2]); }
      else if (token[3]) { x += Number(token[3]); y += Number(token[4]); }
      else if (token[5]) leading = Number(token[5]);
      else if (token[0] === "T*") y -= leading;
      else {
        let text = "", width = 0;
        for (let offset = 0; offset < token[6].length; offset += 4) {
          const glyph = token[6].slice(offset, offset + 4).toLowerCase();
          text += font?.chars.get(glyph) || "�";
          width += (font?.widths.get(parseInt(glyph, 16)) ?? 1000) * size / 1000;
        }
        texts.push(text);
        runs.push({ text, x, y, width, size, page: pages.length - 1 });
      }
    }
  }
  return { source, pages, runs, text: texts.join("\n") };
}

function assertFits(pdf, marginMm) {
  const margin = marginMm * 72 / 25.4;
  for (const run of pdf.runs) {
    const box = pdf.pages[run.page].box;
    assert.ok(run.x >= margin - .02, `left edge: ${run.text}`);
    assert.ok(run.x + run.width <= box[2] - margin + .15, `right edge: ${run.text}`);
    assert.ok(run.y >= margin - .02, `bottom edge: ${run.text}`);
    assert.ok(run.y <= box[3] - margin + .02, `top edge: ${run.text}`);
  }
}

test("normalization derives the daily queue label and protects customer data by default", () => {
  const files = builder();
  for (const protectedData of [undefined, true, "false", null]) {
    const result = files.normalize(order({ customerDataProtected: protectedData }));
    assert.equal(result.queueLabel, "A001");
    assert.equal(result.customerDataProtected, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|FORGED/);
    assert.equal(Object.hasOwn(result, "customer"), false);
  }
  assert.equal(files.normalize(order({ queueNumber: 1234 })).queueLabel, "A1234");
  const legacy = files.normalize(order({ queueNumber: null, queueDate: null }));
  assert.equal(legacy.queueLabel, "Belum tersedia");
  assert.equal(legacy.queueNumber, null);
});

test("normalization rejects inconsistent totals, unsafe money, malformed queue data and unknown statuses", () => {
  const files = builder();
  const cases = [
    { total: 74001 }, { total: Number.MAX_SAFE_INTEGER + 1 }, { status: "toString" }, { status: "paid" },
    { items: [] }, { items: [{ name: "Pasta", quantity: 2, price: 37000, subtotal: 37000 }] },
    { items: [{ name: "Pasta", quantity: 1, price: Number.MAX_SAFE_INTEGER + 1, subtotal: Number.MAX_SAFE_INTEGER + 1 }] },
    { items: [{ name: "Pasta", quantity: 0, price: 0, subtotal: 0 }] },
    { items: [{ name: " ", quantity: 2, price: 37000, subtotal: 74000 }] },
    { queueNumber: 0 }, { queueNumber: 1.5 }, { queueNumber: null }, { queueDate: null },
    { queueDate: "2026-02-30" }, { queueDate: "invalid" }, { createdAt: "invalid" }
  ];
  for (const input of cases) assert.throws(() => files.normalize(order(input)), /Data nota tidak valid/, JSON.stringify(input));
  assert.equal(files.loaded.length, 0);
});

test("a receipt creation timestamp must refer to an actual calendar date", () => {
  const files = builder();
  for (const createdAt of ["2026-02-30T12:00:00.000Z", "2026-02-29T12:00:00.000Z", "2026-04-31T12:00:00.000Z"]) {
    assert.throws(() => files.normalize(order({ createdAt })), /Data nota tidak valid/);
  }
  assert.equal(files.normalize(order({ createdAt: "2028-02-29T12:00:00.000Z" })).createdAt, "2028-02-29T12:00:00.000Z");
});

test("receipt dates and currency use WIB without shifting the daily queue date", () => {
  const files = builder();
  assert.match(files.createdLabel("2026-10-08T17:01:00.000Z"), /09\/10\/2026.*00[.:]01.*WIB/);
  assert.match(files.createdLabel("2026-10-08T16:59:00.000Z"), /08\/10\/2026.*23[.:]59.*WIB/);
  assert.equal(files.dateLabel("2026-10-09"), "9 Oktober 2026 WIB");
  assert.equal(files.money(74000), "Rp 74.000");
});

test("58 mm, 80 mm and A4 downloads are real PDFs with exact physical widths and Unicode fonts", async () => {
  const files = builder();
  for (const paper of ["58", "80", "a4"]) {
    const result = await files.build(order(), { paper });
    assert.equal(result.blob.type, "application/pdf");
    assert.equal(result.paper, paper);
    assert.equal(result.filename, `Struk-DP-20261009-ABC123-${paper === "a4" ? "A4" : paper + "mm"}.pdf`);
    const pdf = readPdf(Buffer.from(await result.blob.arrayBuffer()));
    assert.match(pdf.source, /^%PDF-/);
    assert.match(pdf.source, /\/FontFile2/);
    assert.match(pdf.source, /\/ToUnicode/);
    assert.equal(pdf.pages.length, 1);
    const width = (paper === "a4" ? 210 : Number(paper)) * 72 / 25.4;
    assert.ok(Math.abs(pdf.pages[0].box[2] - width) < 0.00001, `${paper}: ${pdf.pages[0].box[2]} pt`);
    if (paper === "a4") assert.ok(Math.abs(pdf.pages[0].box[3] - 297 * 72 / 25.4) < 0.00001);
    assert.match(pdf.text, /Pasta à la crème/);
    assert.match(pdf.text, /2 × Rp 37\.000/);
    assert.match(pdf.text, /A001/);
    assert.match(pdf.text, /Rp 74\.000/);
    assert.doesNotMatch(pdf.text, /FORGED|PRIVATE/);
    assertFits(pdf, paper === "58" ? 5 : paper === "80" ? 4 : 14);
  }
  assert.deepEqual(files.loaded.map(script => path.basename(script.src)), ["jspdf-4.2.1.umd.min.js"]);
  assert.equal(files.requests.length, 2, "both local fonts are reused across paper formats");
  assert.ok(files.requests.every(url => url.startsWith("/assets/vendor/finance-export/")));
  assert.equal(files.timers.size, 0);
});

test("authorized thermal PDF prints the customer name while phone, address and notes stay private", async () => {
  const files = builder();
  const result = await files.build(order({ customerDataProtected: false }), { paper: "58" });
  const pdf = readPdf(Buffer.from(await result.blob.arrayBuffer()));
  assert.match(pdf.text, /PRIVATE-NAME/);
  assert.doesNotMatch(pdf.text, /PRIVATE-PHONE|PRIVATE-ADDRESS|PRIVATE-NOTES|NESTED-PRIVATE/);
});

test("authorized A4 PDF preserves full customer information, while protected A4 omits it", async () => {
  const files = builder();
  const full = await files.build(order({ customerDataProtected: false }), { paper: "a4" });
  const pdf = readPdf(Buffer.from(await full.blob.arrayBuffer()));
  for (const value of ["PRIVATE-NAME", "PRIVATE-PHONE", "PRIVATE-ADDRESS", "PRIVATE-NOTES"]) assert.ok(pdf.text.includes(value), value);
  assert.doesNotMatch(pdf.text, /NESTED-PRIVATE/);
  const protectedResult = await files.build(order(), { paper: "a4" });
  const protectedPdf = readPdf(Buffer.from(await protectedResult.blob.arrayBuffer()));
  assert.doesNotMatch(protectedPdf.text, /PRIVATE/);
  assert.match(protectedPdf.text, /Data pelanggan dilindungi/);
});

test("long 100-item thermal orders paginate, retaining first and last items and the total", async () => {
  const files = builder();
  const items = Array.from({ length: 100 }, (_, index) => ({
    name: `Menu ${String(index + 1).padStart(3, "0")} ` + "Pasta homemade premium dengan saus pilihan ".repeat(5),
    quantity: 1, price: 37000, subtotal: 37000
  }));
  const result = await files.build(order({ items, total: 3700000 }), { paper: "58" });
  const pdf = readPdf(Buffer.from(await result.blob.arrayBuffer()));
  assert.ok(pdf.pages.length > 1);
  for (const { box } of pdf.pages) {
    assert.ok(Math.abs(box[2] - 58 * 72 / 25.4) < 0.00001);
    assert.ok(box[3] <= 1000 * 72 / 25.4 + 0.00001);
  }
  assert.match(pdf.text, /Menu 001/);
  assert.match(pdf.text, /Menu 100/);
  assert.equal((pdf.text.match(/Menu \d{3}/g) || []).length, 100);
  assert.match(pdf.text, /Rp 3\.700\.000/);
  assert.match(pdf.text, /Terima kasih/);
  assert.ok(pdf.pages.at(-1).box[3] < 1000 * 72 / 25.4, "last thermal page is cropped to its actual content height");
  const itemStarts = pdf.runs.map((run, index) => /^Menu \d{3}/.test(run.text) ? index : -1).filter(index => index >= 0);
  for (const start of itemStarts) {
    const subtotal = pdf.runs.findIndex((run, index) => index > start && run.text === "Rp 37.000");
    assert.ok(subtotal > start, "item subtotal exists");
    assert.ok(pdf.runs.slice(start, subtotal + 1).every(run => run.page === pdf.runs[start].page), "an item's name, quantity and subtotal stay on the same page");
  }
  const totalIndex = pdf.runs.findIndex(run => run.text === "TOTAL");
  assert.equal(pdf.runs[totalIndex].page, pdf.runs[totalIndex + 1].page, "TOTAL label and amount stay together");
  assertFits(pdf, 5);
});

test("maximum safe totals and long unbroken menu names fit within thermal print margins", async () => {
  const files = builder();
  const input = order({
    total: Number.MAX_SAFE_INTEGER,
    items: [{ name: "LongMenuName".repeat(25), quantity: 1, price: Number.MAX_SAFE_INTEGER, subtotal: Number.MAX_SAFE_INTEGER }]
  });
  for (const paper of ["58", "80"]) {
    const result = await files.build(input, { paper });
    const pdf = readPdf(Buffer.from(await result.blob.arrayBuffer()));
    assert.match(pdf.text.replace(/\n/g, ""), /Rp 9\.007\.199\.254\.740\.991/);
    assertFits(pdf, paper === "58" ? 5 : 4);
  }
});

test("invalid paper choices reject before any scripts or fonts are loaded", async () => {
  const files = builder();
  for (const paper of ["57", "A4", "toString", "constructor"]) await assert.rejects(files.build(order(), { paper }), /Ukuran kertas tidak tersedia/);
  assert.equal(files.loaded.length, 0);
  assert.equal(files.requests.length, 0);
});

test("pre-canceled and canceled pending downloads return no PDF", async () => {
  const files = builder({ holdScripts: true });
  const first = new AbortController(); first.abort();
  await assert.rejects(files.build(order(), { signal: first.signal }), { name: "AbortError" });
  assert.equal(files.loaded.length, 0);
  const second = new AbortController();
  const pending = files.build(order(), { signal: second.signal });
  assert.equal(files.loaded.length, 1);
  second.abort();
  await assert.rejects(pending, { name: "AbortError" });
  files.loaded[0].onerror();
  assert.equal(files.timers.size, 0);
});

test("failed or timed-out PDF library loads remove scripts and allow retry", async () => {
  const options = { failScript: () => true }, files = builder(options);
  await assert.rejects(files.build(order()), /PDF gagal dimuat/);
  assert.equal(files.loaded[0].removed, true);
  options.holdScripts = true;
  const pending = files.build(order());
  const timer = [...files.timers.values()][0];
  assert.equal(timer.delay, 30000);
  timer.callback();
  await assert.rejects(pending, /Pustaka PDF terlalu lama/);
  assert.equal(files.loaded[1].removed, true);
  options.failScript = () => false; options.holdScripts = false;
  const result = await files.build(order());
  assert.equal(result.blob.type, "application/pdf");
  assert.equal(files.loaded.length, 3);
  assert.equal(files.timers.size, 0);
});

test("font timeout is bounded, cleans up timers, and permits a later successful download", async () => {
  const options = { holdFonts: true }, files = builder(options);
  const pending = files.build(order());
  const rejection = assert.rejects(pending, /Font struk terlalu lama dimuat/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(files.requests.length, 2);
  [...files.timers.values()].forEach(timer => timer.callback());
  await rejection;
  assert.equal(files.timers.size, 0);
  options.holdFonts = false;
  const result = await files.build(order());
  assert.equal(result.blob.type, "application/pdf");
  assert.equal(files.requests.length, 4);
  assert.equal(files.timers.size, 0);
});
