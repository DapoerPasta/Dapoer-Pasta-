(() => {
  const POLL_INTERVAL = 10000;
  const MAX_STOCK = 1000000;
  const ACTIONS = ["add", "subtract", "set", "clear"];
  const state = { authenticated: false, products: new Map(), rows: new Map(), timer: null, request: null, generation: 0, saving: null, editing: null, initialized: false };
  const $ = selector => document.querySelector(selector);
  const rupiah = value => `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
  const units = value => value === null ? "—" : `${value.toLocaleString("id-ID")} unit`;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  function init() {
    if (!$("#stock-list")) return;
    $("#refresh-stock").addEventListener("click", () => loadStock(false));
    $("#stock-edit-form").addEventListener("submit", event => { event.preventDefault(); saveStock(); });
    $("#stock-edit-quantity").addEventListener("input", updateEditor);
    ACTIONS.forEach(action => $("#stock-action-" + action).addEventListener("click", () => selectAction(action)));
    $("#stock-edit-cancel").addEventListener("click", closeEditor);
    $("#stock-edit-close").addEventListener("click", closeEditor);
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
    return Number.isSafeInteger(quantity) && quantity >= minimum && quantity <= MAX_STOCK ? quantity : null;
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
      row.manage.disabled = !state.authenticated || !!state.saving;
      row.root.classList.toggle("saving", state.saving?.id === id);
      row.manage.textContent = state.saving?.id === id ? "Menyimpan…" : "Kelola stok";
    });
    updateEditor();
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
    const manage = document.createElement("button"); manage.type = "button"; manage.className = "stock-manage"; manage.textContent = "Kelola stok";
    manage.setAttribute("aria-label", `Kelola stok ${product.name}`);
    manage.setAttribute("aria-haspopup", "dialog");
    manage.setAttribute("aria-controls", "stock-editor");
    manage.addEventListener("click", () => openEditor(product.id));
    root.append(info, current, manage);
    return { root, name, meta, count, status, manage };
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
      row.count.textContent = units(stock);
      row.status.textContent = stock === null ? "Belum diatur" : stock === 0 ? "Habis" : "Tersedia";
      row.status.classList.toggle("unset", stock === null);
      row.status.classList.toggle("empty", stock === 0);
    });
    state.rows.forEach((row, id) => {
      if (!nextIds.has(id)) { row.root.remove(); state.rows.delete(id); state.products.delete(id); }
    });
    let available = 0, empty = 0, unset = 0;
    state.products.forEach(product => {
      const stock = currentStock(product);
      if (stock === null) unset++;
      else if (stock === 0) empty++;
      else available++;
    });
    $("#stock-caption").textContent = `${available} menu tersedia · ${empty} habis${unset ? ` · ${unset} belum diatur` : ""}`;
    updateControls();
  }

  function updatedTime() {
    $("#stock-last-updated").textContent = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " WIB";
  }

  function editorMessage(text, error = false) {
    $("#stock-edit-message").textContent = text;
    $("#stock-edit-message").classList.toggle("error", error);
  }

  function allowedAction(action, stock) {
    return ACTIONS.includes(action) && (action === "add" || (stock !== null && (action === "set" || stock > 0)));
  }

  function openEditor(id, action = "add") {
    if (!state.authenticated || state.saving || !state.products.has(id)) return;
    const product = state.products.get(id);
    const stock = currentStock(product);
    if (!allowedAction(action, stock)) return;
    state.editing = { id, expectedStock: stock, action, conflicted: false, drafts: { add: "", subtract: "", set: stock === null ? "" : String(stock) } };
    $("#stock-edit-name").textContent = product.name;
    $("#stock-edit-title").textContent = "Kelola stok";
    $("#stock-edit-quantity").value = action === "clear" ? "0" : state.editing.drafts[action];
    editorMessage("");
    updateEditor();
    if (!$("#stock-editor").open) $("#stock-editor").showModal();
    focusEditor();
  }

  function selectAction(action) {
    const editing = state.editing;
    if (!editing || state.saving || action === editing.action || !allowedAction(action, currentStock(state.products.get(editing.id)))) return;
    if (editing.action !== "clear") editing.drafts[editing.action] = $("#stock-edit-quantity").value;
    editing.action = action;
    $("#stock-edit-quantity").value = action === "clear" ? "0" : editing.drafts[action];
    if (!editing.conflicted) editorMessage("");
    updateEditor();
    focusEditor();
  }

  function focusEditor() {
    if (state.editing?.action === "clear") $("#stock-edit-cancel").focus();
    else { $("#stock-edit-quantity").focus(); $("#stock-edit-quantity").select(); }
  }

  function closeEditor() {
    if (state.saving) return;
    const editing = state.editing;
    state.editing = null;
    if ($("#stock-editor").open) $("#stock-editor").close();
    editorMessage("");
    if (state.authenticated && editing) state.rows.get(editing.id)?.manage.focus();
  }

  function editorValues() {
    const editing = state.editing;
    const latest = currentStock(state.products.get(editing.id));
    const relative = editing.action === "add" || editing.action === "subtract";
    const before = relative ? latest : editing.expectedStock;
    const quantity = editing.action === "clear" ? 0 : quantityValue($("#stock-edit-quantity"), relative ? 1 : 0);
    let after = quantity;
    if (relative && quantity !== null) after = (latest ?? 0) + (editing.action === "subtract" ? -quantity : quantity);
    const valid = quantity !== null && after >= 0 && after <= MAX_STOCK && allowedAction(editing.action, latest) &&
      (relative || (editing.expectedStock !== null && after !== editing.expectedStock));
    return { relative, before, quantity, after, valid };
  }

  function updateEditor() {
    const editing = state.editing;
    if (!editing) return;
    const busy = !!state.saving;
    const latest = currentStock(state.products.get(editing.id));
    const { relative, before, quantity, after, valid } = editorValues();
    const labels = {
      add: ["Jumlah yang ditambahkan", "Jumlah ini ditambahkan ke stok yang tersedia.", `Maksimal ${(MAX_STOCK - (latest ?? 0)).toLocaleString("id-ID")} unit tambahan.`],
      subtract: ["Jumlah yang dikurangi", "Jumlah ini dikurangi dari stok yang tersedia.", `Maksimal ${(latest ?? 0).toLocaleString("id-ID")} unit pengurangan.`],
      set: ["Jumlah stok akhir", "Masukkan total stok fisik yang benar untuk mengganti jumlah saat ini.", "Isi 0 untuk menandai stok habis. Maksimal 1.000.000 unit."],
      clear: ["", "Seluruh stok menjadi 0. Menu tetap tersimpan dan bisa diisi kembali kapan saja.", ""]
    };
    $("#stock-edit-label").textContent = labels[editing.action][0];
    $("#stock-edit-description").textContent = labels[editing.action][1];
    $("#stock-edit-hint").textContent = labels[editing.action][2];
    $("#stock-edit-before-label").textContent = relative ? "Stok saat ini" : "Stok saat dibuka";
    $("#stock-edit-before").textContent = units(before);
    $("#stock-edit-after").textContent = valid || (quantity !== null && after >= 0 && after <= MAX_STOCK) ? units(after) : "—";
    $("#stock-edit-field").hidden = editing.action === "clear";
    $("#stock-edit-warning").hidden = quantity === null || after !== 0;
    $("#stock-edit-quantity").min = relative ? "1" : "0";
    $("#stock-edit-quantity").max = String(editing.action === "subtract" ? (latest ?? 0) : editing.action === "add" ? MAX_STOCK - (latest ?? 0) : MAX_STOCK);
    $("#stock-edit-quantity").placeholder = relative ? "Masukkan jumlah" : "Jumlah stok akhir";
    $("#stock-edit-quantity").disabled = busy || editing.action === "clear";
    $("#stock-edit-cancel").disabled = busy;
    $("#stock-edit-close").disabled = busy;
    ACTIONS.forEach(action => {
      const button = $("#stock-action-" + action);
      button.disabled = busy || !allowedAction(action, latest);
      button.setAttribute("aria-pressed", String(action === editing.action));
    });
    const save = $("#stock-edit-save");
    save.disabled = !state.authenticated || busy || editing.conflicted || !valid;
    save.textContent = busy ? "Menyimpan…" : ({ add: "Tambah stok", subtract: "Kurangi stok", set: "Simpan jumlah", clear: "Ya, kosongkan stok" })[editing.action];
    save.classList.toggle("danger", editing.action === "clear" || (quantity !== null && after === 0));
    $("#stock-editor").setAttribute("aria-busy", String(busy));
  }

  async function saveStock() {
    if (!state.authenticated || state.saving || !state.editing || state.editing.conflicted) return;
    const editing = state.editing;
    const { relative, quantity, after, valid } = editorValues();
    if (!valid) {
      editorMessage(editing.action === "subtract" && quantity !== null && after < 0 ? "Jumlah pengurangan melebihi stok saat ini." :
        editing.action === "add" && quantity !== null && after > MAX_STOCK ? "Stok akhir tidak boleh melebihi 1.000.000 unit." :
        "Masukkan jumlah bulat sesuai batas yang ditampilkan dan pastikan stok berubah.", true);
      $("#stock-edit-quantity").focus();
      return;
    }
    const payload = relative ? { id: editing.id, delta: editing.action === "subtract" ? -quantity : quantity } :
      { id: editing.id, stock: after, expectedStock: editing.expectedStock };
    cancelRead();
    const mutation = { id: editing.id, generation: state.generation };
    state.saving = mutation;
    editorMessage("");
    updateControls();
    let refresh = false;
    try {
      const response = await fetch("/api/admin/stock", { method: "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (state.saving !== mutation || !state.authenticated || mutation.generation !== state.generation) return;
      if (response.status === 401) { sessionExpired(); return; }
      if (!response.ok) {
        if (data.code === "STOCK_CONFLICT") {
          editing.conflicted = true;
          refresh = true;
          throw new Error("Stok sudah berubah karena pesanan atau penyesuaian lain. Tutup lalu buka Kelola stok kembali untuk memeriksa jumlah terbaru.");
        }
        if (data.code === "INSUFFICIENT_STOCK") refresh = true;
        throw new Error(data.error || "Stok gagal diperbarui.");
      }
      if (!data.product || data.product.id !== editing.id || currentStock(data.product) === null) throw new Error("Hasil perubahan belum dapat dipastikan. Tutup jendela ini dan refresh stok sebelum mencoba lagi.");
      state.products.set(editing.id, data.product);
      renderProducts(Array.from(state.products.values()));
      updatedTime();
      message(relative ? `Stok ${data.product.name} ${editing.action === "add" ? "ditambah" : "dikurangi"} ${quantity} unit. Stok sekarang ${data.product.stock} unit.` :
        data.product.stock === 0 ? `Stok ${data.product.name} dikosongkan. Menu ditandai habis dan bisa diisi kembali.` :
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
})();
