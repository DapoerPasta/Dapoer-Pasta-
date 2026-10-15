(() => {
  "use strict";
  const VENDOR = "/assets/vendor/finance-export/";
  const PERIODS = { day: "Harian", week: "Mingguan", month: "Bulanan", year: "Tahunan" };
  const SOURCES = { restock: "Penambahan stok", adjustment: "Penyesuaian stok", order: "Pesanan masuk", cancellation: "Pengembalian pembatalan", system: "Perubahan sistem" };
  const WINE = "641D21", GOLD = "B18A45", CREAM = "F7F2EA";
  const scriptLoads = new Map(), fontLoads = new Map();
  const clean = value => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const knownQuantity = value => value === null || integer(value);
  const quantityLabel = value => value === null ? "Tidak tersedia" : value.toLocaleString("id-ID");

  function check(signal) {
    if (signal?.aborted) throw new DOMException("Unduhan dibatalkan.", "AbortError");
  }

  function waitFor(promise, signal) {
    check(signal);
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const aborted = () => { signal.removeEventListener("abort", aborted); reject(new DOMException("Unduhan dibatalkan.", "AbortError")); };
      signal.addEventListener("abort", aborted, { once: true });
      promise.then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => { signal.removeEventListener("abort", aborted); reject(error); });
    });
  }

  function loadScript(file, available) {
    if (available()) return Promise.resolve();
    if (scriptLoads.has(file)) return scriptLoads.get(file);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const fail = message => { clearTimeout(timeout); script.remove(); scriptLoads.delete(file); reject(new Error(message)); };
      const timeout = setTimeout(() => fail("Pustaka unduhan terlalu lama dimuat. Coba lagi."), 30000);
      script.src = VENDOR + file;
      script.async = true;
      script.onload = () => { if (available()) { clearTimeout(timeout); resolve(); } else fail("Pustaka unduhan belum siap. Coba lagi."); };
      script.onerror = () => fail("Pustaka unduhan gagal dimuat. Periksa koneksi lalu coba lagi.");
      document.head.appendChild(script);
    });
    scriptLoads.set(file, promise);
    return promise;
  }

  function loadFont(file) {
    if (fontLoads.has(file)) return fontLoads.get(file);
    // Shared requests contain public library assets only, never report data.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const promise = fetch(VENDOR + file, { cache: "force-cache", credentials: "same-origin", signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Font laporan gagal dimuat. Coba lagi."); return response.arrayBuffer(); })
      .then(buffer => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return btoa(binary);
      }).catch(error => {
        fontLoads.delete(file);
        if (controller.signal.aborted) throw new Error("Font laporan terlalu lama dimuat. Periksa koneksi lalu coba lagi.");
        throw error;
      }).finally(() => clearTimeout(timeout));
    fontLoads.set(file, promise);
    return promise;
  }

  function dateLabel(value) {
    return new Date(value + "T00:00:00Z").toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  }

  function timeLabel(value) {
    return new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " WIB";
  }

  function isTimestamp(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
  }

  function isDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function validate(report) {
    const invalid = () => { throw new Error("Data laporan tidak lengkap. Muat ulang laporan lalu coba lagi."); };
    if (!report || report.timeZone !== "Asia/Jakarta" || !report.period || !Object.hasOwn(PERIODS, report.period.type) || !isDate(report.period.startDate) || !isDate(report.period.endDate) || report.period.startDate > report.period.endDate || !isTimestamp(report.generatedAt) || !report.summary || !report.coverage || !Array.isArray(report.products) || !Array.isArray(report.movements) || !report.pagination) invalid();
    const summary = report.summary, coverage = report.coverage;
    if (!integer(summary.movementCount) || !integer(summary.incoming) || !integer(summary.outgoing) || !knownQuantity(summary.opening) || !knownQuantity(summary.closing) || !integer(report.pagination.total) || typeof coverage.available !== "boolean" || typeof coverage.partial !== "boolean" || typeof coverage.inProgress !== "boolean" || !isTimestamp(coverage.startedAt)) invalid();
    if (report.movements.length !== report.pagination.total || report.movements.length !== summary.movementCount) throw new Error("Riwayat belum lengkap. Tunggu semua halaman laporan dimuat sebelum mengunduh.");
    if (coverage.available) {
      if (!isTimestamp(coverage.effectiveStart) || !isTimestamp(coverage.effectiveEnd) || Date.parse(coverage.effectiveStart) > Date.parse(coverage.effectiveEnd) || summary.opening === null || summary.closing === null) invalid();
    } else if (summary.opening !== null || summary.closing !== null || summary.movementCount !== 0) invalid();
    const productIds = new Set(), movementIds = new Set();
    let opening = 0, incoming = 0, outgoing = 0, closing = 0;
    for (const product of report.products) {
      if (typeof product.id !== "string" || !product.id || productIds.has(product.id) || typeof product.name !== "string" || !product.name || !knownQuantity(product.opening) || !knownQuantity(product.closing) || !integer(product.incoming) || !integer(product.outgoing)) invalid();
      if (coverage.available ? product.opening === null || product.closing === null || product.opening + product.incoming - product.outgoing !== product.closing : product.opening !== null || product.closing !== null || product.incoming !== 0 || product.outgoing !== 0) invalid();
      productIds.add(product.id);
      opening += product.opening || 0; incoming += product.incoming; outgoing += product.outgoing; closing += product.closing || 0;
    }
    if (incoming !== summary.incoming || outgoing !== summary.outgoing || coverage.available && (opening !== summary.opening || closing !== summary.closing)) invalid();
    let movementIn = 0, movementOut = 0;
    const deltas = new Map();
    for (const movement of report.movements) {
      const key = String(movement.id ?? "");
      if (!key || movementIds.has(key) || !isTimestamp(movement.createdAt) || !productIds.has(movement.productId) || typeof movement.productName !== "string" || !integer(movement.stockBefore) || !integer(movement.quantityIn) || !integer(movement.quantityOut) || !integer(movement.stockAfter) || (movement.quantityIn === 0) === (movement.quantityOut === 0) || movement.stockBefore + movement.quantityIn - movement.quantityOut !== movement.stockAfter || typeof movement.source !== "string" || typeof movement.reason !== "string" || movement.orderId != null && typeof movement.orderId !== "string") invalid();
      movementIds.add(key); movementIn += movement.quantityIn; movementOut += movement.quantityOut;
      const delta = deltas.get(movement.productId) || { incoming: 0, outgoing: 0 };
      delta.incoming += movement.quantityIn; delta.outgoing += movement.quantityOut;
      deltas.set(movement.productId, delta);
    }
    if (movementIn !== summary.incoming || movementOut !== summary.outgoing || report.products.some(product => product.incoming !== (deltas.get(product.id)?.incoming || 0) || product.outgoing !== (deltas.get(product.id)?.outgoing || 0))) invalid();
  }

  function metadata(report, options) {
    const generated = options.generatedDate || report.generatedAt;
    const generatedLabel = typeof generated === "string" && isDate(generated) ? dateLabel(generated) + " WIB" : timeLabel(generated);
    const coverage = report.coverage;
    const notes = [
      "Jumlah stok menggunakan unit per menu. Laporan ini tidak menghitung nilai persediaan atau laba.",
      "Pencatatan dimulai " + timeLabel(coverage.startedAt) + ". Stok yang sudah ada menjadi saldo awal, bukan transaksi stok masuk.",
      coverage.available ? "Cakupan tercatat: " + timeLabel(coverage.effectiveStart) + " sampai " + timeLabel(coverage.effectiveEnd) + "." : "Periode ini berada di luar cakupan pencatatan. Saldo awal dan saldo akhir tidak tersedia.",
      "Saldo akhir = saldo awal + stok masuk − stok keluar. Penambahan, pengurangan, koreksi, pesanan, dan pengembalian pembatalan tercatat otomatis.",
      "Daftar riwayat memuat seluruh " + report.summary.movementCount.toLocaleString("id-ID") + " perubahan dari periode dan pilihan menu saat laporan dimuat. Perubahan setelah laporan dimuat tidak disertakan."
    ];
    if (coverage.partial && coverage.available) notes.push("Periode dimulai sebelum pencatatan aktif. Saldo awal berlaku pada awal cakupan tercatat; riwayat sebelum aktivasi tidak tersedia.");
    if (coverage.inProgress && coverage.available) notes.push("Periode masih berjalan. Saldo akhir dan transaksi hanya sampai waktu laporan dimuat.");
    return { period: `${PERIODS[report.period.type]} · ${dateLabel(report.period.startDate)} – ${dateLabel(report.period.endDate)} · WIB`, generated: generatedLabel, notes };
  }

  function sheets(report, meta) {
    return [
      { name: "Ringkasan Stok", columns: ["Menu", "Saldo awal", "Stok masuk", "Stok keluar", "Saldo akhir"], rows: [...report.products.map(product => [clean(product.name), product.opening === null ? "Tidak tersedia" : product.opening, product.incoming, product.outgoing, product.closing === null ? "Tidak tersedia" : product.closing]), ["TOTAL UNIT", report.summary.opening === null ? "Tidak tersedia" : report.summary.opening, report.summary.incoming, report.summary.outgoing, report.summary.closing === null ? "Tidak tersedia" : report.summary.closing]], widths: [43, 20, 20, 20, 20] },
      { name: "Riwayat Stok", columns: ["Waktu (WIB)", "Menu", "Sebelum", "Masuk", "Keluar", "Sesudah", "Sumber", "Alasan / catatan", "Nomor pesanan"], rows: report.movements.map(item => [timeLabel(item.createdAt), clean(item.productName), item.stockBefore, item.quantityIn, item.quantityOut, item.stockAfter, clean(SOURCES[item.source] || item.source), clean(item.reason), clean(item.orderId)]), widths: [30, 38, 16, 16, 16, 16, 30, 64, 32] },
      { name: "Dasar Laporan", columns: ["Keterangan", "Nilai"], rows: [["Usaha", "Dapoer Pasta"], ["Periode", meta.period], ["Tanggal awal", report.period.startDate], ["Tanggal akhir", report.period.endDate], ["Zona waktu", "Asia/Jakarta (WIB)"], ["Dibuat", meta.generated], ["Laporan dimuat", timeLabel(report.generatedAt)], ["Mulai pencatatan", timeLabel(report.coverage.startedAt)], ["Jumlah perubahan", report.summary.movementCount], ...meta.notes.map((value, index) => [`Catatan ${index + 1}`, value])], widths: [28, 120] }
    ];
  }

  function csvCell(value) {
    const plain = typeof value === "number" ? String(value) : clean(value);
    // Spreadsheet apps may evaluate untrusted descriptions after leading whitespace.
    const safe = typeof value === "string" && (/^\s*[=+@-]/.test(plain) || /^[\t\r\n]/.test(plain)) ? "'" + plain : plain;
    return '"' + safe.replace(/"/g, '""') + '"';
  }

  async function csv(report, options, meta) {
    const rows = [["DAPOER PASTA · LAPORAN RIWAYAT STOK"], [meta.period], ["Dibuat", meta.generated], []];
    sheets(report, meta).forEach(model => { rows.push([model.name], model.columns, ...model.rows, []); });
    check(options.signal);
    return new Blob(["\ufeff", rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  }

  async function xlsx(report, options, meta) {
    await waitFor(loadScript("exceljs-4.4.0.min.js", () => !!window.ExcelJS?.Workbook), options.signal);
    check(options.signal);
    const book = new window.ExcelJS.Workbook();
    book.creator = "Dapoer Pasta";
    book.title = "Laporan Riwayat Stok Dapoer Pasta";
    book.subject = meta.period;
    const created = new Date(options.generatedDate || report.generatedAt);
    if (!Number.isNaN(created.getTime())) book.created = created;
    sheets(report, meta).forEach(model => {
      const sheet = book.addWorksheet(model.name, { views: [{ state: "frozen", ySplit: 3 }], pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:3" } });
      sheet.columns = model.widths.map(width => ({ width }));
      sheet.addRow(["DAPOER PASTA · LAPORAN RIWAYAT STOK"]);
      sheet.mergeCells(1, 1, 1, model.columns.length);
      sheet.getRow(1).font = { name: "Calibri", bold: true, size: 16, color: { argb: "FF" + WINE } };
      sheet.getRow(1).height = 29;
      sheet.addRow([meta.period]);
      sheet.mergeCells(2, 1, 2, model.columns.length);
      sheet.getRow(2).font = { name: "Calibri", size: 11, color: { argb: "FF6F655F" } };
      sheet.getRow(2).height = 27;
      sheet.addRow(model.columns);
      sheet.getRow(3).height = 30;
      sheet.getRow(3).eachCell(cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + WINE } };
        cell.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" } };
        cell.alignment = { vertical: "middle", wrapText: true };
      });
      model.rows.forEach((values, index) => {
        // Plain strings are never passed as formula or hyperlink objects.
        const row = sheet.addRow(values);
        row.height = Math.min(180, Math.max(30, ...values.map((value, column) => typeof value === "string" ? (Math.ceil(value.length / Math.max(1, model.widths[column] - 3)) + (value.match(/\n/g) || []).length) * 15 : 30)));
        row.eachCell((cell, position) => {
          const isNumber = typeof values[position - 1] === "number";
          cell.font = { name: "Calibri", size: 11, color: { argb: "FF302825" }, ...(model.name === "Ringkasan Stok" && index === model.rows.length - 1 ? { bold: true } : {}) };
          cell.alignment = { vertical: "middle", wrapText: true, horizontal: isNumber ? "right" : "left" };
          if (isNumber) cell.numFmt = "#,##0";
          if (index % 2 === 0) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + CREAM } };
        });
      });
      if (model.rows.length) sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: model.rows.length + 3 - (model.name === "Ringkasan Stok" ? 1 : 0), column: model.columns.length } };
      sheet.headerFooter.oddFooter = "&LDapoer Pasta · Riwayat stok · WIB&RHalam. &P / &N";
    });
    const buffer = await waitFor(book.xlsx.writeBuffer(), options.signal);
    check(options.signal);
    return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  async function pdf(report, options, meta) {
    await waitFor(loadScript("jspdf-4.2.1.umd.min.js", () => !!window.jspdf?.jsPDF), options.signal);
    await waitFor(loadScript("jspdf-autotable-5.0.8.min.js", () => typeof window.jspdf?.jsPDF?.API?.autoTable === "function"), options.signal);
    // A concurrent finance download may load another copy of jsPDF while fonts
    // are fetched. Keep the constructor whose AutoTable plugin is already ready.
    const PDF = window.jspdf.jsPDF;
    const [regular, bold] = await waitFor(Promise.all([loadFont("OpenSans-Regular.ttf"), loadFont("OpenSans-Bold.ttf")]), options.signal);
    check(options.signal);
    const doc = new PDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true, putOnlyUsedFonts: true });
    doc.addFileToVFS("OpenSans-Regular.ttf", regular); doc.addFont("OpenSans-Regular.ttf", "OpenSans", "normal");
    doc.addFileToVFS("OpenSans-Bold.ttf", bold); doc.addFont("OpenSans-Bold.ttf", "OpenSans", "bold");
    doc.setFont("OpenSans", "normal");
    doc.setProperties({ title: "Laporan Riwayat Stok Dapoer Pasta", subject: meta.period, author: "Dapoer Pasta", creator: "Dapoer Pasta Admin" });
    const width = 297, height = 210, margin = 12, usable = width - 2 * margin;
    const color = value => [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16));
    const wine = color(WINE), cream = color(CREAM);
    function header() {
      doc.setFillColor(...wine); doc.rect(0, 0, width, 28, "F");
      doc.setTextColor(255, 250, 244); doc.setFont("OpenSans", "bold"); doc.setFontSize(13); doc.text("DAPOER PASTA", margin, 10);
      doc.setFont("OpenSans", "normal"); doc.setFontSize(9); doc.text("Laporan Riwayat Stok", margin, 16);
      doc.setFontSize(8); doc.text(meta.period, margin, 23);
      doc.setFillColor(...color(GOLD)); doc.rect(0, 28, width, 1, "F");
    }
    function title(value, y) { doc.setFont("OpenSans", "bold"); doc.setFontSize(11); doc.setTextColor(...wine); doc.text(value, margin, y); doc.setFont("OpenSans", "normal"); }
    let cursor = 38;
    header();
    function table(label, columns, rows, widths, numericColumns = []) {
      check(options.signal);
      if (cursor + 35 > height - 18) { doc.addPage(); header(); cursor = 38; }
      title(label, cursor);
      doc.autoTable({
        startY: cursor + 5, margin: { left: margin, right: margin, top: 43, bottom: 17 },
        tableWidth: usable, head: [columns], body: rows.length ? rows : [[{ content: "Tidak ada perubahan stok pada periode ini.", colSpan: columns.length }]],
        styles: { font: "OpenSans", fontSize: 7.5, cellPadding: 2.1, overflow: "linebreak", valign: "middle", textColor: [48, 40, 37], lineColor: [235, 226, 215], lineWidth: 0.1 },
        headStyles: { fontSize: 7.2, fontStyle: "bold", fillColor: wine, textColor: [255, 255, 255] },
        alternateRowStyles: { fillColor: cream },
        columnStyles: Object.fromEntries(columns.map((_, index) => [index, { cellWidth: widths[index], ...(numericColumns.includes(index) ? { halign: "right" } : {}) }])),
        rowPageBreak: "avoid", showHead: "everyPage",
        didDrawPage: hook => { if (hook.pageNumber > 1) { header(); title(label + " · lanjutan", 38); } }
      });
      cursor = doc.lastAutoTable.finalY + 12;
    }
    const models = sheets(report, meta);
    table("Ringkasan seluruh periode · unit", models[0].columns, models[0].rows.map(row => row.map(value => typeof value === "number" ? quantityLabel(value) : value)), [101, 43, 43, 43, 43], [1, 2, 3, 4]);
    table("Dasar dan cakupan laporan", ["Keterangan", "Nilai"], [["Dibuat", meta.generated], ["Laporan dimuat", timeLabel(report.generatedAt)], ["Jumlah perubahan", report.summary.movementCount.toLocaleString("id-ID")], ...meta.notes.map((note, index) => [`Catatan ${index + 1}`, note])], [36, 237]);
    // Start the detailed list on a fresh page so all nine columns remain readable.
    doc.addPage(); header(); cursor = 38;
    table("Seluruh riwayat stok · unit", models[1].columns, models[1].rows.map(row => row.map(value => typeof value === "number" ? quantityLabel(value) : value)), [30, 42, 17, 14, 14, 17, 30, 65, 44], [2, 3, 4, 5]);
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
      doc.setPage(page); doc.setDrawColor(224, 215, 205); doc.line(margin, height - 13, width - margin, height - 13);
      doc.setFont("OpenSans", "normal"); doc.setFontSize(7); doc.setTextColor(111, 101, 92);
      doc.text("Dapoer Pasta · Riwayat stok · WIB", margin, height - 8);
      doc.text(`Halaman ${page} / ${pages}`, width - margin, height - 8, { align: "right" });
    }
    check(options.signal);
    return doc.output("blob");
  }

  async function build(report, options = {}) {
    check(options.signal);
    validate(report);
    const builders = { pdf, xlsx, csv };
    if (!Object.hasOwn(builders, options.format)) throw new Error("Format unduhan tidak tersedia.");
    const blob = await builders[options.format](report, options, metadata(report, options));
    check(options.signal);
    return { blob, extension: options.format, label: { pdf: "PDF", xlsx: "Excel / Google Sheets", csv: "CSV" }[options.format] };
  }

  window.DapoerStockHistoryFiles = Object.freeze({ build });
})();
