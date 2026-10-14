(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "", token = params.get("token") || "";
  const files = window.DapoerReceiptPrint;
  let currentOrder = null, busy = false, generation = 0, request = null, exportRequest = null;
  let initialized = false, resumeNeeded = false, applicationPrint = false, nativePrint = false;

  document.addEventListener("DOMContentLoaded", () => {
    initialized = true;
    const paper = params.get("paper");
    if (["58", "80", "a4"].includes(paper)) $("#receipt-paper-size").value = paper;
    updatePaper();
    $("#receipt-paper-size").addEventListener("change", () => { cancelExport(); updatePaper(); });
    $("#print-receipt").addEventListener("click", () => output("print"));
    $("#download-receipt-pdf").addEventListener("click", () => output("pdf"));
    const sessionEnded = detail => {
      if (detail?.authenticated !== false) return;
      // This also invalidates an outstanding read/export. A response started
      // before logout must never restore private fields after the broadcast.
      if (currentOrder?.customerDataProtected === true && !request && !exportRequest) return;
      fail("Sesi admin berakhir. Masuk kembali ke admin untuk membuka nota lengkap.");
      if (token && !document.hidden && !nativePrint) loadReceipt();
    };
    if (window.DapoerAdminSession) window.DapoerAdminSession.subscribe(sessionEnded);
    else document.addEventListener("dapoer:admin-session", event => sessionEnded(event.detail));
    if (token) $("#back-tracking").href = `/track/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
    else { $("#back-tracking").href = "/admin/"; $("#back-tracking").textContent = "← Kembali ke Admin"; }
    loadReceipt();
  });

  document.addEventListener("visibilitychange", () => {
    if (!initialized || applicationPrint) return;
    if (document.hidden) {
      if (currentOrder?.customerDataProtected === false || request || exportRequest) suspend();
    } else if (resumeNeeded) revalidate();
  });
  window.addEventListener("focus", () => {
    if (initialized && !document.hidden && !applicationPrint && !nativePrint && !busy && (resumeNeeded || currentOrder?.customerDataProtected === false)) revalidate();
  });
  window.addEventListener("pagehide", () => { if (initialized) suspend(); });
  window.addEventListener("pageshow", event => { if (initialized && event.persisted) revalidate(); });
  window.addEventListener("beforeprint", () => {
    if (!initialized || applicationPrint || currentOrder?.customerDataProtected === true) return;
    // Native Ctrl+P cannot await an authorization request. Clear private DOM
    // synchronously; the application button validates and grants one print.
    nativePrint = true;
    suspend();
    $("#receipt-loading").hidden = true;
    messageText("Untuk mencetak nota lengkap, tutup menu cetak ini lalu gunakan tombol Cetak struk. Akses admin akan diperiksa kembali.");
  });
  window.addEventListener("afterprint", () => {
    if (!nativePrint) return;
    nativePrint = false;
    if (!document.hidden) revalidate();
  });

  function suspend() {
    generation++; request?.abort(); request = null; cancelExport(); clear();
    resumeNeeded = true;
  }

  function revalidate() {
    if (nativePrint || busy || request || document.hidden) return;
    resumeNeeded = false;
    loadReceipt();
  }

  function updatePaper() {
    const paper = $("#receipt-paper-size").value;
    document.body.dataset.paperSize = ["58", "80", "a4"].includes(paper) ? paper : "80";
    $("#receipt-paper-help").textContent = paper === "a4" ? "Gunakan kertas A4 dan nonaktifkan header/footer pada menu cetak." : `Gunakan kertas ${paper} mm, skala 100%, dan nonaktifkan header/footer pada menu cetak.`;
    updateControls();
  }

  function updateControls() {
    const disabled = busy || !currentOrder;
    $("#print-receipt").disabled = disabled;
    $("#download-receipt-pdf").disabled = disabled;
    $("#receipt-paper-size").disabled = busy;
  }

  async function readOrder(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    try {
      if (!files || !/^[A-Za-z0-9-]{3,80}$/.test(id) || (token && token.length < 32)) throw new Error("Link nota tidak valid.");
      const query = new URLSearchParams({ id });
      if (token) query.set("token", token);
      const response = await fetch(`/api/receipt?${query}`, { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Nota belum tersedia.");
      const order = files.normalize(data.order);
      if (order.id !== id) throw new Error("Nota tidak cocok dengan pesanan. Muat ulang halaman.");
      return order;
    } catch (error) {
      if (timedOut) error = new Error("Koneksi terlalu lama. Muat ulang nota untuk mencoba kembali.");
      error.receiptReadFailure = true; throw error;
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }

  async function loadReceipt() {
    const turn = ++generation;
    request?.abort(); cancelExport(); clear();
    $("#receipt-error").hidden = true;
    $("#receipt-loading").hidden = false;
    if (document.hidden) { resumeNeeded = true; request = null; return; }
    request = new AbortController();
    const controller = request;
    try {
      const order = await readOrder(controller.signal);
      if (turn === generation && !controller.signal.aborted && !nativePrint) {
        if (document.hidden && order.customerDataProtected === false) suspend();
        else render(order);
      }
    } catch (error) { if (turn === generation && error.name !== "AbortError") fail(error.message || "Nota belum dapat dimuat."); }
    finally { if (request === controller) request = null; }
  }

  function render(order) {
    currentOrder = order;
    document.body.dataset.customerProtected = String(order.customerDataProtected);
    $("#receipt-id").textContent = order.id;
    $("#receipt-customer").textContent = order.customerDataProtected ? "Data pelanggan dilindungi" : order.customerName || "—";
    $("#receipt-date").textContent = files.createdLabel(order.createdAt);
    $("#receipt-status").textContent = order.statusLabel;
    $("#receipt-queue-number").textContent = order.queueLabel;
    $("#receipt-queue-date").textContent = order.queueDate ? files.dateLabel(order.queueDate) : "Nomor antrean belum tersedia untuk pesanan ini.";
    $("#receipt-total").textContent = files.money(order.total);
    $("#receipt-method").textContent = order.paymentMethod;
    $("#receipt-phone").textContent = order.customerDataProtected ? "Dilindungi" : order.customerPhone || "—";
    $("#receipt-address").textContent = order.customerDataProtected ? "Dilindungi" : order.address || "—";
    $("#receipt-notes").textContent = order.customerDataProtected ? "Dilindungi" : order.notes || "Tidak ada";
    $("#receipt-privacy").hidden = !order.customerDataProtected;
    const root = $("#receipt-items"); root.replaceChildren();
    order.items.forEach(item => {
      const row = document.createElement("div"); row.className = "receipt-item";
      const left = document.createElement("div"), name = document.createElement("span"), meta = document.createElement("small"), total = document.createElement("strong");
      name.textContent = item.name;
      meta.textContent = `${item.quantity.toLocaleString("id-ID")} × ${files.money(item.price)}`;
      total.textContent = files.money(item.subtotal);
      left.append(name, meta); row.append(left, total); root.append(row);
    });
    $("#receipt-content").hidden = false;
    $("#receipt-loading").hidden = true;
    $("#receipt-error").hidden = true;
    document.body.dataset.receiptReady = "true";
    updateControls();
  }

  function clear() {
    currentOrder = null;
    document.body.dataset.receiptReady = "false";
    document.body.dataset.customerProtected = "true";
    document.body.dataset.privatePrintAuthorized = "false";
    $("#receipt-content").hidden = true;
    $("#receipt-items").replaceChildren();
    for (const field of ["id", "customer", "date", "status", "queue-number", "queue-date", "total", "method", "phone", "address", "notes"]) $("#receipt-" + field).textContent = "—";
    updateControls();
  }

  function fail(message) {
    generation++; request?.abort(); request = null; cancelExport(); clear();
    $("#receipt-loading").hidden = true;
    $("#receipt-error").hidden = false;
    $("#receipt-error").textContent = message;
    messageText("");
  }

  function messageText(value) { $("#receipt-print-message").hidden = !value; $("#receipt-print-message").textContent = value; }

  function cancelExport() {
    exportRequest?.abort(); exportRequest = null; busy = false;
    if ($("#print-receipt")) updateControls();
  }

  async function output(kind) {
    if (busy || !currentOrder) return;
    busy = true; updateControls(); messageText(kind === "pdf" ? "Menyiapkan PDF struk…" : "Memeriksa nota sebelum mencetak…");
    const turn = generation, paper = $("#receipt-paper-size").value;
    const controller = new AbortController(); exportRequest = controller;
    try {
      // Revalidate before printing so an expired admin session or changed order
      // does not print the earlier customer details or status.
      const order = await readOrder(controller.signal);
      if (turn !== generation || controller.signal.aborted) return;
      render(order);
      if (kind === "print") {
        messageText(""); applicationPrint = true;
        document.body.dataset.privatePrintAuthorized = "true";
        try { window.print(); } finally { applicationPrint = false; document.body.dataset.privatePrintAuthorized = "false"; }
        return;
      }
      const result = await files.build(order, { paper, signal: controller.signal });
      if (turn !== generation || controller.signal.aborted) return;
      const latest = await readOrder(controller.signal);
      if (turn !== generation || controller.signal.aborted) return;
      if (JSON.stringify(order) !== JSON.stringify(latest)) {
        render(latest); messageText("Pesanan atau akses nota diperbarui. Periksa nota, lalu unduh kembali."); return;
      }
      const url = URL.createObjectURL(result.blob), link = document.createElement("a");
      link.href = url; link.download = result.filename; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      messageText("PDF struk berhasil diunduh. Buka file di aplikasi printer bila diperlukan.");
    } catch (error) {
      if (turn !== generation || controller.signal.aborted || error.name === "AbortError") return;
      // A failed authorization/read clears the receipt. Library or font errors
      // still permit printing the current, valid receipt through the device.
      if (error.receiptReadFailure) fail(error.message || "Nota belum dapat dimuat.");
      else messageText(error.message || "PDF belum dapat diunduh. Coba lagi atau gunakan Cetak struk.");
    } finally {
      if (exportRequest === controller) { exportRequest = null; busy = false; updateControls(); }
    }
  }
})();
