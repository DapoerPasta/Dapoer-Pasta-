(() => {
  const PERIODS = ["day", "week", "month", "year"];
  const PERIOD_LABELS = { day: "Harian", week: "Mingguan", month: "Bulanan", year: "Tahunan" };
  const SOURCES = { restock: "Penambahan stok", adjustment: "Penyesuaian stok", order: "Pesanan", cancellation: "Pengembalian pesanan", system: "Perubahan sistem" };
  const FORMATS = { pdf: "PDF", xlsx: "Excel", csv: "CSV" };
  const state = { initialized: false, authenticated: false, active: false, period: "month", date: todayWib(), followingToday: true, productId: "", products: new Map(), report: null, dirty: true, snapshotExpired: false, changeVersion: 0, request: null, exporting: null, generation: 0, timer: null };
  const $ = selector => document.querySelector(selector);
  const number = value => Number.isSafeInteger(value) ? value.toLocaleString("id-ID") : "—";

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  function todayWib() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = type => parts.find(part => part.type === type).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "2000-01-01" || value > "2100-12-31") return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function dateLabel(value) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  }
  function timeLabel(value, options = {}) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", ...options }) + " WIB";
  }
  function init() {
    if (state.initialized || !$("#stock-panel-history")) return;
    state.initialized = true;
    ["current", "history"].forEach(tab => {
      const button = $("#stock-tab-" + tab);
      button.addEventListener("click", () => selectTab(tab));
      button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const target = event.key === "Home" ? "current" : event.key === "End" ? "history" : tab === "history" ? "current" : "history";
        selectTab(target);
        $("#stock-tab-" + target).focus();
      });
    });
    document.querySelectorAll("[data-stock-history-period]").forEach(button => button.addEventListener("click", () => selectPeriod(button.dataset.stockHistoryPeriod)));
    $("#stock-history-date").addEventListener("change", () => changeDate($("#stock-history-date").value));
    $("#stock-history-prev").addEventListener("click", () => movePeriod(-1));
    $("#stock-history-next").addEventListener("click", () => movePeriod(1));
    $("#stock-history-today").addEventListener("click", () => changeDate(todayWib()));
    $("#stock-history-product").addEventListener("change", () => { state.productId = $("#stock-history-product").value; resetSelection(); });
    $("#stock-history-refresh").addEventListener("click", resetSelection);
    $("#stock-history-page-prev").addEventListener("click", () => changePage(Math.max(0, (state.report?.pagination.cursor || 0) - (state.report?.pagination.pageSize || 100))));
    $("#stock-history-page-next").addEventListener("click", () => changePage(state.report?.pagination.nextCursor));
    $("#stock-history-export").addEventListener("click", () => exportReport($("#stock-history-export-format").value));
    document.addEventListener("dapoer:admin-session", event => setAuthenticated(!!event.detail?.authenticated));
    document.addEventListener("dapoer:stock-changed", invalidate);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
    updateControls();
    if (window.DapoerAdminAuthenticated) setAuthenticated(true);
  }
  function visible() { return state.authenticated && state.active && !document.hidden && !$("#dashboard-view")?.hidden; }
  function message(value, error = false) { $("#stock-history-message").textContent = value; $("#stock-history-message").classList.toggle("error", error); }
  function cancelWork() {
    state.generation++;
    state.request?.controller.abort();
    state.exporting?.controller.abort();
    state.request = null;
    state.exporting = null;
  }
  function clearReport() {
    state.report = null;
    state.snapshotExpired = false;
    $("#stock-history-report").hidden = true;
    $("#stock-history-state").hidden = false;
    ["summary-body", "body"].forEach(name => $("#stock-history-" + name).replaceChildren());
    ["incoming", "outgoing", "count"].forEach(name => $("#stock-history-" + name).textContent = "—");
    ["coverage", "page-label"].forEach(name => $("#stock-history-" + name).textContent = "");
    $("#stock-history-period-label").textContent = "Riwayat stok";
    $("#stock-history-updated").textContent = "Waktu Indonesia Barat";
  }
  function setAuthenticated(authenticated) {
    if (authenticated && state.authenticated) return;
    state.authenticated = authenticated;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    cancelWork();
    state.dirty = true;
    if (!authenticated) {
      clearReport();
      state.products.clear();
      state.productId = "";
      populateProducts();
      $("#stock-history-state").textContent = "Riwayat akan dimuat setelah login.";
      message("");
      selectTab("current");
    } else {
      if (state.followingToday) state.date = todayWib();
      if (state.active) loadReport();
      state.timer = setInterval(tick, 30000);
    }
    updateControls();
  }
  function expired() {
    setAuthenticated(false);
    document.dispatchEvent(new CustomEvent("dapoer:admin-session-expired"));
  }
  function selectTab(tab) {
    const active = tab === "history";
    if (state.active !== active && !active) {
      if (state.request) state.dirty = true;
      cancelWork();
    }
    state.active = active;
    ["current", "history"].forEach(name => {
      const selected = (name === "history") === active;
      const button = $("#stock-tab-" + name);
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute("tabindex", selected ? "0" : "-1");
      $("#stock-panel-" + name).hidden = !selected;
    });
    $("#refresh-stock").hidden = active;
    if (active) {
      if (state.dirty && visible()) resetSelection();
      else tick();
      if (visible() && !state.report && !state.request) loadReport();
    }
    updateControls();
  }
  function tick() {
    if (!state.authenticated) return;
    if (state.followingToday && state.date !== todayWib()) {
      state.date = todayWib();
      resetSelection();
    } else if (visible() && !state.report && state.dirty && !state.request && !state.exporting) loadReport();
  }
  function invalidate() {
    state.dirty = true;
    state.changeVersion++;
    // Keep the displayed snapshot stable while the admin reads, pages, or exports it.
    if (state.report && !state.exporting) message("Ada perubahan stok. Klik Refresh untuk memperbarui laporan.");
    updateControls();
  }
  function selectPeriod(period) {
    if (!PERIODS.includes(period) || period === state.period) return;
    state.period = period;
    resetSelection();
  }
  function changeDate(date) {
    if (!validDate(date)) { message("Pilih tanggal yang valid antara tahun 2000 dan 2100.", true); updateControls(); return; }
    state.followingToday = date === todayWib();
    if (date === state.date && state.report && !state.dirty) { updateControls(); return; }
    state.date = date;
    resetSelection();
  }
  function movePeriod(direction) {
    const date = new Date(`${state.date}T00:00:00Z`);
    if (state.period === "day" || state.period === "week") date.setUTCDate(date.getUTCDate() + direction * (state.period === "week" ? 7 : 1));
    else {
      const day = date.getUTCDate();
      date.setUTCDate(1);
      if (state.period === "month") date.setUTCMonth(date.getUTCMonth() + direction);
      else date.setUTCFullYear(date.getUTCFullYear() + direction);
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, last));
    }
    changeDate(date.toISOString().slice(0, 10));
  }
  function resetSelection() {
    cancelWork();
    state.dirty = true;
    clearReport();
    message("");
    $("#stock-history-state").textContent = state.authenticated ? "Memuat riwayat stok…" : "Riwayat akan dimuat setelah login.";
    updateControls();
    return loadReport();
  }
  function updateControls() {
    const busy = !!state.request || !!state.exporting;
    const ready = state.authenticated && !!state.report && !state.snapshotExpired && !busy;
    document.querySelectorAll("[data-stock-history-period]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.stockHistoryPeriod === state.period));
      button.disabled = !state.authenticated;
    });
    $("#stock-history-date").value = state.date;
    $("#stock-history-date").disabled = !state.authenticated;
    $("#stock-history-today").setAttribute("aria-pressed", String(state.followingToday));
    ["prev", "next", "today", "product"].forEach(name => $("#stock-history-" + name).disabled = !state.authenticated);
    $("#stock-history-refresh").disabled = !state.authenticated || busy;
    $("#stock-history-refresh").textContent = state.request ? "↻ Memuat…" : "↻ Refresh";
    $("#stock-history-export-format").disabled = !ready;
    $("#stock-history-export").disabled = !ready;
    $("#stock-history-export").textContent = state.exporting ? "Menyiapkan…" : "↓ Unduh laporan";
    const pagination = state.report?.pagination;
    $("#stock-history-page-prev").disabled = !ready || !pagination || pagination.cursor <= 0;
    $("#stock-history-page-next").disabled = !ready || !pagination || pagination.nextCursor === null;
    $("#stock-history-report").setAttribute("aria-busy", String(busy));
  }
  function populateProducts() {
    const select = $("#stock-history-product");
    const all = document.createElement("option"); all.value = ""; all.textContent = "Semua menu";
    const options = Array.from(state.products.values(), product => { const option = document.createElement("option"); option.value = product.id; option.textContent = product.name; return option; });
    select.replaceChildren(all, ...options);
    select.value = state.productId;
  }
  function appendCell(row, text, className = "") {
    const cell = document.createElement("td"); cell.textContent = text;
    if (className) cell.className = className;
    row.append(cell);
    return cell;
  }
  function coverageMessage(report) {
    const coverage = report.coverage;
    if (!coverage.startedAt) return "Pencatatan riwayat stok belum tersedia.";
    const start = timeLabel(coverage.startedAt);
    if (!coverage.available) return `Riwayat direkam sejak ${start}. Saldo untuk periode ini belum tersedia; perubahan sebelum pencatatan dimulai tidak dibuat ulang.`;
    let text = `Riwayat direkam sejak ${start}. `;
    if (coverage.partial) text += "Periode ini hanya mencakup catatan sejak pencatatan dimulai; stok yang sudah ada menjadi saldo awal. ";
    else text += "Saldo awal adalah persediaan sebelum perubahan dalam periode pilihan. ";
    if (coverage.inProgress) text += "Periode masih berjalan; saldo akhir mengikuti waktu laporan dibuat.";
    return text.trim();
  }
  function renderReport(report) {
    report.products.forEach(product => state.products.set(product.id, { id: product.id, name: product.name }));
    populateProducts();
    const period = report.period;
    const range = period.startDate === period.endDate ? dateLabel(period.startDate) : `${dateLabel(period.startDate)} – ${dateLabel(period.endDate)}`;
    $("#stock-history-period-label").textContent = `${PERIOD_LABELS[period.type] || "Riwayat stok"} · ${range}`;
    $("#stock-history-updated").textContent = `Diperbarui ${timeLabel(report.generatedAt)}`;
    $("#stock-history-coverage").textContent = coverageMessage(report);
    $("#stock-history-incoming").textContent = `${number(report.summary.incoming)} unit`;
    $("#stock-history-outgoing").textContent = `${number(report.summary.outgoing)} unit`;
    $("#stock-history-count").textContent = number(report.summary.movementCount);
    const balances = report.products.map(product => {
      const row = document.createElement("tr");
      appendCell(row, product.name);
      appendCell(row, number(product.opening));
      appendCell(row, number(product.incoming), product.incoming ? "stock-history-in" : "");
      appendCell(row, number(product.outgoing), product.outgoing ? "stock-history-out" : "");
      appendCell(row, number(product.closing));
      return row;
    });
    $("#stock-history-summary-body").replaceChildren(...balances);
    const rows = report.movements.map(movement => {
      const row = document.createElement("tr");
      appendCell(row, timeLabel(movement.createdAt));
      appendCell(row, movement.productName);
      appendCell(row, movement.quantityIn ? `+${number(movement.quantityIn)}` : "—", movement.quantityIn ? "stock-history-in" : "");
      appendCell(row, movement.quantityOut ? `−${number(movement.quantityOut)}` : "—", movement.quantityOut ? "stock-history-out" : "");
      appendCell(row, `${number(movement.stockBefore)} → ${number(movement.stockAfter)}`);
      const description = appendCell(row, "");
      const source = document.createElement("span"); source.className = "stock-history-source"; source.textContent = SOURCES[movement.source] || "Perubahan stok";
      const reason = document.createElement("span"); reason.textContent = movement.reason || "—";
      description.append(source, reason);
      if (movement.orderId) { const order = document.createElement("span"); order.className = "stock-history-order"; order.textContent = `Pesanan ${movement.orderId}`; description.append(order); }
      return row;
    });
    if (!rows.length) {
      const row = document.createElement("tr");
      const cell = appendCell(row, report.coverage.available ? "Belum ada perubahan stok dalam periode dan menu pilihan." : "Belum ada catatan stok yang tersedia untuk periode ini.", "stock-history-empty");
      cell.setAttribute("colspan", "6"); rows.push(row);
    }
    $("#stock-history-body").replaceChildren(...rows);
    const page = report.pagination;
    $("#stock-history-page-label").textContent = page.total ? `${number(page.cursor + 1)}–${number(page.cursor + report.movements.length)} dari ${number(page.total)} perubahan` : "0 perubahan";
    $("#stock-history-state").hidden = true;
    $("#stock-history-report").hidden = false;
  }
  function validateReport(report) {
    if (!report || !report.period || !report.coverage || !report.summary || !Array.isArray(report.products) || !Array.isArray(report.movements) || !report.pagination || !Number.isSafeInteger(report.pagination.total) || report.pagination.total < 0 || report.summary.movementCount !== report.pagination.total || typeof report.pagination.snapshot !== "string") throw new Error("Data riwayat belum lengkap. Klik Refresh untuk mencoba lagi.");
    return report;
  }
  async function readReport(params, controller) {
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/admin/stock?${params}`, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
      if (response.status === 401) { const error = new Error("Sesi admin berakhir."); error.sessionExpired = true; throw error; }
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(response.status === 410 || /snapshot.*expired|expired.*snapshot/i.test(data.code || "") ? "Masa laporan ini sudah habis. Klik Refresh lalu unduh kembali." : data.error || "Riwayat stok belum dapat dimuat. Coba Refresh.");
        error.snapshotExpired = response.status === 410 || /snapshot.*expired|expired.*snapshot/i.test(data.code || "");
        if (response.status === 429) {
          const seconds = Number(response.headers?.get("Retry-After"));
          error.retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.min(60, Math.ceil(seconds)) : 60;
        }
        throw error;
      }
      return validateReport(data);
    } finally { clearTimeout(timeout); }
  }
  async function changePage(cursor) {
    if (!state.authenticated || state.request || state.exporting || state.snapshotExpired || !state.report || !Number.isSafeInteger(cursor) || cursor < 0) return;
    return loadReport(cursor);
  }
  async function loadReport(cursor = null) {
    if (!visible() || state.request || state.exporting) return;
    const current = state.report;
    const params = new URLSearchParams({ view: "history" });
    if (cursor !== null && current) { params.set("snapshot", current.pagination.snapshot); params.set("cursor", String(cursor)); }
    else { params.set("period", state.period); params.set("date", state.date); if (state.productId) params.set("productId", state.productId); }
    const request = { controller: new AbortController(), generation: state.generation, changeVersion: state.changeVersion };
    state.request = request;
    updateControls();
    if (!current) $("#stock-history-state").textContent = "Memuat riwayat stok…";
    try {
      const report = await readReport(params, request.controller);
      if (state.request !== request || request.generation !== state.generation || !state.authenticated) return;
      if (cursor !== null && report.pagination.snapshot !== current.pagination.snapshot) throw new Error("Halaman laporan tidak sesuai. Klik Refresh untuk mencoba lagi.");
      state.report = report;
      state.dirty = cursor === null ? request.changeVersion !== state.changeVersion : state.dirty;
      state.snapshotExpired = false;
      renderReport(report);
      message(state.dirty ? "Ada perubahan stok. Klik Refresh untuk memperbarui laporan." : "");
    } catch (error) {
      if (state.request !== request || request.generation !== state.generation) return;
      if (error.sessionExpired) { expired(); return; }
      if (error.snapshotExpired) { state.dirty = true; state.snapshotExpired = true; }
      message(error.name === "AbortError" ? "Koneksi terlalu lama. Klik Refresh untuk mencoba lagi." : ["TypeError", "SyntaxError"].includes(error.name) ? "Koneksi belum tersedia. Klik Refresh untuk mencoba lagi." : error.message, true);
      if (!state.report) $("#stock-history-state").textContent = "Riwayat belum dapat ditampilkan.";
    } finally {
      if (state.request === request) { state.request = null; updateControls(); }
    }
  }
  function waitForRetry(seconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("Unduhan dibatalkan", "AbortError")); return; }
      const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(new DOMException("Unduhan dibatalkan", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, seconds * 1000);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }
  async function readExportPage(params, token) {
    for (let attempt = 0; ; attempt++) {
      try { return await readReport(params, token.controller); }
      catch (error) {
        if (!error.retryAfterSeconds || attempt >= 2 || token.controller.signal.aborted) throw error;
        message(`Laporan sedang disiapkan. Melanjutkan unduhan dalam ${error.retryAfterSeconds} detik…`);
        await waitForRetry(error.retryAfterSeconds, token.controller.signal);
      }
    }
  }
  async function collectReport(report, token) {
    if (report.movements.length === report.pagination.total && report.pagination.cursor === 0) return report;
    const movements = [];
    const ids = new Set();
    let cursor = 0;
    do {
      const params = new URLSearchParams({ view: "history", snapshot: report.pagination.snapshot, cursor: String(cursor), pageSize: "1000" });
      const page = await readExportPage(params, token);
      if (state.exporting !== token || token.generation !== state.generation || !state.authenticated) throw new DOMException("Unduhan dibatalkan", "AbortError");
      if (page.pagination.snapshot !== report.pagination.snapshot || page.pagination.total !== report.pagination.total || page.pagination.cursor !== cursor) throw new Error("Data unduhan tidak sesuai laporan. Klik Refresh lalu coba lagi.");
      page.movements.forEach(movement => {
        const id = String(movement.id);
        if (ids.has(id)) throw new Error("Catatan unduhan terduplikasi. Klik Refresh lalu coba lagi.");
        ids.add(id); movements.push(movement);
      });
      message(`Menyiapkan ${number(movements.length)} dari ${number(report.pagination.total)} catatan…`);
      const next = page.pagination.nextCursor;
      if (next !== null && (!Number.isSafeInteger(next) || next <= cursor || page.movements.length === 0)) throw new Error("Halaman unduhan belum lengkap. Klik Refresh lalu coba lagi.");
      cursor = next;
    } while (cursor !== null);
    if (movements.length !== report.pagination.total) throw new Error("Catatan unduhan belum lengkap. Klik Refresh lalu coba lagi.");
    return { ...report, movements, pagination: { ...report.pagination, cursor: 0, nextCursor: null } };
  }
  async function exportReport(format) {
    if (!state.authenticated || !state.report || state.snapshotExpired || state.request || state.exporting || !Object.hasOwn(FORMATS, format)) return;
    const report = state.report;
    const token = { controller: new AbortController(), generation: state.generation };
    state.exporting = token;
    updateControls();
    message(`Menyiapkan laporan ${FORMATS[format]}…`);
    try {
      if (!window.DapoerStockHistoryFiles?.build) throw new Error("Komponen unduhan belum dimuat. Muat ulang halaman lalu coba lagi.");
      const complete = await collectReport(report, token);
      if (state.exporting !== token || token.generation !== state.generation || !state.authenticated || token.controller.signal.aborted) return;
      const file = await window.DapoerStockHistoryFiles.build(complete, { format, generatedDate: todayWib(), signal: token.controller.signal });
      if (state.exporting !== token || token.generation !== state.generation || !state.authenticated || token.controller.signal.aborted) return;
      if (!(file?.blob instanceof Blob) || file.extension !== format) throw new Error("Berkas laporan belum tersedia. Coba unduh kembali.");
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Dapoer-Pasta-Riwayat-Stok-${report.period.type}-${report.period.startDate}-${report.period.endDate}${state.productId ? `-${state.productId}` : ""}.${file.extension}`;
      document.body.append(link);
      link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message(`Laporan ${file.label || FORMATS[format]} siap diunduh · ${number(complete.summary.movementCount)} catatan lengkap.${state.dirty ? " Ada perubahan stok baru; klik Refresh untuk memperbarui laporan." : ""}`);
    } catch (error) {
      if (state.exporting !== token || token.generation !== state.generation) return;
      if (error.sessionExpired) { expired(); return; }
      if (error.snapshotExpired) { state.dirty = true; state.snapshotExpired = true; }
      message(error.name === "AbortError" ? "Unduhan belum selesai. Coba unduh kembali." : error.message || "Laporan belum dapat diunduh. Coba lagi.", true);
    } finally {
      if (state.exporting === token) { state.exporting = null; updateControls(); }
    }
  }
})();
