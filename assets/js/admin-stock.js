(() => {
  const POLL_INTERVAL = 10000;
  const MAX_ADJUSTMENT = 1000000;
  const state = { authenticated: false, products: new Map(), rows: new Map(), timer: null, request: null, generation: 0, saving: null, initialized: false };
  const $ = selector => document.querySelector(selector);
  const rupiah = value => `Rp ${Number(value || 0).toLocaleString("id-ID")}`;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  function init() {
    if (!$("#stock-list")) return;
    $("#refresh-stock").addEventListener("click", () => loadStock(false));
    document.addEventListener("dapoer:admin-session", event => setAuthenticated(!!event.detail?.authenticated));
    document.addEventListener("dapoer:stock-changed", () => loadStock(true));
    document.addEventListener("visibilitychange", () => { if (isVisible()) loadStock(true); });
    if (window.DapoerAdminAuthenticated) setAuthenticated(true);
  }

  function isVisible() {
    return state.authenticated && !document.hidden && !!$("#dashboard-view") && !$("#dashboard-view").hidden;
  }

  function cancelRead() {
    state.generation++;
    if (state.request) state.request.controller.abort();
    state.request = null;
  }

  function setAuthenticated(authenticated) {
    state.authenticated = authenticated;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (!authenticated) {
      cancelRead();
      state.saving = null;
      state.products.clear();
      state.rows.clear();
      state.initialized = false;
      $("#stock-list").replaceChildren();
      $("#stock-caption").textContent = "Stok akan dimuat setelah login.";
      $("#stock-last-updated").textContent = "—";
      message("");
      updateControls();
      return;
    }
    loadStock(true);
    state.timer = setInterval(() => { if (isVisible()) loadStock(true); }, POLL_INTERVAL);
  }

  function sessionExpired() {
    setAuthenticated(false);
    document.dispatchEvent(new CustomEvent("dapoer:admin-session-expired"));
  }

  function message(text, error = false) {
    $("#stock-message").textContent = text;
    $("#stock-message").classList.toggle("error", error);
  }

  function adjustment(input) {
    const value = input.value.trim();
    if (!/^\d+$/.test(value)) return null;
    const quantity = Number(value);
    return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= MAX_ADJUSTMENT ? quantity : null;
  }

  function currentStock(product) {
    return Number.isSafeInteger(product?.stock) && product.stock >= 0 ? product.stock : null;
  }

  function updateControls() {
    const busy = !!state.request || !!state.saving;
    $("#refresh-stock").disabled = !state.authenticated || busy;
    $("#refresh-stock").textContent = state.request && !state.request.silent ? "↻ Memuat…" : "↻ Refresh stok";
    $("#stock-list").setAttribute("aria-busy", String(busy));
    state.rows.forEach((row, id) => {
      const quantity = adjustment(row.input);
      const stock = currentStock(state.products.get(id)) ?? 0;
      row.input.disabled = !state.authenticated || !!state.saving;
      row.add.disabled = !state.authenticated || !!state.saving || quantity === null || stock + quantity > MAX_ADJUSTMENT;
      row.subtract.disabled = !state.authenticated || !!state.saving || quantity === null || quantity > stock;
      row.root.classList.toggle("saving", state.saving?.id === id);
      row.add.textContent = state.saving?.id === id && state.saving.delta > 0 ? "Menyimpan…" : "+ Tambah";
      row.subtract.textContent = state.saving?.id === id && state.saving.delta < 0 ? "Menyimpan…" : "− Kurangi";
    });
  }

  function makeRow(product) {
    const root = document.createElement("article"); root.className = "stock-row";
    const info = document.createElement("div");
    const name = document.createElement("h3"); name.className = "stock-product-name";
    const meta = document.createElement("p"); meta.className = "stock-product-meta";
    info.append(name, meta);
    const current = document.createElement("div"); current.className = "stock-current";
    const count = document.createElement("span"); count.className = "stock-count";
    const status = document.createElement("span"); status.className = "stock-status";
    current.append(count, status);
    const controls = document.createElement("div"); controls.className = "stock-adjustment";
    const label = document.createElement("label"); label.className = "stock-adjustment-label";
    const input = document.createElement("input");
    input.id = `stock-adjust-${product.id}`; input.type = "number"; input.min = "1"; input.max = String(MAX_ADJUSTMENT); input.step = "1";
    input.inputMode = "numeric"; input.placeholder = "Jumlah";
    input.setAttribute("aria-label", `Jumlah penyesuaian stok ${product.name}`);
    label.htmlFor = input.id; label.textContent = "Jumlah yang ditambah / dikurangi";
    const buttons = document.createElement("div"); buttons.className = "stock-adjustment-controls";
    const add = document.createElement("button"); add.type = "button"; add.className = "stock-add"; add.textContent = "+ Tambah";
    const subtract = document.createElement("button"); subtract.type = "button"; subtract.className = "stock-subtract"; subtract.textContent = "− Kurangi";
    add.setAttribute("aria-label", `Tambah stok ${product.name}`);
    subtract.setAttribute("aria-label", `Kurangi stok ${product.name}`);
    input.addEventListener("input", updateControls);
    add.addEventListener("click", () => adjustStock(product.id, 1));
    subtract.addEventListener("click", () => adjustStock(product.id, -1));
    buttons.append(input, add, subtract); controls.append(label, buttons);
    root.append(info, current, controls);
    return { root, name, meta, count, status, input, add, subtract };
  }

  function renderProducts(products) {
    const nextIds = new Set();
    products.forEach(product => {
      if (!product || typeof product.id !== "string") return;
      nextIds.add(product.id);
      state.products.set(product.id, product);
      let row = state.rows.get(product.id);
      if (!row) {
        row = makeRow(product);
        state.rows.set(product.id, row);
        $("#stock-list").append(row.root);
      }
      const stock = currentStock(product);
      row.name.textContent = product.name;
      row.meta.textContent = rupiah(product.price);
      row.count.textContent = stock === null ? "—" : `${stock.toLocaleString("id-ID")} unit`;
      row.status.textContent = stock === null ? "Belum diatur" : stock === 0 ? "Habis" : "Tersedia";
      row.status.classList.toggle("unset", stock === null);
      row.status.classList.toggle("empty", stock === 0);
    });
    state.rows.forEach((row, id) => {
      if (!nextIds.has(id)) { row.root.remove(); state.rows.delete(id); state.products.delete(id); }
    });
    updateCaption();
    updateControls();
  }

  function updateCaption() {
    let available = 0, empty = 0, unset = 0;
    state.products.forEach(product => {
      const stock = currentStock(product);
      if (stock === null) unset++;
      else if (stock === 0) empty++;
      else available++;
    });
    $("#stock-caption").textContent = `${available} menu tersedia · ${empty} habis${unset ? ` · ${unset} belum diatur` : ""}`;
  }

  function updatedTime() {
    $("#stock-last-updated").textContent = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " WIB";
  }

  async function loadStock(silent = false) {
    if (!isVisible() || state.request || state.saving) return;
    const request = { controller: new AbortController(), generation: state.generation, silent };
    state.request = request;
    updateControls();
    if (!state.initialized) $("#stock-caption").textContent = "Memuat stok menu…";
    try {
      const response = await fetch("/api/admin/stock", { headers: { Accept: "application/json" }, cache: "no-store", signal: request.controller.signal });
      const data = await response.json();
      if (state.request !== request || request.generation !== state.generation) return;
      if (response.status === 401) { sessionExpired(); return; }
      if (!response.ok) throw new Error(data.error || "Stok belum dapat dimuat. Coba refresh stok.");
      if (!Array.isArray(data.products)) throw new Error("Data stok belum tersedia. Coba refresh setelah deployment selesai.");
      renderProducts(data.products);
      state.initialized = true;
      updatedTime();
      if (!silent || $("#stock-message").classList.contains("error")) message("");
    } catch (error) {
      if (state.request !== request || error.name === "AbortError") return;
      message(error.message || "Stok belum dapat dimuat. Coba refresh stok.", true);
      if (!state.initialized) $("#stock-caption").textContent = "Stok belum tersedia.";
    } finally {
      if (state.request === request) { state.request = null; updateControls(); }
    }
  }

  async function adjustStock(id, direction) {
    if (!state.authenticated || state.saving) return;
    const row = state.rows.get(id);
    if (!row) return;
    const quantity = adjustment(row.input);
    if (quantity === null) { message("Masukkan jumlah bulat antara 1 dan 1.000.000.", true); row.input.focus(); return; }
    const delta = quantity * direction;
    if (direction !== 1 && direction !== -1) return;
    if (delta < 0 && quantity > (currentStock(state.products.get(id)) ?? 0)) { message("Jumlah pengurangan melebihi stok saat ini. Refresh stok untuk memeriksa jumlah terbaru.", true); return; }
    cancelRead();
    const mutation = { id, delta, generation: state.generation };
    state.saving = mutation;
    message("");
    updateControls();
    try {
      const response = await fetch("/api/admin/stock", { method: "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ id, delta }) });
      const data = await response.json();
      if (state.saving !== mutation || !state.authenticated || mutation.generation !== state.generation) return;
      if (response.status === 401) { sessionExpired(); return; }
      if (!response.ok) throw new Error(data.error || "Stok gagal diperbarui.");
      if (!data.product || data.product.id !== id || currentStock(data.product) === null) throw new Error("Hasil perubahan stok belum tersedia. Refresh stok sebelum mencoba lagi.");
      state.products.set(id, data.product);
      row.input.value = "";
      renderProducts(Array.from(state.products.values()));
      updatedTime();
      message(`Stok ${data.product.name} ${delta > 0 ? "ditambah" : "dikurangi"} ${quantity} unit. Stok sekarang ${data.product.stock} unit.`);
    } catch (error) {
      if (state.saving !== mutation) return;
      message(error.message || "Stok gagal diperbarui. Refresh stok untuk memastikan jumlah terbaru.", true);
    } finally {
      if (state.saving === mutation) {
        state.saving = null;
        updateControls();
      }
    }
  }
})();
