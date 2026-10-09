(() => {
  const PERIODS = ["daily", "weekly", "monthly", "yearly"];
  const PERIOD_LABELS = { daily: "Harian", weekly: "Mingguan", monthly: "Bulanan", yearly: "Tahunan" };
  const CATEGORIES = { bahan_baku: "Bahan baku", kemasan: "Kemasan", operasional: "Operasional", transportasi: "Transportasi", pemasaran: "Pemasaran", lainnya: "Lainnya" };
  const MAX_AMOUNT = 1000000000000;
  const state = { authenticated: false, initialized: false, period: "monthly", date: todayWib(), followingToday: true, report: null, request: null, generation: 0, timer: null, expensePage: 1, saving: null, editing: null, exporting: null, refreshQueued: false };
  const $ = selector => document.querySelector(selector);
  const rupiah = value => `Rp ${Number(value).toLocaleString("id-ID")}`;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  function todayWib() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = type => parts.find(part => part.type === type).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  function validCalendarDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function validDate(value) { return validCalendarDate(value) && value >= "2000-01-01" && value <= "2100-12-31"; }

  function dateLabel(value, options = {}) {
    if (!validCalendarDate(value)) return value || "—";
    return new Date(`${value}T00:00:00Z`).toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", ...options });
  }

  function init() {
    if (state.initialized || !$("#finance")) return;
    state.initialized = true;
    document.querySelectorAll("[data-finance-period]").forEach(button => button.addEventListener("click", () => selectPeriod(button.dataset.financePeriod)));
    $("#finance-date").addEventListener("change", () => changeDate($("#finance-date").value));
    $("#finance-prev").addEventListener("click", () => movePeriod(-1));
    $("#finance-next").addEventListener("click", () => movePeriod(1));
    $("#finance-today").addEventListener("click", () => changeDate(todayWib()));
    $("#finance-refresh").addEventListener("click", () => loadReport(false));
    $("#finance-export").addEventListener("click", exportCsv);
    $("#finance-add-expense").addEventListener("click", () => openExpenseEditor());
    $("#finance-expense-prev").addEventListener("click", () => changeExpensePage(state.expensePage - 1));
    $("#finance-expense-next").addEventListener("click", () => changeExpensePage(state.expensePage + 1));
    $("#expense-form").addEventListener("submit", event => { event.preventDefault(); saveExpense(); });
    ["date", "amount", "category", "description"].forEach(name => $("#expense-" + name).addEventListener("input", updateExpenseControls));
    $("#expense-category").addEventListener("change", updateExpenseControls);
    $("#expense-cancel").addEventListener("click", closeExpenseEditor);
    $("#expense-close").addEventListener("click", closeExpenseEditor);
    $("#expense-editor").addEventListener("cancel", event => { event.preventDefault(); closeExpenseEditor(); });
    document.addEventListener("dapoer:admin-session", event => setAuthenticated(!!event.detail?.authenticated));
    document.addEventListener("dapoer:stock-changed", refreshAfterOrderChange);
    document.addEventListener("visibilitychange", () => { if (isVisible()) tick(); });
    updateControls();
    if (window.DapoerAdminAuthenticated) setAuthenticated(true);
  }

  function isVisible() { return state.authenticated && !document.hidden && !!$("#dashboard-view") && !$("#dashboard-view").hidden; }

  function cancelRead() {
    state.generation++;
    state.request?.controller.abort();
    state.request = null;
    state.exporting?.controller.abort();
    state.exporting = null;
  }

  function clearReport() {
    state.report = null;
    $("#finance-report").hidden = true;
    $("#finance-report-state").hidden = false;
    ["chart", "category-list", "breakdown-body", "payment-body", "expense-body"].forEach(name => $("#finance-" + name).replaceChildren());
    ["completed-sales", "pending-sales", "expenses-total", "balance", "completed-count", "pending-count", "expense-count", "sales-comparison", "expenses-comparison", "balance-comparison", "orders-note", "expense-page-label"].forEach(name => $("#finance-" + name).textContent = "—");
    $("#finance-last-updated").textContent = "Waktu Indonesia Barat";
  }

  function setAuthenticated(authenticated) {
    if (authenticated && state.authenticated && state.timer) return;
    state.authenticated = authenticated;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (!authenticated) {
      cancelRead();
      state.saving = null;
      state.refreshQueued = false;
      closeExpenseEditor();
      clearReport();
      $("#finance-report-state").textContent = "Laporan akan dimuat setelah login.";
      message("");
      updateControls();
      return;
    }
    if (state.followingToday) state.date = todayWib();
    loadReport(true);
    state.timer = setInterval(() => { if (isVisible()) tick(); }, 30000);
  }

  function sessionExpired() { setAuthenticated(false); document.dispatchEvent(new CustomEvent("dapoer:admin-session-expired")); }
  function message(value, error = false) { $("#finance-message").textContent = value; $("#finance-message").classList.toggle("error", error); }
  function expenseMessage(value, error = false) { $("#expense-message").textContent = value; $("#expense-message").classList.toggle("error", error); }

  function tick() {
    if (state.followingToday && state.date !== todayWib()) { changeDate(todayWib()); return; }
    loadReport(true);
  }

  function refreshAfterOrderChange() {
    if (!state.authenticated) return;
    if (state.saving) { state.refreshQueued = true; return; }
    cancelRead();
    loadReport(true);
  }

  function selectPeriod(period) {
    if (!PERIODS.includes(period) || period === state.period || state.saving) return;
    state.period = period;
    return resetSelection();
  }

  function changeDate(date) {
    if (state.saving) return;
    if (!validDate(date)) { message("Pilih tanggal yang valid antara tahun 2000 dan 2100.", true); $("#finance-date").value = state.date; return; }
    state.followingToday = date === todayWib();
    if (date === state.date && state.report) { updateControls(); return; }
    state.date = date;
    return resetSelection();
  }

  function movePeriod(direction) {
    const date = new Date(`${state.date}T00:00:00Z`);
    if (state.period === "daily" || state.period === "weekly") date.setUTCDate(date.getUTCDate() + direction * (state.period === "weekly" ? 7 : 1));
    else {
      const day = date.getUTCDate();
      date.setUTCDate(1);
      if (state.period === "monthly") date.setUTCMonth(date.getUTCMonth() + direction);
      else date.setUTCFullYear(date.getUTCFullYear() + direction);
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, last));
    }
    changeDate(date.toISOString().slice(0, 10));
  }

  function resetSelection() {
    cancelRead();
    state.expensePage = 1;
    clearReport();
    message("");
    updateControls();
    return loadReport(false);
  }

  function changeExpensePage(page) {
    if (!state.report || state.request || state.saving || page < 1 || page > state.report.expensePagination.totalPages) return;
    cancelRead();
    state.expensePage = page;
    loadReport(false);
  }

  function updateControls() {
    const busy = !!state.saving;
    $("#finance-date").value = state.date;
    $("#finance-date").disabled = !state.authenticated || busy;
    document.querySelectorAll("[data-finance-period]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.financePeriod === state.period));
      button.disabled = !state.authenticated || busy;
    });
    ["prev", "next", "today"].forEach(name => $("#finance-" + name).disabled = !state.authenticated || busy);
    $("#finance-today").setAttribute("aria-pressed", String(state.followingToday));
    $("#finance-refresh").disabled = !state.authenticated || busy || !!state.request || !!state.exporting;
    $("#finance-refresh").textContent = state.request ? "↻ Memuat…" : "↻ Refresh";
    $("#finance-export").disabled = !state.authenticated || !state.report || busy || !!state.request || !!state.exporting;
    $("#finance-export").textContent = state.exporting ? "Menyiapkan CSV…" : "↓ Unduh laporan CSV";
    $("#finance-add-expense").disabled = !state.authenticated || busy || !!state.exporting;
    $("#finance-report").setAttribute("aria-busy", String(busy || !!state.request));
    const paging = state.report?.expensePagination;
    $("#finance-expense-prev").disabled = !paging || busy || !!state.request || state.expensePage <= 1;
    $("#finance-expense-next").disabled = !paging || busy || !!state.request || !paging.hasMore;
    document.querySelectorAll("[data-expense-action]").forEach(button => button.disabled = busy || !!state.exporting);
    if (!state.report) $("#finance-period-label").textContent = `${PERIOD_LABELS[state.period]} · ${dateLabel(state.date)} · WIB`;
    updateExpenseControls();
  }

  function query(page = state.expensePage, pageSize = 10) { return `/api/admin/finance?period=${encodeURIComponent(state.period)}&date=${encodeURIComponent(state.date)}&expensePage=${page}&expensePageSize=${pageSize}`; }

  function validReport(data) {
    const nonnegative = ["completedSales", "completedCount", "orderValue", "orderCount", "pendingValue", "pendingCount", "cancelledValue", "cancelledCount", "totalOrders", "expenseTotal", "expenseCount"];
    return data?.period?.type === state.period && data.period.date === state.date && data.period.timeZone === "Asia/Jakarta" && validCalendarDate(data.period.startDate) && validCalendarDate(data.period.endDate) && data.period.startDate <= state.date && data.period.endDate >= state.date && data.summary &&
      nonnegative.every(key => Number.isSafeInteger(data.summary[key]) && data.summary[key] >= 0) && Number.isSafeInteger(data.summary.recordedBalance) &&
      Array.isArray(data.buckets) && Array.isArray(data.paymentMethods) && Array.isArray(data.expenses) && data.expensePagination;
  }

  async function loadReport(silent = false) {
    if (!isVisible() || state.request || state.saving || state.exporting) return;
    const request = { controller: new AbortController(), generation: state.generation };
    state.request = request;
    if (!state.report) $("#finance-report-state").textContent = "Memuat laporan keuangan…";
    updateControls();
    try {
      const response = await fetch(query(), { headers: { Accept: "application/json" }, cache: "no-store", signal: request.controller.signal });
      const data = await response.json();
      if (state.request !== request || request.generation !== state.generation || !state.authenticated) return;
      if (response.status === 401) { sessionExpired(); return; }
      if (!response.ok) throw new Error(data.error || "Laporan belum dapat dimuat. Coba refresh kembali.");
      if (!validReport(data)) throw new Error("Data laporan belum lengkap. Refresh setelah deployment selesai.");
      const lastPage = Math.max(1, data.expensePagination.totalPages);
      if (data.expensePagination.page > lastPage) {
        state.expensePage = lastPage;
        state.request = null;
        return await loadReport(silent);
      }
      state.report = data;
      renderReport(data);
      if (!silent || $("#finance-message").classList.contains("error")) message("");
    } catch (error) {
      if (state.request !== request || error.name === "AbortError") return;
      message(error.message || "Laporan belum dapat dimuat.", true);
      if (!state.report) $("#finance-report-state").textContent = "Laporan belum tersedia. Silakan coba refresh.";
    } finally {
      if (state.request === request) { state.request = null; updateControls(); }
    }
  }

  function comparisonText(comparison, report) {
    const running = report.period.startDate <= todayWib() && report.period.endDate >= todayWib();
    if (!comparison || comparison.percent === null) return "Belum ada nilai pembanding di periode sebelumnya." + (running ? " Periode ini masih berjalan." : "");
    const percent = Number(comparison.percent);
    if (!Number.isFinite(percent)) return "Dibanding periode sebelumnya.";
    return `${percent > 0 ? "+" : ""}${percent.toLocaleString("id-ID", { maximumFractionDigits: 1 })}% vs periode sebelumnya${running ? " penuh · periode ini masih berjalan" : ""}`;
  }

  function renderReport(report) {
    const sum = report.summary;
    $("#finance-report").hidden = false;
    $("#finance-report-state").hidden = true;
    $("#finance-period-label").textContent = `${PERIOD_LABELS[state.period]} · ${dateLabel(report.period.startDate)}${report.period.startDate !== report.period.endDate ? " – " + dateLabel(report.period.endDate) : ""} · WIB`;
    $("#finance-last-updated").textContent = "Diperbarui " + new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " WIB · otomatis 30 detik";
    renderAmount("completed-sales", sum.completedSales);
    renderAmount("pending-sales", sum.pendingValue);
    renderAmount("expenses-total", sum.expenseTotal);
    renderAmount("balance", sum.recordedBalance);
    $("#finance-balance").classList.toggle("negative", sum.recordedBalance < 0);
    $("#finance-completed-count").textContent = `${sum.completedCount || 0} pesanan selesai`;
    $("#finance-pending-count").textContent = `${sum.pendingCount || 0} pesanan baru / diproses / dikirim`;
    $("#finance-expense-count").textContent = `${sum.expenseCount || 0} catatan pengeluaran`;
    [ ["sales", "completedSales"], ["expenses", "expenseTotal"], ["balance", "recordedBalance"] ].forEach(([id, key]) => $("#finance-" + id + "-comparison").textContent = comparisonText(report.comparison?.[key], report));
    $("#finance-basis").textContent = "Penjualan mengikuti tanggal pesanan dibuat dan status selesai; bukan konfirmasi pembayaran. Saldo hanya mencakup pengeluaran yang dicatat.";
    $("#finance-orders-note").textContent = `${sum.totalOrders || 0} pesanan · ${sum.cancelledCount || 0} dibatalkan (${rupiah(sum.cancelledValue || 0)}), dikeluarkan dari penjualan`;
    renderChart(report.buckets);
    renderCategories(report.expenseCategories || [], sum.expenseTotal);
    renderBreakdown(report.buckets);
    renderPayments(report.paymentMethods);
    renderExpenses(report.expenses, report.expensePagination);
    updateControls();
  }

  function cell(row, value, className = "") { const item = document.createElement("td"); item.textContent = value; if (className) item.className = className; row.append(item); return item; }
  function renderAmount(name, value) {
    const node = $("#finance-" + name), formatted = rupiah(value);
    node.textContent = formatted;
    node.classList.toggle("finance-long-amount", formatted.length > 16);
    node.classList.toggle("finance-very-long-amount", formatted.length > 21);
  }
  function emptyTable(selector, columns, text) { const row = document.createElement("tr"); const item = cell(row, text, "finance-table-empty"); item.colSpan = columns; $(selector).replaceChildren(row); }

  function renderBreakdown(buckets) {
    $("#finance-breakdown-body").replaceChildren();
    if (!buckets.length) { emptyTable("#finance-breakdown-body", 6, "Belum ada transaksi dalam periode ini."); return; }
    buckets.forEach(bucket => {
      const row = document.createElement("tr");
      cell(row, dateLabel(bucket.date, state.period === "yearly" ? { day: undefined, month: "long" } : {}));
      cell(row, String(bucket.completedCount || 0));
      cell(row, rupiah(bucket.completedSales || 0), "finance-amount");
      cell(row, rupiah(bucket.pendingValue || 0));
      cell(row, rupiah(bucket.expenseTotal || 0));
      cell(row, rupiah(bucket.recordedBalance || 0), bucket.recordedBalance < 0 ? "finance-negative" : "finance-amount");
      $("#finance-breakdown-body").append(row);
    });
  }

  function renderPayments(methods) {
    $("#finance-payment-body").replaceChildren();
    if (!methods.length) { emptyTable("#finance-payment-body", 4, "Belum ada pesanan dalam periode ini."); return; }
    methods.forEach(method => {
      const row = document.createElement("tr");
      cell(row, method.paymentMethod || "Tidak dicatat");
      cell(row, String(method.completedCount || 0));
      cell(row, rupiah(method.completedSales || 0), "finance-amount");
      cell(row, rupiah(method.orderValue || 0));
      $("#finance-payment-body").append(row);
    });
  }

  function categoryLabel(category) { return CATEGORIES[category] || category || "Lainnya"; }
  function renderCategories(categories, total) {
    $("#finance-category-list").replaceChildren();
    if (!categories.length || total === 0) { const empty = document.createElement("p"); empty.className = "finance-category-empty"; empty.textContent = "Belum ada pengeluaran tercatat dalam periode ini."; $("#finance-category-list").append(empty); return; }
    categories.forEach(category => {
      const item = document.createElement("div"); item.className = "finance-category-item";
      const label = document.createElement("div"); const name = document.createElement("span"); name.textContent = categoryLabel(category.category); const amount = document.createElement("strong"); amount.textContent = rupiah(category.total);
      label.append(name, amount);
      const track = document.createElement("div"); track.className = "finance-category-track"; const fill = document.createElement("span"); fill.style.width = Math.max(0, Math.min(100, category.total / total * 100)) + "%"; track.append(fill);
      item.append(label, track); $("#finance-category-list").append(item);
    });
  }

  function svgNode(name, attributes = {}, text = null) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== null) node.textContent = text;
    return node;
  }

  function renderChart(buckets) {
    $("#finance-chart").replaceChildren();
    const maximum = Math.max(0, ...buckets.map(bucket => Math.max(bucket.completedSales || 0, bucket.expenseTotal || 0)));
    if (!maximum) { const empty = document.createElement("div"); empty.className = "finance-chart-empty"; empty.textContent = "Belum ada penjualan selesai atau pengeluaran."; $("#finance-chart").append(empty); $("#finance-chart-caption").textContent = "Nilai tetap tersedia di tabel rincian periode."; return; }
    const svg = svgNode("svg", { viewBox: "0 0 760 250", role: "img", "aria-labelledby": "finance-chart-title finance-chart-description" });
    svg.append(svgNode("title", { id: "finance-chart-title" }, "Penjualan selesai dan pengeluaran per periode"), svgNode("desc", { id: "finance-chart-description" }, "Batang merah menunjukkan penjualan selesai, batang emas menunjukkan pengeluaran. Angka lengkap tersedia pada tabel rincian periode."));
    const left = 72, width = 674, baseline = 206, height = 164, slot = width / buckets.length;
    for (let line = 0; line <= 3; line++) {
      const y = baseline - height * line / 3;
      svg.append(svgNode("line", { x1: left, x2: left + width, y1: y, y2: y, stroke: "#e7ded4", "stroke-width": 1 }));
      const value = maximum * line / 3;
      const label = value >= 1000000 ? (value / 1000000).toLocaleString("id-ID", { maximumFractionDigits: 1 }) + " jt" : value >= 1000 ? (value / 1000).toLocaleString("id-ID", { maximumFractionDigits: 0 }) + " rb" : Math.round(value).toLocaleString("id-ID");
      svg.append(svgNode("text", { x: left - 9, y: y + 4, "text-anchor": "end", fill: "#7d716a", "font-size": 11 }, label));
    }
    buckets.forEach((bucket, index) => {
      const barWidth = Math.max(2, Math.min(18, slot * .3));
      [ [bucket.completedSales || 0, "#6c2220", -barWidth - 1, "Penjualan selesai"], [bucket.expenseTotal || 0, "#cba45f", 1, "Pengeluaran"] ].forEach(([amount, color, offset, name]) => {
        const barHeight = Math.max(0, amount / maximum * height);
        const bar = svgNode("rect", { x: left + slot * (index + .5) + offset, y: baseline - barHeight, width: barWidth, height: barHeight, rx: 2, fill: color });
        bar.append(svgNode("title", {}, `${dateLabel(bucket.date)} · ${name}: ${rupiah(amount)}`)); svg.append(bar);
      });
      const step = Math.max(1, Math.ceil(buckets.length / 8));
      if (index % step === 0 || index === buckets.length - 1) svg.append(svgNode("text", { x: left + slot * (index + .5), y: baseline + 23, "text-anchor": "middle", fill: "#7d716a", "font-size": 11 }, dateLabel(bucket.date, state.period === "yearly" ? { day: undefined, year: undefined, month: "short" } : { year: undefined, month: "short" })));
    });
    $("#finance-chart").append(svg);
    $("#finance-chart-caption").textContent = `Nilai dalam rupiah · ${state.period === "yearly" ? "per bulan" : "per tanggal"} · angka lengkap tersedia di bawah.`;
  }

  function renderExpenses(expenses, pagination) {
    const focusedId = document.activeElement?.getAttribute?.("data-expense-id");
    const focusedAction = document.activeElement?.getAttribute?.("data-expense-action");
    let focusTarget = null;
    $("#finance-expense-body").replaceChildren();
    if (!expenses.length) emptyTable("#finance-expense-body", 4, "Belum ada pengeluaran tercatat. Tambahkan biaya usaha untuk melengkapi laporan.");
    expenses.forEach(expense => {
      const row = document.createElement("tr"); cell(row, dateLabel(expense.date));
      const detail = cell(row, ""); const category = document.createElement("span"); category.className = "finance-expense-category"; category.textContent = categoryLabel(expense.category); const description = document.createElement("span"); description.className = "finance-expense-description"; description.textContent = expense.description;
      detail.append(category, description); cell(row, rupiah(expense.amount), "finance-amount");
      const actions = document.createElement("div"); actions.className = "finance-expense-actions";
      [ ["edit", "Edit"], ["delete", "Hapus"] ].forEach(([action, label]) => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label;
        button.setAttribute("data-expense-action", action); button.setAttribute("data-expense-id", expense.id); button.setAttribute("aria-label", `${label} pengeluaran ${expense.description}`);
        if (focusedId === expense.id && focusedAction === action) focusTarget = button;
        button.addEventListener("click", () => action === "delete" ? deleteExpense(expense) : openExpenseEditor(expense)); actions.append(button);
      });
      cell(row, "").append(actions); $("#finance-expense-body").append(row);
    });
    state.expensePage = pagination.page;
    $("#finance-expense-page-label").textContent = pagination.total ? `Halaman ${pagination.page} dari ${pagination.totalPages} · ${pagination.total} catatan` : "0 catatan pengeluaran";
    if (focusedId) (focusTarget || $("#finance-add-expense")).focus();
  }

  function openExpenseEditor(expense = null, action = "edit") {
    if (!state.authenticated || state.saving || state.exporting) return;
    if (expense && !["edit", "delete"].includes(action)) return;
    const date = state.date <= todayWib() ? state.date : todayWib();
    const snapshot = expense ? { ...expense } : { id: crypto.randomUUID(), date, category: "bahan_baku", description: "", amount: "" };
    state.editing = { action: expense ? action : "add", expense: snapshot, conflicted: false };
    $("#expense-date").value = snapshot.date; $("#expense-date").max = todayWib();
    $("#expense-amount").value = String(snapshot.amount);
    $("#expense-category").value = snapshot.category;
    $("#expense-description").value = snapshot.description;
    const deleting = state.editing.action === "delete";
    $("#expense-editor-title").textContent = deleting ? "Hapus pengeluaran?" : expense ? "Edit pengeluaran" : "Catat pengeluaran";
    $("#expense-editor-description").textContent = deleting ? "Periksa catatan sebelum menghapusnya." : "Catat biaya usaha agar saldo tercatat lebih lengkap.";
    $("#expense-fields").hidden = deleting; $("#expense-delete-warning").hidden = !deleting;
    $("#expense-delete-summary").textContent = deleting ? `${dateLabel(snapshot.date)} · ${categoryLabel(snapshot.category)} · ${rupiah(snapshot.amount)} — ${snapshot.description}` : "";
    expenseMessage(""); updateExpenseControls();
    if (!$("#expense-editor").open) $("#expense-editor").showModal();
    (deleting ? $("#expense-cancel") : $("#expense-amount")).focus();
  }

  function closeExpenseEditor() {
    if (state.saving) return;
    const editing = state.editing;
    state.editing = null;
    if ($("#expense-editor").open) $("#expense-editor").close();
    ["date", "amount", "description"].forEach(name => $("#expense-" + name).value = "");
    $("#expense-delete-summary").textContent = "";
    expenseMessage("");
    if (state.authenticated && editing) {
      const button = Array.from(document.querySelectorAll("[data-expense-action]")).find(item => item.getAttribute("data-expense-id") === editing.expense.id && item.getAttribute("data-expense-action") === (editing.action === "delete" ? "delete" : "edit"));
      (button || $("#finance-add-expense")).focus();
    }
  }

  function deleteExpense(expense) { openExpenseEditor(expense, "delete"); }

  function expenseValues() {
    const date = $("#expense-date").value;
    const rawAmount = $("#expense-amount").value.trim();
    const amount = /^\d+$/.test(rawAmount) ? Number(rawAmount) : NaN;
    const category = $("#expense-category").value;
    const rawDescription = $("#expense-description").value;
    const description = rawDescription.trim();
    const valid = validDate(date) && date <= todayWib() && Number.isSafeInteger(amount) && amount >= 1 && amount <= MAX_AMOUNT && Object.hasOwn(CATEGORIES, category) && description.length >= 1 && description.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(rawDescription);
    return { date, amount, category, description, valid };
  }

  function updateExpenseControls() {
    if (!state.editing) return;
    const busy = !!state.saving;
    $("#expense-date").max = todayWib();
    ["date", "amount", "category", "description"].forEach(name => $("#expense-" + name).disabled = busy || state.editing.action === "delete");
    $("#expense-cancel").disabled = busy; $("#expense-close").disabled = busy;
    const fields = expenseValues(), original = state.editing.expense;
    const unchanged = state.editing.action === "edit" && ["date", "category", "description", "amount"].every(key => fields[key] === original[key]);
    $("#expense-save").disabled = !state.authenticated || busy || state.editing.conflicted || (state.editing.action !== "delete" && (!fields.valid || unchanged));
    $("#expense-save").textContent = busy ? "Menyimpan…" : state.editing.action === "delete" ? "Ya, hapus catatan" : "Simpan pengeluaran";
    $("#expense-save").classList.toggle("danger", state.editing.action === "delete");
    $("#expense-editor").setAttribute("aria-busy", String(busy));
  }

  async function saveExpense() {
    if (!state.authenticated || state.saving || !state.editing || state.editing.conflicted || state.exporting) return;
    const editing = state.editing, fields = expenseValues(), original = editing.expense;
    if (editing.action !== "delete" && !fields.valid) { expenseMessage("Isi tanggal sampai hari ini, jumlah bulat Rp 1–1.000.000.000.000, kategori, dan keterangan satu baris sepanjang 1–200 karakter.", true); return; }
    if (editing.action === "edit" && ["date", "category", "description", "amount"].every(key => fields[key] === original[key])) { expenseMessage("Catatan belum berubah."); return; }
    const method = { add: "POST", edit: "PATCH", delete: "DELETE" }[editing.action];
    const payload = editing.action === "delete" ? { id: original.id, expectedUpdatedAt: original.updatedAt } :
      { id: original.id, date: fields.date, amount: fields.amount, category: fields.category, description: fields.description, ...(editing.action === "edit" ? { expectedUpdatedAt: original.updatedAt } : {}) };
    cancelRead();
    const mutation = { generation: state.generation }; state.saving = mutation;
    expenseMessage(""); updateControls();
    let refresh = false;
    try {
      const response = await fetch("/api/admin/finance", { method, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (state.saving !== mutation || !state.authenticated || mutation.generation !== state.generation) return;
      if (response.status === 401) { sessionExpired(); return; }
      if (!response.ok) {
        if (data.code === "EXPENSE_CONFLICT" || data.code === "EXPENSE_NOT_FOUND") { editing.conflicted = true; refresh = true; throw new Error("Catatan sudah berubah atau dihapus. Tutup lalu buka catatan terbaru sebelum menyimpan kembali."); }
        throw new Error(data.error || "Pengeluaran belum dapat disimpan.");
      }
      if (editing.action === "delete" ? data.deleted !== true || data.id !== original.id : !data.expense || data.expense.id !== original.id) throw new Error("Hasil penyimpanan belum dapat dipastikan. Periksa laporan sebelum mencoba kembali.");
      state.saving = null;
      updateControls();
      closeExpenseEditor();
      message(editing.action === "delete" ? "Catatan pengeluaran dihapus." : editing.action === "edit" ? "Catatan pengeluaran diperbarui." : "Pengeluaran berhasil dicatat.");
      updateControls();
      state.refreshQueued = false;
      await loadReport(true);
    } catch (error) {
      if (state.saving !== mutation) return;
      expenseMessage(error.message || "Pengeluaran belum dapat disimpan. Coba kembali.", true);
    } finally {
      if (state.saving === mutation) {
        state.saving = null;
        updateControls();
        if (refresh || state.refreshQueued) { state.refreshQueued = false; await loadReport(true); }
      }
    }
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[\s\uFEFF]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function csvRows(report) {
    const summary = report.summary;
    const rows = [ ["Laporan Keuangan Dapoer Pasta"], ["Periode", PERIOD_LABELS[state.period], report.period.startDate, report.period.endDate, "WIB"], ["Basis", "Penjualan selesai menurut tanggal pesanan dibuat, bukan konfirmasi pembayaran; saldo hanya dikurangi pengeluaran tercatat."], [], ["Ringkasan", "Jumlah (Rp)", "Jumlah catatan"], ["Penjualan selesai", summary.completedSales, summary.completedCount], ["Pesanan belum selesai", summary.pendingValue, summary.pendingCount], ["Pengeluaran tercatat", summary.expenseTotal, summary.expenseCount], ["Saldo tercatat", summary.recordedBalance], ["Dibatalkan (di luar penjualan)", summary.cancelledValue, summary.cancelledCount], [], ["Tanggal WIB", "Pesanan selesai", "Penjualan selesai (Rp)", "Belum selesai (Rp)", "Pengeluaran (Rp)", "Saldo tercatat (Rp)"] ];
    report.buckets.forEach(bucket => rows.push([bucket.date, bucket.completedCount, bucket.completedSales, bucket.pendingValue, bucket.expenseTotal, bucket.recordedBalance]));
    rows.push([], ["Metode pembayaran", "Pesanan selesai", "Penjualan selesai (Rp)", "Nilai pesanan aktif (Rp)"]);
    report.paymentMethods.forEach(method => rows.push([method.paymentMethod, method.completedCount, method.completedSales, method.orderValue]));
    rows.push([], ["Kategori pengeluaran", "Jumlah (Rp)", "Jumlah catatan"]);
    (report.expenseCategories || []).forEach(category => rows.push([categoryLabel(category.category), category.total, category.count]));
    rows.push([], ["Pembanding", report.previousPeriod?.startDate || "", report.previousPeriod?.endDate || ""], ["Ukuran", "Periode ini (Rp)", "Periode sebelumnya (Rp)", "Selisih (Rp)", "Perubahan (%)"]);
    [["Penjualan selesai", "completedSales"], ["Pengeluaran tercatat", "expenseTotal"], ["Saldo tercatat", "recordedBalance"]].forEach(([label, key]) => rows.push([label, summary[key], report.previousSummary?.[key] ?? "", report.comparison?.[key]?.difference ?? "", report.comparison?.[key]?.percent ?? "Belum ada pembanding"]));
    rows.push([], ["Cakupan", "Seluruh transaksi periode pilihan; rincian catatan pengeluaran tersedia di dashboard."], ["Tanggal unduhan WIB", todayWib()]);
    return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  async function exportCsv() {
    if (!state.authenticated || !state.report || state.request || state.saving || state.exporting) return;
    const token = { controller: new AbortController(), generation: state.generation };
    state.exporting = token; updateControls();
    try {
      const response = await fetch(query(1, 10), { headers: { Accept: "application/json" }, cache: "no-store", signal: token.controller.signal });
      const report = await response.json();
      if (state.exporting !== token || token.generation !== state.generation || !state.authenticated) return;
      if (response.status === 401) { sessionExpired(); return; }
      if (!response.ok) throw new Error(report.error || "CSV belum dapat disiapkan.");
      if (!validReport(report)) throw new Error("Data ekspor belum lengkap. Refresh laporan dahulu.");
      if (state.exporting !== token || !state.authenticated || token.generation !== state.generation) return;
      const url = URL.createObjectURL(new Blob([csvRows(report)], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `laporan-keuangan-${state.period}-${report.period.startDate}-${report.period.endDate}.csv`;
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      message("Laporan CSV seluruh periode berhasil diunduh.");
    } catch (error) {
      if (state.exporting !== token || error.name === "AbortError") return;
      message(error.message || "CSV belum dapat disiapkan. Coba kembali.", true);
    } finally { if (state.exporting === token) { state.exporting = null; updateControls(); } }
  }
})();
