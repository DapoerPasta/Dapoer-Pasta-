(() => {
  "use strict";
  const VENDOR = "/assets/vendor/finance-export/";
  const WINE = "641D21", GOLD = "B18A45", CREAM = "F7F2EA";
  const PERIODS = { daily: "Harian", weekly: "Mingguan", monthly: "Bulanan", yearly: "Tahunan" };
  const CATEGORIES = { bahan_baku: "Bahan baku", kemasan: "Kemasan", operasional: "Operasional", transportasi: "Transportasi", pemasaran: "Pemasaran", lainnya: "Lainnya" };
  const FIELDS = [
    ["completedSales", "Penjualan selesai", "money"], ["completedCount", "Pesanan selesai", "count"],
    ["pendingValue", "Pesanan belum selesai", "money"], ["pendingCount", "Jumlah belum selesai", "count"],
    ["expenseTotal", "Pengeluaran tercatat", "money"], ["expenseCount", "Jumlah pengeluaran", "count"],
    ["recordedBalance", "Saldo tercatat", "money"], ["orderValue", "Nilai pesanan aktif", "money"],
    ["orderCount", "Pesanan aktif", "count"], ["cancelledValue", "Nilai dibatalkan", "money"],
    ["cancelledCount", "Pesanan dibatalkan", "count"], ["totalOrders", "Seluruh pesanan", "count"]
  ];
  const scriptLoads = new Map();
  const fontLoads = new Map();
  const numeric = value => Number.isSafeInteger(value) ? value : 0;
  const text = value => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const money = value => `Rp ${numeric(value).toLocaleString("id-ID")}`;
  const xml = value => text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

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
      const timeout = setTimeout(() => { script.remove(); scriptLoads.delete(file); reject(new Error("Pustaka unduhan terlalu lama dimuat. Coba lagi.")); }, 30000);
      script.src = VENDOR + file;
      script.async = true;
      script.onload = () => {
        clearTimeout(timeout);
        if (available()) resolve();
        else { script.remove(); scriptLoads.delete(file); reject(new Error("Pustaka unduhan belum siap. Silakan coba lagi.")); }
      };
      script.onerror = () => { clearTimeout(timeout); script.remove(); scriptLoads.delete(file); reject(new Error("Pustaka unduhan gagal dimuat. Periksa koneksi lalu coba lagi.")); };
      document.head.appendChild(script);
    });
    scriptLoads.set(file, promise);
    return promise;
  }

  function loadFont(file) {
    if (fontLoads.has(file)) return fontLoads.get(file);
    // Shared font/library requests contain no report data. A canceled caller
    // checks its own signal before building or returning any private document.
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

  function dateLabel(value, monthly = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return text(value);
    return new Date(value + "T00:00:00Z").toLocaleDateString("id-ID", { timeZone: "UTC", ...(monthly ? {} : { day: "numeric" }), month: "short", year: "numeric" });
  }

  function generatedLabel(value) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return dateLabel(value) + " WIB";
    const date = value instanceof Date ? value : new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }) + " WIB";
  }

  function metadata(report, options) {
    return {
      period: `${text(options.periodLabel || PERIODS[report.period.type] || report.period.type)} · ${dateLabel(report.period.startDate)} – ${dateLabel(report.period.endDate)} · WIB`,
      generated: generatedLabel(options.generatedDate),
      basis: [report.basis?.income || "Penjualan selesai berasal dari pesanan berstatus selesai, bukan verifikasi pembayaran lunas.", report.basis?.balance || "Saldo tercatat = penjualan selesai dikurangi pengeluaran tercatat; bukan laba bersih atau saldo rekening.", report.basis?.time || "Pesanan berdasarkan tanggal dibuat dalam WIB; pengeluaran berdasarkan tanggal pencatatan.", "Laporan mencakup agregat seluruh periode. Daftar transaksi pengeluaran per halaman tidak disertakan.", "Perbandingan menggunakan seluruh periode sebelumnya; periode berjalan dapat belum lengkap."]
    };
  }

  function sheets(report, meta) {
    const summary = FIELDS.map(([key, label]) => [label, numeric(report.summary[key]), numeric(report.previousSummary?.[key])]);
    const currencyRows = FIELDS.map((field, index) => field[2] === "money" ? index : -1).filter(index => index >= 0);
    return [
      { name: "Ringkasan", columns: ["Indikator", "Periode dipilih", "Periode sebelumnya"], rows: summary, widths: [34, 29, 29], moneyColumns: [1, 2], moneyRows: currencyRows },
      { name: "Rincian Periode", columns: [report.period.type === "yearly" ? "Bulan (WIB)" : "Tanggal (WIB)", ...FIELDS.map(field => field[1])], rows: report.buckets.map(bucket => [bucket.date, ...FIELDS.map(field => numeric(bucket[field[0]]))]), widths: [19, ...FIELDS.map(field => field[2] === "money" ? 27 : 23)], moneyColumns: FIELDS.map((field, index) => field[2] === "money" ? index + 1 : -1).filter(index => index >= 0) },
      { name: "Metode Pembayaran", columns: ["Metode pembayaran", "Penjualan selesai", "Pesanan selesai", "Nilai pesanan aktif", "Pesanan aktif"], rows: report.paymentMethods.map(item => [text(item.paymentMethod), numeric(item.completedSales), numeric(item.completedCount), numeric(item.orderValue), numeric(item.orderCount)]), widths: [34, 29, 23, 29, 23], moneyColumns: [1, 3] },
      { name: "Kategori Pengeluaran", columns: ["Kategori", "Pengeluaran tercatat", "Jumlah pengeluaran"], rows: (report.expenseCategories || []).map(item => [text(CATEGORIES[item.category] || item.category), numeric(item.total), numeric(item.count)]), widths: [34, 29, 25], moneyColumns: [1] },
      { name: "Perbandingan", columns: ["Indikator", "Periode dipilih", "Periode sebelumnya", "Selisih", "Perubahan (%)"], rows: ["completedSales", "expenseTotal", "recordedBalance"].map(key => { const a = numeric(report.summary[key]); const b = numeric(report.previousSummary?.[key]); return [FIELDS.find(field => field[0] === key)[1], a, b, a - b, b === 0 ? "Tidak tersedia; periode sebelumnya nol" : Math.round((a - b) / Math.abs(b) * 1000) / 10]; }), widths: [34, 29, 29, 29, 40], moneyColumns: [1, 2, 3] },
      { name: "Dasar Laporan", columns: ["Keterangan", "Nilai"], rows: [["Usaha", "Dapoer Pasta"], ["Periode", meta.period], ["Tanggal awal", report.period.startDate], ["Tanggal akhir", report.period.endDate], ["Zona waktu", "Asia/Jakarta (WIB)"], ["Dibuat", meta.generated], ["Periode sebelumnya", `${report.previousPeriod?.startDate || ""} – ${report.previousPeriod?.endDate || ""}`], ...meta.basis.map((value, index) => [`Catatan ${index + 1}`, text(value)])], widths: [29, 105], moneyColumns: [] }
    ];
  }

  function isMoneyCell(sheet, row, column) {
    return sheet.moneyColumns.includes(column) && (!sheet.moneyRows || sheet.moneyRows.includes(row));
  }

  async function xlsx(report, options, meta) {
    await waitFor(loadScript("exceljs-4.4.0.min.js", () => !!window.ExcelJS?.Workbook), options.signal);
    check(options.signal);
    const book = new window.ExcelJS.Workbook();
    book.creator = "Dapoer Pasta";
    book.title = "Laporan Keuangan Dapoer Pasta";
    book.subject = meta.period;
    const created = new Date(options.generatedDate || Date.now());
    if (!Number.isNaN(created.getTime())) book.created = created;
    sheets(report, meta).forEach(model => {
      const sheet = book.addWorksheet(model.name, { views: [{ state: "frozen", ySplit: 3 }], pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:3" } });
      sheet.columns = model.widths.map(width => ({ width }));
      sheet.addRow(["DAPOER PASTA · LAPORAN KEUANGAN"]);
      sheet.mergeCells(1, 1, 1, model.columns.length);
      sheet.getRow(1).font = { name: "Calibri", bold: true, size: 16, color: { argb: "FF" + WINE } };
      sheet.getRow(1).height = 28;
      sheet.addRow([meta.period]);
      sheet.mergeCells(2, 1, 2, model.columns.length);
      sheet.getRow(2).font = { name: "Calibri", size: 11, color: { argb: "FF6F655F" } };
      sheet.getRow(2).height = 26;
      sheet.addRow(model.columns);
      sheet.getRow(3).height = 34;
      sheet.getRow(3).eachCell(cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + WINE } };
        cell.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" } };
        cell.alignment = { vertical: "middle", wrapText: true };
      });
      model.rows.forEach((values, index) => {
        // Strings are assigned directly, never as ExcelJS formula/hyperlink objects.
        const row = sheet.addRow(values);
        row.height = model.name === "Dasar Laporan" ? 48 : 27;
        row.eachCell((cell, position) => {
          cell.font = { name: "Calibri", size: 11, color: { argb: "FF302825" } };
          cell.alignment = { vertical: "middle", wrapText: true, horizontal: typeof values[position - 1] === "number" ? "right" : "left" };
          if (index % 2 === 0) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + CREAM } };
          if (isMoneyCell(model, index, position - 1)) cell.numFmt = '"Rp "#,##0;"Rp "-#,##0;"Rp "0';
        });
      });
      if (model.rows.length) sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: model.rows.length + 3, column: model.columns.length } };
      sheet.headerFooter.oddFooter = "&LDapoer Pasta · WIB&RHalam. &P / &N";
    });
    const buffer = await waitFor(book.xlsx.writeBuffer(), options.signal);
    check(options.signal);
    return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  async function ods(report, options, meta) {
    await waitFor(loadScript("fflate-0.8.3.min.js", () => !!window.fflate?.zipSync), options.signal);
    check(options.signal);
    const cells = (values, model, row, header) => values.map((value, column) => {
      const style = header ? "Header" : isMoneyCell(model, row, column) ? "Money" : typeof value === "number" ? "Number" : "Text";
      return typeof value === "number" ? `<table:table-cell table:style-name="${style}" office:value-type="float" office:value="${value}"><text:p>${xml(isMoneyCell(model, row, column) ? money(value) : value)}</text:p></table:table-cell>` : `<table:table-cell table:style-name="${style}" office:value-type="string"><text:p>${xml(value)}</text:p></table:table-cell>`;
    }).join("");
    const models = sheets(report, meta);
    const columnStyles = models.flatMap((model, sheetIndex) => model.widths.map((width, column) => `<style:style style:name="C${sheetIndex}_${column}" style:family="table-column"><style:table-column-properties style:column-width="${Math.round(width * 2.4)}mm"/></style:style>`)).join("");
    const tables = models.map((model, sheetIndex) => `<table:table table:name="${xml(model.name)}">${model.columns.map((_, column) => `<table:table-column table:style-name="C${sheetIndex}_${column}"/>`).join("")}<table:table-header-rows><table:table-row>${cells(model.columns, model, -1, true)}</table:table-row></table:table-header-rows>${model.rows.map((row, index) => `<table:table-row>${cells(row, model, index, false)}</table:table-row>`).join("")}</table:table>`).join("");
    const styles = `<number:currency-style style:name="Rupiah"><number:currency-symbol number:language="id" number:country="ID">Rp </number:currency-symbol><number:number number:decimal-places="0" number:grouping="true"/></number:currency-style><style:style style:name="Header" style:family="table-cell"><style:table-cell-properties fo:background-color="#${WINE}" fo:padding="2mm"/><style:text-properties fo:color="#ffffff" fo:font-weight="bold"/><style:paragraph-properties fo:wrap-option="wrap"/></style:style><style:style style:name="Text" style:family="table-cell"><style:table-cell-properties fo:padding="1.5mm" fo:wrap-option="wrap"/><style:text-properties fo:font-family="Calibri" fo:font-size="11pt"/></style:style><style:style style:name="Number" style:family="table-cell" style:parent-style-name="Text"><style:paragraph-properties fo:text-align="end"/></style:style><style:style style:name="Money" style:family="table-cell" style:parent-style-name="Number" style:data-style-name="Rupiah"/>${columnStyles}`;
    const namespaces = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
    const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${namespaces} office:version="1.3"><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`;
    const manifest = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>';
    const metadataXml = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta><meta:generator>Dapoer Pasta</meta:generator><dc:title>Laporan Keuangan Dapoer Pasta</dc:title><dc:description>${xml(meta.period)}</dc:description></office:meta></office:document-meta>`;
    const { zipSync, strToU8 } = window.fflate;
    // ODF requires the first ZIP member to be the uncompressed mimetype.
    const buffer = zipSync({ mimetype: [strToU8("application/vnd.oasis.opendocument.spreadsheet"), { level: 0 }], "content.xml": strToU8(content), "meta.xml": strToU8(metadataXml), "META-INF/manifest.xml": strToU8(manifest) }, { level: 6 });
    check(options.signal);
    return new Blob([buffer], { type: "application/vnd.oasis.opendocument.spreadsheet" });
  }

  async function pdf(report, options, meta) {
    await waitFor(loadScript("jspdf-4.2.1.umd.min.js", () => !!window.jspdf?.jsPDF), options.signal);
    await waitFor(loadScript("jspdf-autotable-5.0.8.min.js", () => typeof window.jspdf?.jsPDF?.API?.autoTable === "function"), options.signal);
    const [regular, bold] = await waitFor(Promise.all([loadFont("OpenSans-Regular.ttf"), loadFont("OpenSans-Bold.ttf")]), options.signal);
    check(options.signal);
    const doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true, putOnlyUsedFonts: true });
    doc.addFileToVFS("OpenSans-Regular.ttf", regular);
    doc.addFont("OpenSans-Regular.ttf", "OpenSans", "normal");
    doc.addFileToVFS("OpenSans-Bold.ttf", bold);
    doc.addFont("OpenSans-Bold.ttf", "OpenSans", "bold");
    doc.setFont("OpenSans", "normal");
    doc.setProperties({ title: "Laporan Keuangan Dapoer Pasta", subject: meta.period, author: "Dapoer Pasta", creator: "Dapoer Pasta Admin" });
    const width = 297, height = 210, margin = 14, usable = width - margin * 2;
    const color = value => [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
    const wine = color(WINE), gold = color(GOLD), cream = color(CREAM);
    function title(value, y) { doc.setFont("OpenSans", "bold"); doc.setFontSize(12); doc.setTextColor(...wine); doc.text(value, margin, y); doc.setFont("OpenSans", "normal"); }
    function header(compact = false) {
      doc.setFillColor(...wine); doc.rect(0, 0, width, compact ? 28 : 47, "F");
      doc.setFont("OpenSans", "bold"); doc.setFontSize(compact ? 12 : 19); doc.setTextColor(255, 250, 244);
      doc.text("DAPOER PASTA", margin, compact ? 11 : 15);
      doc.setFont("OpenSans", "normal"); doc.setFontSize(compact ? 9 : 12);
      doc.text("Laporan Keuangan", margin, compact ? 17 : 24);
      doc.setFontSize(9); doc.text(doc.splitTextToSize(meta.period, usable), margin, compact ? 23 : 33);
      if (!compact) { doc.setFontSize(7.5); doc.setTextColor(229, 214, 189); doc.text("Dibuat " + meta.generated, margin, 41); }
      doc.setFillColor(...gold); doc.rect(0, compact ? 28 : 47, width, 1, "F");
    }
    header();
    const cards = [["Penjualan selesai", report.summary.completedSales, `${numeric(report.summary.completedCount)} pesanan selesai`], ["Pesanan belum selesai", report.summary.pendingValue, `${numeric(report.summary.pendingCount)} pesanan belum selesai`], ["Pengeluaran tercatat", report.summary.expenseTotal, `${numeric(report.summary.expenseCount)} pengeluaran`], ["Saldo tercatat", report.summary.recordedBalance, "Penjualan selesai − pengeluaran"]];
    const gap = 5, cardWidth = (usable - gap * 3) / 4;
    cards.forEach(([label, value, caption], index) => {
      const x = margin + index * (cardWidth + gap);
      doc.setFillColor(...cream); doc.roundedRect(x, 56, cardWidth, 31, 2, 2, "F");
      doc.setTextColor(94, 82, 75); doc.setFontSize(8); doc.text(label, x + 4, 63);
      doc.setFont("OpenSans", "bold");
      const amount = money(value); doc.setFontSize(14);
      const fontSize = Math.max(8.5, Math.min(14, 14 * (cardWidth - 8) / doc.getTextWidth(amount)));
      doc.setFontSize(fontSize); doc.setTextColor(...wine); doc.text(amount, x + 4, 74);
      doc.setFont("OpenSans", "normal"); doc.setTextColor(108, 94, 83); doc.setFontSize(7); doc.text(caption, x + 4, 82);
    });
    title("Penjualan selesai dan pengeluaran per periode", 100);
    const chartX = margin + 10, chartY = 144, chartWidth = usable - 13, chartHeight = 34;
    const max = Math.max(1, ...report.buckets.flatMap(item => [numeric(item.completedSales), numeric(item.expenseTotal)]));
    doc.setDrawColor(224, 215, 205); doc.setLineWidth(0.25);
    for (let line = 0; line <= 2; line++) doc.line(chartX, chartY - chartHeight * line / 2, chartX + chartWidth, chartY - chartHeight * line / 2);
    const slot = chartWidth / Math.max(1, report.buckets.length);
    const barWidth = Math.min(8, slot * 0.32);
    report.buckets.forEach((item, index) => {
      const x = chartX + slot * index + slot / 2;
      [[item.completedSales, wine, x - barWidth - 0.4], [item.expenseTotal, gold, x + 0.4]].forEach(([amount, fill, left]) => {
        const h = numeric(amount) / max * chartHeight;
        if (h > 0) { doc.setFillColor(...fill); doc.rect(left, chartY - h, barWidth, h, "F"); }
      });
      const interval = report.buckets.length > 14 ? 5 : 1;
      if (index % interval === 0 || index === report.buckets.length - 1) {
        doc.setTextColor(107, 97, 88); doc.setFontSize(6.5);
        const label = report.period.type === "yearly" ? dateLabel(item.date, true).split(" ")[0] : item.date.slice(8);
        doc.text(label, x, chartY + 5, { align: "center" });
      }
    });
    doc.setFontSize(7); doc.setTextColor(107, 97, 88); doc.text("Skala tertinggi " + money(max), chartX, 106);
    doc.setFillColor(...wine); doc.rect(margin, 157, 3, 3, "F"); doc.text("Penjualan selesai", margin + 5, 160);
    doc.setFillColor(...gold); doc.rect(margin + 46, 157, 3, 3, "F"); doc.text("Pengeluaran tercatat", margin + 51, 160);
    doc.setTextColor(83, 74, 66); doc.setFontSize(7.5);
    doc.text(doc.splitTextToSize(meta.basis.slice(0, 3).join(" "), usable), margin, 171, { lineHeightFactor: 1.35 });

    let cursor = height;
    function tablePage(titleText, columns, rows, moneyColumns = [], widths = {}) {
      check(options.signal);
      const required = 17 + Math.min(3, Math.max(1, rows.length)) * 11;
      if (cursor + required > height - 17) { doc.addPage(); header(true); cursor = 38; }
      title(titleText, cursor);
      doc.autoTable({
        startY: cursor + 5, margin: { left: margin, right: margin, top: 43, bottom: 17 },
        head: [columns], body: rows.length ? rows : [[{ content: "Tidak ada data dalam periode ini.", colSpan: columns.length }]],
        styles: { font: "OpenSans", fontSize: 8, cellPadding: 2.4, textColor: [48, 40, 37], overflow: "linebreak", valign: "middle", lineColor: [235, 226, 215], lineWidth: 0.12 },
        headStyles: { fillColor: wine, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 7.5 },
        alternateRowStyles: { fillColor: cream },
        columnStyles: Object.fromEntries(columns.map((_, index) => [index, { ...(moneyColumns.includes(index) ? { halign: "right" } : {}), ...(widths[index] ? { cellWidth: widths[index] } : {}) }])),
        rowPageBreak: "avoid", showHead: "everyPage",
        didDrawPage: hook => { if (hook.pageNumber > 1) { header(true); title(titleText + " · lanjutan", 38); } }
      });
      cursor = doc.lastAutoTable.finalY + 14;
    }
    tablePage("Ringkasan seluruh periode", ["Indikator", "Periode dipilih", "Periode sebelumnya"], FIELDS.map(([key, label, kind]) => [label, kind === "money" ? money(report.summary[key]) : String(numeric(report.summary[key])), kind === "money" ? money(report.previousSummary?.[key]) : String(numeric(report.previousSummary?.[key]))]), [1, 2], { 0: 89, 1: 90, 2: 90 });
    tablePage(report.period.type === "yearly" ? "Rincian bulanan · WIB" : "Rincian harian · WIB", ["Periode", "Penjualan selesai", "Belum selesai", "Dibatalkan", "Pengeluaran", "Saldo tercatat"], report.buckets.map(item => [dateLabel(item.date, report.period.type === "yearly"), money(item.completedSales), money(item.pendingValue), money(item.cancelledValue), money(item.expenseTotal), money(item.recordedBalance)]), [1, 2, 3, 4, 5], { 0: 29, 1: 48, 2: 48, 3: 48, 4: 48, 5: 48 });
    tablePage("Jumlah transaksi per periode", ["Periode", "Selesai", "Belum selesai", "Dibatalkan", "Pesanan aktif", "Seluruh pesanan", "Pengeluaran"], report.buckets.map(item => [dateLabel(item.date, report.period.type === "yearly"), ...["completedCount", "pendingCount", "cancelledCount", "orderCount", "totalOrders", "expenseCount"].map(key => String(numeric(item[key])))]), [1, 2, 3, 4, 5, 6]);
    tablePage("Metode pembayaran", ["Metode pembayaran", "Penjualan selesai", "Pesanan selesai", "Nilai pesanan aktif", "Pesanan aktif"], report.paymentMethods.map(item => [text(item.paymentMethod), money(item.completedSales), String(numeric(item.completedCount)), money(item.orderValue), String(numeric(item.orderCount))]), [1, 2, 3, 4], { 0: 65, 1: 59, 2: 32, 3: 59, 4: 54 });
    tablePage("Kategori pengeluaran", ["Kategori", "Pengeluaran tercatat", "Jumlah pengeluaran"], (report.expenseCategories || []).map(item => [text(CATEGORIES[item.category] || item.category), money(item.total), String(numeric(item.count))]), [1, 2]);
    tablePage("Perbandingan periode", ["Indikator", "Periode dipilih", "Periode sebelumnya", "Selisih", "Perubahan"], sheets(report, meta)[4].rows.map(row => [row[0], money(row[1]), money(row[2]), money(row[3]), typeof row[4] === "number" ? String(row[4]).replace(".", ",") + "%" : row[4]]), [1, 2, 3], { 0: 46, 1: 56, 2: 56, 3: 56, 4: 55 });
    tablePage("Dasar dan cakupan laporan", ["Keterangan", "Nilai"], sheets(report, meta)[5].rows, [], { 0: 48, 1: 221 });
    const total = doc.getNumberOfPages();
    for (let page = 1; page <= total; page++) {
      doc.setPage(page); doc.setDrawColor(224, 215, 205); doc.line(margin, height - 13, width - margin, height - 13);
      doc.setFont("OpenSans", "normal"); doc.setFontSize(7); doc.setTextColor(111, 101, 92);
      doc.text("Dapoer Pasta · Laporan keuangan · WIB", margin, height - 8);
      doc.text(`Halaman ${page} / ${total}`, width - margin, height - 8, { align: "right" });
    }
    check(options.signal);
    return doc.output("blob");
  }

  async function build(report, options = {}) {
    check(options.signal);
    if (!report?.period || !report.summary || !Array.isArray(report.buckets) || !Array.isArray(report.paymentMethods)) throw new Error("Data laporan tidak lengkap. Refresh laporan lalu coba lagi.");
    const builders = { xlsx, ods, pdf };
    const builder = Object.hasOwn(builders, options.format) ? builders[options.format] : null;
    if (!builder) throw new Error("Format unduhan tidak tersedia.");
    const blob = await builder(report, options, metadata(report, options));
    check(options.signal);
    return { blob, extension: options.format, label: { xlsx: "Excel / Google Sheets", ods: "OpenDocument Spreadsheet", pdf: "PDF" }[options.format] };
  }

  window.DapoerFinanceFiles = Object.freeze({ build });
})();
