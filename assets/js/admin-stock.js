(() => {
  const POLL_INTERVAL = 10000;
  const MAX_ADJUSTMENT = 1000000;
  const state = { authenticated: false, products: new Map(), rows: new Map(), timer: null, request: null, generation: 0, saving: null, editing: null, initialized: false };
  const $ = selector => document.querySelector(selector);
  const rupiah = value => `Rp ${Number(value || 0).toLocaleString("id-ID")}`;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  function init() {
    if (!$("#stock-list")) return;
    $("#refresh-stock").addEventListener("click", () => loadStock(false));
    $("#stock-edit-form").addEventListener("submit", event => { event.preventDefault(); saveExactStock(); });
    $("#stock-edit-quantity").addEventListener("input", updateEditor);
    $("#stock-edit-cancel").addEventListener("click", () => closeEditor());
    $("#stock-edit-close").addEventListener("click", () => closeEditor());
    $("#stock-editor").addEventListener("cancel", event => { event.preventDefault(); closeEditor(); });
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
      closeEditor();
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

  function quantityValue(input, minimum = 1) {
    const value = input.value.trim();
    if (!/^\d+$/.test(value)) return null;
    const quantity = Number(value);
    return Number.isSafeInteger(quantity) && quantity >= minimum && quantity <= MAX_ADJUSTMENT ? quantity : null;
  }

  function adjustment(input) { return quantityValue(input); }

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
      row.edit.disabled = !state.authenticated || !!state.saving || currentStock(state.products.get(id)) === null;
      row.clear.disabled = !state.authenticated || !!state.saving || stock === 0;
      row.root.classList.toggle("saving", state.saving?.id === id);
      row.add.textContent = state.saving?.id === id && state.saving.delta > 0 ? "Menyimpan…" : "+ Tambah";
      row.subtract.textContent = state.saving?.id === id && state.saving.delta < 0 ? "Menyimpan…" : "− Kurangi";
      row.preview.textContent = quantity === null ? "Isi jumlah untuk menambah atau mengurangi stok." :
        `Tambah → ${stock + quantity <= MAX_ADJUSTMENT ? (stock + quantity).toLocaleString("id-ID") : "melebihi batas"} · Kurangi → ${quantity <= stock ? (stock - quantity).toLocaleString("id-ID") : "stok tidak cukup"}`;
    });
    updateEditor();
  }

  function makeRow(product) {
    const root = document.createElement("article"); root.className = "stock-row";
    const info = document.createElement("div");
    const name = document.createElement("h3"); name.className = "stock-product-name";
    const meta = document.createElement("p"); meta.className = "stock-product-meta";
    info.append(name, meta);
    const actions = document.createElement("div"); actions.className = "stock-row-actions";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "stock-edit"; edit.textContent = "Edit stok";
    const clear = document.createElement("button"); clear.type = "button"; clear.className = "stock-clear"; clear.textContent = "Kosongkan";
    edit.setAttribute("aria-label", `Edit stok ${product.name}`);
    clear.setAttribute("aria-label", `Kosongkan stok ${product.name}`);
    edit.addEventListener("click", () => openEditor(product.id));
    clear.addEventListener("click", () => openEditor(product.id, "clear"));
    actions.append(edit, clear); info.append(actions);
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
    const preview = document.createElement("p"); preview.className = "stock-adjustment-preview";
    preview.id = `stock-preview-${product.id}`; input.setAttribute("aria-describedby", preview.id);
    label.htmlFor = input.id; label.textContent = "Jumlah yang ditambah / dikurangi";
    const buttons = document.createElement("div"); buttons.className = "stock-adjustment-controls";
    const add = document.createElement("button"); add.type = "button"; add.className = "stock-add"; add.textContent = "+ Tambah";
    const subtract = document.createElement("button"); subtract.type = "button"; subtract.className = "stock-subtract"; subtract.textContent = "− Kurangi";
    add.setAttribute("aria-label", `Tambah stok ${product.name}`);
    subtract.setAttribute("aria-label", `Kurangi stok ${product.name}`);
    input.addEventListener("input", updateControls);
    add.addEventListener("click", () => adjustStock(product.id, 1));
    subtract.addEventListener("click", () => adjustStock(product.id, -1));
    buttons.append(input, add, subtract); controls.append(label, buttons, preview);
    root.append(info, current, controls);
    return { root, name, meta, count, status, input, add, subtract, edit, clear, preview };
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
      row.meta.textContent = `${rupiah(product.price)} / paket`;
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

  function editorMessage(text, error = false) {
    $("#stock-edit-message").textContent = text;
    $("#stock-edit-message").classList.toggle("error", error);
  }

  function openEditor(id, action = "set") {
    if (!state.authenticated || state.saving || !["set", "clear"].includes(action)) return;
    const product = state.products.get(id);
    const stock = currentStock(product);
    if (stock === null || (action === "clear" && stock === 0)) return;
    state.editing = { id, expectedStock: stock, action, conflicted: false };
    $("#stock-edit-name").textContent = product.name;
    $("#stock-edit-title").textContent = action === "clear" ? "Kosongkan stok?" : "Edit jumlah stok";
    $("#stock-edit-description").textContent = action === "clear" ?
      "Stok menu ini akan menjadi 0. Menu tetap tersimpan dan bisa diisi lagi kapan saja." :
      "Masukkan jumlah stok fisik yang benar. Angka ini akan menggantikan stok saat ini.";
    $("#stock-edit-field").hidden = action === "clear";
    $("#stock-edit-warning").hidden = action !== "clear";
    $("#stock-edit-quantity").value = action === "clear" ? "0" : String(stock);
    editorMessage("");
    updateEditor();
    if (!$("#stock-editor").open) $("#stock-editor").showModal();
    if (action === "clear") $("#stock-edit-cancel").focus();
    else { $("#stock-edit-quantity").focus(); $("#stock-edit-quantity").select(); }
  }

  function closeEditor() {
    if (state.saving) return;
    const editing = state.editing;
    state.editing = null;
    if ($("#stock-editor").open) $("#stock-editor").close();
    editorMessage("");
    if (state.authenticated && editing) {
      const row = state.rows.get(editing.id);
      (editing.action === "clear" ? row?.clear : row?.edit)?.focus();
    }
  }

  function updateEditor() {
    const editing = state.editing;
    if (!editing) return;
    const busy = !!state.saving;
    const quantity = quantityValue($("#stock-edit-quantity"), 0);
    $("#stock-edit-before").textContent = `${editing.expectedStock.toLocaleString("id-ID")} unit`;
    $("#stock-edit-after").textContent = quantity === null ? "—" : `${quantity.toLocaleString("id-ID")} unit`;
    $("#stock-edit-warning").hidden = editing.action !== "clear" && quantity !== 0;
    $("#stock-edit-quantity").disabled = busy;
    $("#stock-edit-cancel").disabled = busy;
    $("#stock-edit-close").disabled = busy;
    const save = $("#stock-edit-save");
    save.disabled = !state.authenticated || busy || editing.conflicted || quantity === null || quantity === editing.expectedStock;
    save.textContent = busy ? "Menyimpan…" : editing.action === "clear" ? "Ya, kosongkan stok" : "Simpan stok";
    save.classList.toggle("danger", editing.action === "clear" || quantity === 0);
    $("#stock-editor").setAttribute("aria-busy", String(busy));
  }

  async function saveExactStock() {
    if (!state.authenticated || state.saving || !state.editing || state.editing.conflicted) return;
    const editing = state.editing;
    const stock = quantityValue($("#stock-edit-quantity"), 0);
    if (stock === null) {
      editorMessage("Masukkan jumlah bulat antara 0 dan 1.000.000.", true);
      $("#stock-edit-quantity").focus();
      return;
    }
    if (stock === editing.expectedStock) { editorMessage("Jumlah stok belum berubah."); return; }
    cancelRead();
    const mutation = { id: editing.id, stock, expectedStock: editing.expectedStock, generation: state.generation };
    state.saving = mutation;
    editorMessage("");
    updateControls();
    let refresh = false;
    try {
      const response = await fetch("/api/admin/stock", {
        method: "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id: editing.id, stock, expectedStock: editing.expectedStock })
      });
      const data = await response.json();
      if (state.saving !== mutation || !state.authenticated || mutation.generation !== state.generation) return;
      if (response.status === 401) { sessionExpired(); return; }
      if (!response.ok) {
        if (data.code === "STOCK_CONFLICT") {
          editing.conflicted = true;
          refresh = true;
          throw new Error("Stok sudah berubah karena pesanan atau penyesuaian lain. Tutup jendela ini, lalu buka Edit stok atau Kosongkan lagi untuk memeriksa jumlah terbaru.");
        }
        throw new Error(data.error || "Stok gagal diperbarui.");
      }
      if (!data.product || data.product.id !== editing.id || currentStock(data.product) === null) {
        throw new Error("Hasil perubahan belum dapat dipastikan. Tutup jendela ini dan refresh stok sebelum mencoba lagi.");
      }
      state.products.set(editing.id, data.product);
      state.rows.get(editing.id).input.value = "";
      renderProducts(Array.from(state.products.values()));
      updatedTime();
      message(data.product.stock === 0 ? `Stok ${data.product.name} dikosongkan. Menu ditandai habis dan bisa diisi kembali.` :
        `Stok ${data.product.name} diperbarui dari ${editing.expectedStock} menjadi ${data.product.stock} unit.`);
      state.saving = null;
      closeEditor();
      updateControls();
    } catch (error) {
      if (state.saving !== mutation) return;
      editorMessage(error.message || "Stok gagal diperbarui. Periksa jumlah terbaru sebelum mencoba lagi.", true);
    } finally {
      if (state.saving === mutation) {
        state.saving = null;
        updateControls();
        if (refresh) await loadStock(true);
      }
    }
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
