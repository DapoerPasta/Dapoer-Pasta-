(() => {
  "use strict";
  const VENDOR = "/assets/vendor/finance-export/";
  const STATUSES = { baru: "Pesanan Diterima", diproses: "Diproses", dikirim: "Dikirim", selesai: "Selesai", dibatalkan: "Dibatalkan" };
  const scripts = new Map(), fonts = new Map();
  const clean = (value, limit = 500) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
  const money = value => `Rp ${value.toLocaleString("id-ID")}`;
  const invalid = () => { throw new Error("Data nota tidak valid. Muat ulang halaman atau hubungi admin."); };
  const check = signal => { if (signal?.aborted) throw new DOMException("Unduhan dibatalkan.", "AbortError"); };

  function validDay(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00.000Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function normalize(order) {
    if (!order || typeof order !== "object" || typeof order.id !== "string" || !/^[A-Za-z0-9-]{3,80}$/.test(order.id)) invalid();
    const created = new Date(order.createdAt);
    if (typeof order.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(order.createdAt) || !validDay(order.createdAt.slice(0, 10)) || Number.isNaN(created.getTime())) invalid();
    if (!Object.hasOwn(STATUSES, order.status) || !Number.isSafeInteger(order.total) || order.total < 1) invalid();
    if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 100) invalid();
    let sum = 0;
    const items = order.items.map(item => {
      if (!item || typeof item.name !== "string" || !clean(item.name, 300) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(item.price) || item.price < 0 || !Number.isSafeInteger(item.subtotal) || item.subtotal < 0 || item.price * item.quantity !== item.subtotal) invalid();
      sum += item.subtotal;
      if (!Number.isSafeInteger(sum)) invalid();
      return { name: clean(item.name, 300), quantity: item.quantity, price: item.price, subtotal: item.subtotal };
    });
    if (sum !== order.total) invalid();
    const protectedData = order.customerDataProtected !== false;
    const absentQueue = order.queueNumber == null && order.queueDate == null;
    if (!absentQueue && (!Number.isSafeInteger(order.queueNumber) || order.queueNumber < 1 || !validDay(order.queueDate))) invalid();
    return {
      id: order.id, createdAt: created.toISOString(), status: order.status,
      statusLabel: STATUSES[order.status], total: order.total,
      paymentMethod: clean(order.paymentMethod, 100) || "—", items,
      queueNumber: absentQueue ? null : order.queueNumber,
      queueDate: absentQueue ? null : order.queueDate,
      queueLabel: absentQueue ? "Belum tersedia" : "A" + String(order.queueNumber).padStart(3, "0"),
      customerDataProtected: protectedData,
      customerName: protectedData ? "" : clean(order.customerName, 80),
      customerPhone: protectedData ? "" : clean(order.customerPhone, 30),
      address: protectedData ? "" : clean(order.address, 500),
      notes: protectedData ? "" : clean(order.notes, 300)
    };
  }

  function dateLabel(value) {
    return new Date(value + "T00:00:00Z").toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }) + " WIB";
  }

  function createdLabel(value) {
    return new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " WIB";
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

  function loadScript() {
    if (window.jspdf?.jsPDF) return Promise.resolve();
    const name = "jspdf-4.2.1.umd.min.js";
    if (scripts.has(name)) return scripts.get(name);
    const promise = new Promise((resolve, reject) => {
      const element = document.createElement("script");
      const failed = message => { clearTimeout(timeout); element.remove(); scripts.delete(name); reject(new Error(message)); };
      const timeout = setTimeout(() => failed("Pustaka PDF terlalu lama dimuat. Coba lagi."), 30000);
      element.src = VENDOR + name;
      element.async = true;
      element.onload = () => {
        clearTimeout(timeout);
        if (window.jspdf?.jsPDF) resolve();
        else failed("Pustaka PDF belum siap. Coba lagi.");
      };
      element.onerror = () => failed("PDF gagal dimuat. Periksa koneksi lalu coba lagi.");
      document.head.appendChild(element);
    });
    scripts.set(name, promise);
    return promise;
  }

  function loadFont(file) {
    if (fonts.has(file)) return fonts.get(file);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const promise = fetch(VENDOR + file, { cache: "force-cache", credentials: "same-origin", signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Font struk gagal dimuat. Coba lagi."); return response.arrayBuffer(); })
      .then(buffer => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return btoa(binary);
      }).catch(error => { fonts.delete(file); if (controller.signal.aborted) throw new Error("Font struk terlalu lama dimuat. Coba lagi."); throw error; })
      .finally(() => clearTimeout(timeout));
    fonts.set(file, promise);
    return promise;
  }

  async function build(input, options = {}) {
    check(options.signal);
    const order = normalize(input);
    const paper = options.paper || "80";
    if (!["58", "80", "a4"].includes(paper)) throw new Error("Ukuran kertas tidak tersedia.");
    await waitFor(loadScript(), options.signal);
    const [regular, bold] = await waitFor(Promise.all([loadFont("OpenSans-Regular.ttf"), loadFont("OpenSans-Bold.ttf")]), options.signal);
    check(options.signal);
    const width = paper === "a4" ? 210 : Number(paper), margin = paper === "a4" ? 14 : paper === "58" ? 5 : 4;
    const usable = width - margin * 2, thermal = paper !== "a4";
    const createDocument = height => {
      const document = new window.jspdf.jsPDF({ unit: "mm", format: [width, height], orientation: "portrait", compress: true, putOnlyUsedFonts: true });
      document.addFileToVFS("OpenSans-Regular.ttf", regular); document.addFont("OpenSans-Regular.ttf", "ReceiptSans", "normal");
      document.addFileToVFS("OpenSans-Bold.ttf", bold); document.addFont("OpenSans-Bold.ttf", "ReceiptSans", "bold");
      document.setFont("ReceiptSans", "normal"); document.setTextColor(0, 0, 0); document.setDrawColor(0, 0, 0);
      document.setProperties({ title: `Struk ${order.id}`, author: "Dapoer Pasta", creator: "Dapoer Pasta", subject: `Nomor antrean ${order.queueLabel}` });
      return document;
    };
    const measure = createDocument(297), rows = [];
    let y = margin;
    const base = thermal ? 8 : 10;
    function text(value, size = base, boldText = false, align = "left", gap = 1.2) {
      measure.setFont("ReceiptSans", boldText ? "bold" : "normal"); measure.setFontSize(size);
      const lines = measure.splitTextToSize(value, usable);
      const lineHeight = size * .352778 * 1.4;
      rows.push({ type: "text", lines, size, boldText, align, y, height: lines.length * lineHeight });
      y += lines.length * lineHeight + gap;
    }
    function rule() { rows.push({ type: "rule", y: y + .8, height: 2.5 }); y += 2.5; }
    function pair(label, value, boldText = false, size = base) {
      measure.setFont("ReceiptSans", boldText ? "bold" : "normal"); measure.setFontSize(size);
      const leftWidth = usable * .31, rightWidth = usable - leftWidth - 3;
      const left = measure.splitTextToSize(label, leftWidth), right = measure.splitTextToSize(value, rightWidth);
      const height = Math.max(left.length, right.length) * size * .352778 * 1.4;
      rows.push({ type: "pair", left, right, size, boldText, y, height });
      y += height + 1.5;
    }
    function keepTogether(callback) {
      const start = rows.length;
      callback();
      for (let index = start; index < rows.length; index++) rows[index].group = start;
    }
    text("DAPOER PASTA", thermal ? 13 : 20, true, "center", .7);
    text("Cucina Artigianale", base, false, "center", 1);
    text("WhatsApp 0851-7539-1181", thermal ? 7 : 9, false, "center", .6);
    text("@Dapoer.Pasta", thermal ? 7 : 9, false, "center");
    rule(); text("NOMOR ANTREAN", base, true, "center", 1);
    text(order.queueLabel, order.queueNumber == null ? base + 2 : thermal ? 25 : 32, true, "center", 1);
    text(order.queueDate ? dateLabel(order.queueDate) : "Pesanan ini belum memiliki nomor antrean.", thermal ? 7 : 9, false, "center");
    rule(); pair("Order ID", order.id);
    if (!order.customerDataProtected && order.customerName) pair("Pelanggan", order.customerName);
    pair("Tanggal", createdLabel(order.createdAt)); pair("Status", order.statusLabel);
    rule(); text("DETAIL PESANAN", base, true);
    order.items.forEach(item => {
      keepTogether(() => {
        text(item.name, base, true, "left", .4);
        text(`${item.quantity.toLocaleString("id-ID")} × ${money(item.price)}`, base - .5, false, "left", .4);
        text(money(item.subtotal), base, false, "right", 2);
      });
    });
    rule();
    if (thermal) keepTogether(() => { text("TOTAL", base, true, "left", .4); text(money(order.total), base + 1, true, "right", 1.5); });
    else pair("TOTAL", money(order.total), true, base + 1);
    pair("Metode bayar", order.paymentMethod);
    text("Metode pembayaran bukan konfirmasi pembayaran lunas.", thermal ? 6.5 : 8);
    if (!thermal) {
      rule();
      if (order.customerDataProtected) text("Data pelanggan dilindungi. Nota ini menampilkan detail dan status pesanan.", 9);
      else { pair("WhatsApp", order.customerPhone || "—"); pair("Alamat", order.address || "—"); pair("Catatan", order.notes || "Tidak ada"); }
    }
    rule(); text("Terima kasih sudah memesan di Dapoer Pasta.", base, true, "center");
    text("Simpan nota ini sebagai ringkasan dan referensi pesanan Anda.", thermal ? 6.5 : 8, false, "center");
    // Short thermal orders are one continuous page. Large orders are split at
    // complete layout rows, with no content clipped at a printer page edge.
    const limit = thermal ? 1000 : 297, pages = [];
    let pageRows = [], offset = 0;
    function finishPage() {
      if (!pageRows.length) return;
      const last = pageRows[pageRows.length - 1];
      // Fit each roll page to its actual content, including the final page of
      // a long order, so a short tail does not print almost a metre of blank roll.
      const height = thermal ? Math.max(width + 1, Math.ceil(last.y - offset + last.height + margin + 1.2)) : 297;
      pages.push({ rows: pageRows, offset, height }); pageRows = [];
    }
    const blocks = [];
    rows.forEach(row => {
      const previous = blocks[blocks.length - 1];
      if (row.group != null && previous?.group === row.group) previous.rows.push(row);
      else blocks.push({ group: row.group, rows: [row] });
    });
    blocks.forEach(block => {
      const first = block.rows[0], last = block.rows[block.rows.length - 1];
      if (last.y - offset + last.height > limit - margin - 1.2 && pageRows.length) { finishPage(); offset = first.y - margin; }
      pageRows.push(...block.rows);
    });
    finishPage();
    const document = createDocument(pages[0].height);
    pages.forEach((page, index) => {
      if (index) document.addPage([width, page.height], "portrait");
      page.rows.forEach(row => {
        check(options.signal);
        const top = row.y - page.offset;
        if (row.type === "rule") { document.setLineWidth(.15); document.setLineDashPattern([1, .7], 0); document.line(margin, top, width - margin, top); document.setLineDashPattern([], 0); return; }
        document.setFont("ReceiptSans", row.boldText ? "bold" : "normal"); document.setFontSize(row.size);
        const baseline = top + row.size * .352778;
        if (row.type === "pair") {
          document.text(row.left, margin, baseline, { lineHeightFactor: 1.4 });
          document.text(row.right, width - margin, baseline, { align: "right", lineHeightFactor: 1.4 });
        } else document.text(row.lines, row.align === "center" ? width / 2 : row.align === "right" ? width - margin : margin, baseline, { align: row.align, lineHeightFactor: 1.4 });
      });
    });
    check(options.signal);
    return { blob: document.output("blob"), filename: `Struk-${order.id}-${paper === "a4" ? "A4" : paper + "mm"}.pdf`, paper };
  }

  window.DapoerReceiptPrint = Object.freeze({ normalize, build, dateLabel, createdLabel, money });
})();
