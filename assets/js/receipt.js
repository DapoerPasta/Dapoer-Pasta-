(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "", token = params.get("token") || "";
  const files = window.DapoerReceiptPrint;
  let currentOrder = null, busy = false, generation = 0, request = null, exportRequest = null;

  document.addEventListener("DOMContentLoaded", () => {
    const paper = params.get("paper");
    if (["58", "80", "a4"].includes(paper)) $("#receipt-paper-size").value = paper;
    updatePaper();
    $("#receipt-paper-size").addEventListener("change", () => { cancelExport(); updatePaper(); });
    $("#print-receipt").addEventListener("click", () => output("print"));
    $("#download-receipt-pdf").addEventListener("click", () => output("pdf"));
    document.addEventListener("dapoer:admin-session", event => { if (!event.detail?.authenticated && currentOrder?.customerDataProtected === false) fail("Sesi admin berakhir. Muat ulang nota untuk melihat informasi yang tersedia."); });
    if (token) $("#back-tracking").href = `/track/?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
    else { $("#back-tracking").href = "/admin/"; $("#back-tracking").textContent = "← Kembali ke Admin"; }
    loadReceipt();
  });

  window.addEventListener("pagehide", () => { generation++; request?.abort(); cancelExport(); clear(); });
  window.addEventListener("pageshow", event => { if (event.persisted) loadReceipt(); });

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
    try {
      if (!files || !/^[A-Za-z0-9-]{3,80}$/.test(id) || (token && token.length < 32)) throw new Error("Link nota tidak valid.");
      const query = new URLSearchParams({ id });
      if (token) query.set("token", token);
      const response = await fetch(`/api/receipt?${query}`, { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Nota belum tersedia.");
      const order = files.normalize(data.order);
      if (order.id !== id) throw new Error("Nota tidak cocok dengan pesanan. Muat ulang halaman.");
      return order;
    } catch (error) { error.receiptReadFailure = true; throw error; }
  }

  async function loadReceipt() {
    const turn = ++generation;
    request?.abort(); cancelExport(); clear();
    $("#receipt-error").hidden = true;
    $("#receipt-loading").hidden = false;
    request = new AbortController();
    try {
      const order = await readOrder(request.signal);
      if (turn === generation) render(order);
    } catch (error) { if (turn === generation && error.name !== "AbortError") fail(error.message || "Nota belum dapat dimuat."); }
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
    $("#receipt-content").hidden = true;
    $("#receipt-items").replaceChildren();
    for (const field of ["id", "customer", "date", "status", "queue-number", "queue-date", "total", "method", "phone", "address", "notes"]) $("#receipt-" + field).textContent = "—";
    updateControls();
  }

  function fail(message) {
    generation++; request?.abort(); cancelExport(); clear();
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
      if (kind === "print") { messageText(""); window.print(); return; }
      const result = await files.build(order, { paper, signal: controller.signal });
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
