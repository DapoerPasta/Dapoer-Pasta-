(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const amount = value => `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
  const KEY = "dapoer-order-addition-v1", MAX_AGE = 24 * 60 * 60 * 1000;
  const params = new URLSearchParams(location.search), id = params.get("id") || "", token = params.get("token") || "";
  const identity = /^[A-Za-z0-9-]{3,80}$/.test(id) && /^[a-f0-9]{48}$/i.test(token);
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  const safeItem = item => item && typeof item.id === "string" && /^[a-z0-9-]{1,80}$/.test(item.id) && Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 999;
  let initialized = false, order = null, verified = false, open = false, hashHandled = false, busy = false, catalogBusy = null, menuReady = false, menu = [], intent = null, rows = new Map(), selected = new Map();
  function validIntent(value) {
    return value?.id === id && value.token === token && uuid(value.requestId) && Number.isFinite(value.savedAt) && value.savedAt <= Date.now() + 60000 && Date.now() - value.savedAt < MAX_AGE
      && Number.isSafeInteger(value.expectedTotal) && value.expectedTotal > 0 && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 20 && value.items.every(safeItem) && new Set(value.items.map(item => item.id)).size === value.items.length;
  }
  function readIntent() {
    if (intent && validIntent(intent)) return intent;
    intent = null;
    try { const value = JSON.parse(sessionStorage.getItem(KEY) || "null"); if (validIntent(value)) intent = { id, token, requestId: value.requestId, items: value.items.map(item => ({ id: item.id, quantity: item.quantity })), expectedTotal: value.expectedTotal, savedAt: value.savedAt }; else if (value?.id === id && value.token === token) sessionStorage.removeItem(KEY); } catch {}
    return intent;
  }
  function storeIntent(value) { intent = value; try { sessionStorage.setItem(KEY, JSON.stringify(value)); } catch {} }
  function clearIntent(requestId) {
    if (intent?.requestId === requestId) intent = null;
    try { const stored = JSON.parse(sessionStorage.getItem(KEY) || "null"); if (stored?.requestId === requestId && stored.id === id && stored.token === token) sessionStorage.removeItem(KEY); } catch {}
  }
  function additions() { return Array.isArray(order?.additions) ? order.additions : []; }
  function pending() { return additions().some(addition => addition?.status === "pending"); }
  function allowed() { return verified && order?.canAddItems !== false && ["baru", "diproses"].includes(order?.status) && !pending() && additions().length < 100; }
  function validSnapshot(value) {
    return value?.id === id && ["baru", "diproses", "dikirim", "selesai", "dibatalkan"].includes(value.status)
      && Number.isSafeInteger(value.total) && value.total > 0 && typeof value.updatedAt === "string" && Number.isFinite(new Date(value.updatedAt).getTime())
      && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 100
      && value.items.every(item => item && typeof item.name === "string" && item.name.trim() && Number.isSafeInteger(item.quantity) && item.quantity > 0 && Number.isSafeInteger(item.subtotal) && item.subtotal >= 0)
      && (value.canAddItems === undefined || typeof value.canAddItems === "boolean")
      && !!window.DapoerOrderRecovery?.billing(value)
      && window.DapoerOrderRecovery?.validAdditions?.(value.additions) !== false;
  }
  function notice(message, error = false) {
    const node = $("#addition-notice"); if (!node) return;
    node.textContent = message || ""; node.hidden = !message; node.classList.toggle("is-error", error);
  }
  function selectedItems() { return [...selected].filter(([, quantity]) => quantity > 0).map(([id, quantity]) => ({ id, quantity })).sort((a, b) => a.id.localeCompare(b.id)); }
  function subtotal(items = selectedItems()) { return items.reduce((sum, item) => sum + (menu.find(product => product.id === item.id)?.price || 0) * item.quantity, 0); }
  function safeSelection(items = selectedItems()) { const total = subtotal(items); return items.length > 0 && items.length <= 20 && Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger((order?.total || 0) + total) && items.every(item => safeItem(item) && menu.some(product => product.id === item.id && product.stock >= item.quantity)); }
  function renderControls() {
    if (!initialized) return;
    const unknown = !!readIntent(), canEdit = allowed() && !busy && !unknown;
    $("#track-add-menu").hidden = !verified || order?.canAddItems === false || !["baru", "diproses"].includes(order?.status) || pending() || additions().length >= 100;
    $("#track-add-menu").disabled = !verified || busy;
    $("#track-add-menu").setAttribute("aria-expanded", String(open));
    $("#tambah-menu").hidden = !open;
    $("#addition-form").setAttribute("aria-busy", String(busy || !!catalogBusy));
    $("#addition-submit").hidden = unknown;
    $("#addition-submit").disabled = !canEdit || !menuReady || !!catalogBusy || !safeSelection();
    $("#addition-submit").textContent = busy ? "Menyimpan tambahan…" : order?.status === "diproses" ? "Ajukan Tambahan ke Admin" : "Tambahkan ke Pesanan";
    $("#addition-retry").hidden = !unknown;
    $("#addition-retry").disabled = busy || !verified || navigator.onLine === false;
    $("#addition-refresh").disabled = busy || !!catalogBusy || unknown;
    $("#addition-refresh").textContent = catalogBusy ? "Memuat menu…" : "Perbarui stok";
    $("#addition-close").disabled = busy;
    $("#addition-description").textContent = order?.status === "diproses"
      ? "Pesanan sedang disiapkan. Tambahan perlu disetujui admin. Stok belum dipesan dan subtotal tambahan belum masuk tagihan sebelum disetujui."
      : "Tambahkan menu tanpa mengisi formulir lagi. Nomor pesanan dan antrean tetap sama. Stok serta total diperbarui setelah tambahan berhasil disimpan.";
    $("#addition-current-total").textContent = amount(order?.total);
    $("#addition-subtotal").textContent = amount(unknown ? intent.expectedTotal : subtotal());
    const charges = window.DapoerOrderRecovery?.billing(order);
    $("#addition-combined-label").textContent = `${order?.status === "diproses" ? "Perkiraan total jika disetujui" : "Total setelah ditambah"}${charges && !charges.shippingConfirmed ? " (belum ongkir)" : ""}`;
    $("#addition-combined-total").textContent = amount((order?.total || 0) + (unknown ? intent.expectedTotal : subtotal()));
    if ($("#addition-shipping-note")) $("#addition-shipping-note").textContent = charges?.deliveryMethod === "pickup" ? "Ambil sendiri · tanpa ongkir. Pembayaran tetap dikonfirmasi admin." : charges?.shippingConfirmed ? `Sudah termasuk ongkir ${amount(charges.shippingFee)}; ongkir dihitung satu kali. Pembayaran tetap dikonfirmasi admin.` : "Ongkir menunggu konfirmasi admin dan belum masuk perkiraan total. Pembayaran tetap dikonfirmasi admin.";
    for (const [productId, row] of rows) {
      const product = menu.find(item => item.id === productId), quantity = selected.get(productId) || 0;
      row.minus.disabled = !canEdit || !quantity;
      row.plus.disabled = !canEdit || !menuReady || !product || quantity >= Math.min(product.stock, 999);
      row.input.disabled = !canEdit || !menuReady;
      row.input.max = String(Math.min(product?.stock || 0, 999));
      if (document.activeElement !== row.input) row.input.value = String(quantity);
      row.stock.textContent = menuReady ? product?.stock ? `Stok ${product.stock} paket` : "Stok habis" : "Stok belum dapat diperiksa";
    }
  }
  function renderHistory() {
    const history = $("#addition-history"); if (!history) return;
    const records = additions().filter(addition => addition && uuid(addition.id) && ["applied", "pending", "approved", "rejected", "expired"].includes(addition.status) && Array.isArray(addition.items) && Number.isSafeInteger(addition.total) && addition.total > 0);
    history.hidden = !records.length;
    const signature = JSON.stringify(records);
    if (history.dataset.signature === signature) return;
    history.dataset.signature = signature;
    const list = $("#addition-history-items"); list.replaceChildren();
    for (const addition of records) {
      const row = document.createElement("article"); row.className = `addition-history-item addition-${addition.status}`;
      const label = document.createElement("strong"); label.textContent = ({ applied: "Tambahan sudah masuk pesanan", pending: "Menunggu persetujuan admin", approved: "Tambahan disetujui", rejected: "Tambahan tidak disetujui", expired: "Permintaan tambahan berakhir" })[addition.status];
      const items = document.createElement("p"); items.textContent = addition.items.filter(item => typeof item?.name === "string" && Number.isSafeInteger(item.quantity)).map(item => `${item.name} × ${item.quantity}`).join(" · ");
      const total = document.createElement("span"); total.textContent = `${amount(addition.total)}${addition.status === "pending" ? " · belum masuk total dan belum perlu dibayar" : ["rejected", "expired"].includes(addition.status) ? " · tidak ditagihkan" : " · sudah termasuk total pesanan"}`;
      row.append(label, items, total); list.append(row);
    }
  }
  function update(next) {
    if (!validSnapshot(next)) { unavailable(); return; }
    if (order && window.DapoerOrderRecovery.compareUpdatedAt(next.updatedAt, order.updatedAt) < 0) return;
    order = next; verified = true;
    if (!initialized) return;
    const recovered = readIntent(), known = recovered && additions().find(addition => addition.id === recovered.requestId);
    if (known) {
      clearIntent(recovered.requestId); selected.clear();
      notice(known.status === "pending" ? "Permintaan tambahan sudah tercatat dan menunggu persetujuan admin. Tidak perlu mengirim ulang." : ["applied", "approved"].includes(known.status) ? "Tambahan sudah tersimpan pada pesanan yang sama. Tidak ada pesanan baru." : "Permintaan tambahan sudah ditangani. Periksa riwayat tambahan di bawah.");
    }
    renderHistory(); renderControls();
    if (!hashHandled && location.hash === "#tambah-menu" && order.canAddItems !== false && ["baru", "diproses"].includes(order.status)) { hashHandled = true; openPanel(false); }
    if (readIntent() && !open) { open = true; renderControls(); notice("Hasil tambahan sebelumnya belum terkonfirmasi. Periksa tambahan yang sama agar tidak tersimpan dua kali."); }
    if (open && !allowed() && !readIntent()) notice(pending() ? "Tambahan sebelumnya masih menunggu persetujuan admin. Anda dapat menambah lagi setelah permintaan tersebut ditangani." : "Menu tidak dapat ditambahkan karena pesanan sudah dikirim, selesai, atau dibatalkan.");
  }
  function unavailable() { verified = false; renderControls(); }
  function change(productId, value) {
    if (!allowed() || busy || readIntent() || !menuReady) return;
    const quantity = Number(value);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 999) { notice("Isi jumlah antara 0 dan 999 paket.", true); renderControls(); return; }
    selected.set(productId, quantity); notice(""); renderControls();
  }
  function renderMenu() {
    const root = $("#addition-menu");
    for (const product of menu) {
      let row = rows.get(product.id);
      if (!row) {
        const card = document.createElement("div"); card.className = "addition-product";
        const details = document.createElement("div"), name = document.createElement("strong"), price = document.createElement("span"), stock = document.createElement("small"); details.append(name, price, stock);
        const control = document.createElement("div"); control.className = "addition-quantity";
        const minus = document.createElement("button"), input = document.createElement("input"), plus = document.createElement("button");
        minus.type = plus.type = "button"; minus.textContent = "−"; plus.textContent = "+";
        minus.setAttribute("aria-label", `Kurangi ${product.name}`); plus.setAttribute("aria-label", `Tambah ${product.name}`);
        input.type = "number"; input.min = "0"; input.step = "1"; input.inputMode = "numeric"; input.value = String(selected.get(product.id) || 0); input.setAttribute("aria-label", `Jumlah ${product.name}`);
        minus.addEventListener("click", () => change(product.id, Math.max(0, (selected.get(product.id) || 0) - 1)));
        plus.addEventListener("click", () => change(product.id, (selected.get(product.id) || 0) + 1));
        input.addEventListener("input", () => change(product.id, input.value));
        input.addEventListener("blur", () => { input.value = String(selected.get(product.id) || 0); });
        control.append(minus, input, plus); card.append(details, control); row = { card, name, price, stock, minus, input, plus }; rows.set(product.id, row); root.append(card);
      }
      row.name.textContent = product.name; row.price.textContent = `${amount(product.price)} / paket`;
    }
    for (const [productId, row] of rows) if (!menu.some(product => product.id === productId)) { row.card.remove(); rows.delete(productId); }
    renderControls();
  }
  async function requestJSON(url, options = {}, deadline = 12000) {
    const controller = new AbortController(); let timeout;
    try {
      return await Promise.race([
        (async () => { const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...options, signal: controller.signal }); const data = await response.json(); return { response, data }; })(),
        new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("Koneksi belum memastikan hasilnya.")); }, deadline); })
      ]);
    } finally { clearTimeout(timeout); }
  }
  async function loadMenu() {
    if (catalogBusy) return catalogBusy;
    catalogBusy = (async () => {
      try {
        const { response, data } = await requestJSON("/api/menu", { headers: { Accept: "application/json" } });
        if (!response.ok || !Array.isArray(data.products) || !data.products.length || data.products.some(product => !product || typeof product.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(product.id) || typeof product.name !== "string" || !Number.isSafeInteger(product.price) || product.price < 1 || !Number.isSafeInteger(product.stock) || product.stock < 0) || new Set(data.products.map(product => product.id)).size !== data.products.length) throw new Error("Menu belum dapat dimuat.");
        menu = data.products; menuReady = true; renderMenu(); return true;
      } catch { menuReady = false; notice("Stok dan harga belum dapat dimuat. Pilihan Anda tetap disimpan; tekan Perbarui stok untuk mencoba kembali.", true); return false; }
      finally { catalogBusy = null; renderControls(); }
    })();
    renderControls(); return catalogBusy;
  }
  function openPanel(focus = true) {
    if (!verified || !order || order.canAddItems === false || !["baru", "diproses"].includes(order.status) || pending() || additions().length >= 100) return;
    open = true; renderControls();
    if (readIntent()) notice("Hasil tambahan sebelumnya belum terkonfirmasi. Periksa tambahan yang sama agar tidak tersimpan dua kali.");
    if (!menu.length && !pending()) loadMenu();
    if (focus) { $("#addition-title").focus(); $("#tambah-menu").scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
  async function submit(event) {
    event?.preventDefault?.(); if (busy || !allowed() || readIntent()) return;
    const items = selectedItems(), reviewedTotal = subtotal(items); if (!safeSelection(items)) return;
    busy = true; renderControls();
    try {
      if (!await loadMenu()) return;
      if (!allowed()) { notice("Status pesanan berubah. Periksa status terbaru sebelum menambahkan menu.", true); return; }
      if (subtotal(items) !== reviewedTotal) { notice("Harga menu berubah. Periksa subtotal terbaru, lalu tekan tombol tambahan kembali jika sudah sesuai.", true); return; }
      if (!safeSelection(items)) { notice("Stok berubah. Sesuaikan jumlah sebelum mengirim tambahan.", true); return; }
      const secure = window.crypto || globalThis.crypto;
      if (!secure?.randomUUID) { notice("Browser ini belum mendukung penyimpanan tambahan yang aman. Gunakan browser terbaru atau hubungi admin.", true); return; }
      const value = { id, token, requestId: secure.randomUUID(), items, expectedTotal: reviewedTotal, savedAt: Date.now() };
      storeIntent(value); await post(value);
    } finally { busy = false; renderControls(); }
  }
  async function retry() {
    const value = readIntent(); if (!value || busy || !verified || navigator.onLine === false) return;
    busy = true; renderControls(); try { await post(value); } finally { busy = false; renderControls(); }
  }
  async function post(value) {
    try {
      const payload = { action: "add-items", id, token, requestId: value.requestId, items: value.items, expectedTotal: value.expectedTotal };
      const { response, data } = await requestJSON("/api/order", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) }, 30000);
      if (!response.ok) {
        const definite = ["PRICE_CHANGED", "INSUFFICIENT_STOCK", "ADDITION_NOT_ALLOWED", "ADDITION_PENDING", "ORDER_CONFLICT", "ADDITION_LIMIT"].includes(data.code);
        if (definite) clearIntent(value.requestId);
        if (["PRICE_CHANGED", "INSUFFICIENT_STOCK"].includes(data.code)) await loadMenu();
        notice(data.code === "REQUEST_CONFLICT" ? "Permintaan ini perlu diperiksa admin. Jangan kirim tambahan baru; hubungi admin dengan nomor pesanan Anda." : typeof data.error === "string" ? data.error : "Tambahan belum dapat disimpan. Periksa status pesanan sebelum mencoba kembali.", true);
        if ([400, 401, 403, 404].includes(response.status)) { verified = false; window.DapoerTrack?.unavailable?.(); }
        if (["ADDITION_NOT_ALLOWED", "ADDITION_PENDING", "ORDER_CONFLICT", "ADDITION_LIMIT"].includes(data.code)) { unavailable(); window.DapoerTrack?.refresh?.(); }
        if (!definite && ![400, 401, 403, 404].includes(response.status)) { unavailable(); window.DapoerTrack?.unavailable?.(); window.DapoerTrack?.refresh?.(); }
        return;
      }
      const addition = data.addition;
      const returnedItems = (Array.isArray(addition?.items) ? addition.items : []).map(item => ({ id: item.id, quantity: item.quantity })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const known = data.order?.additions?.find?.(item => item.id === value.requestId);
      if (data.persisted !== true || addition?.id !== value.requestId || !["applied", "pending", "approved", "rejected", "expired"].includes(addition.status) || addition.total !== value.expectedTotal
        || JSON.stringify(returnedItems) !== JSON.stringify(value.items) || !validSnapshot(data.order) || !known || known.status !== addition.status || known.total !== addition.total) throw new Error("invalid addition response");
      clearIntent(value.requestId); selected.clear();
      if (order && window.DapoerOrderRecovery.compareUpdatedAt(data.order.updatedAt, order.updatedAt) < 0) {
        renderHistory(); renderControls();
        notice("Tambahan sudah ditangani. Status terbaru pada halaman ini tetap digunakan; periksa riwayat tambahan di bawah.");
        window.DapoerTrack?.refresh?.(); return;
      }
      window.DapoerOrderRecovery?.syncOrder?.({ id, token, order: data.order });
      if (window.DapoerTrack?.update) window.DapoerTrack.update(data.order); else update(data.order);
      notice(addition.status === "pending" ? "Tambahan diajukan ke admin. Tunggu persetujuan sebelum membayar tambahan; nomor pesanan dan antrean tetap sama." : ["applied", "approved"].includes(addition.status) ? "Tambahan berhasil masuk ke pesanan yang sama. Konfirmasikan total terbaru melalui WhatsApp." : "Permintaan tambahan sudah ditangani. Periksa riwayat tambahan.");
      for (const row of rows.values()) row.input.value = "0";
    } catch {
      unavailable();
      window.DapoerTrack?.unavailable?.();
      notice("Koneksi belum memastikan hasil tambahan. Tekan Periksa tambahan sebelumnya untuk melanjutkan permintaan yang sama. Jangan membuat pesanan baru.", true);
      window.DapoerTrack?.refresh?.();
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    if (!identity || !$("#tambah-menu")) return;
    initialized = true;
    const saved = readIntent(); if (saved) for (const item of saved.items) selected.set(item.id, item.quantity);
    $("#track-add-menu").addEventListener("click", () => openPanel());
    $("#addition-close").addEventListener("click", () => { if (busy) return; open = false; hashHandled = true; renderControls(); $("#track-add-menu").focus(); });
    $("#addition-refresh").addEventListener("click", loadMenu);
    $("#addition-form").addEventListener("submit", submit);
    $("#addition-retry").addEventListener("click", retry);
    window.addEventListener("hashchange", () => { if (location.hash === "#tambah-menu") openPanel(); });
    window.addEventListener("offline", unavailable);
    renderControls(); if (order) update(order);
  });
  window.DapoerOrderAdditions = Object.freeze({ update, unavailable });
})();
