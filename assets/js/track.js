(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const rupiah = value => `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
  const statuses = ["baru", "diproses", "dikirim", "selesai"];
  const params = new URLSearchParams(location.search);
  const id = params.get("id") || "", token = params.get("token") || "";
  const validLink = /^[A-Za-z0-9-]{3,80}$/.test(id) && /^[A-Za-z0-9_-]{32,256}$/.test(token);
  let shownOrder = null, timer = null, request = null, generation = 0, initialized = false;

  document.addEventListener("DOMContentLoaded", () => {
    initialized = true;
    $("#track-retry").addEventListener("click", loadStatus);
    if (!validLink) return showError("Link tracking tidak valid.");
    if (!document.hidden) loadStatus();
  });
  document.addEventListener("visibilitychange", () => {
    if (!initialized) return;
    if (document.hidden) pause();
    else loadStatus();
  });
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", event => { if (initialized && event.persisted) loadStatus(); });
  window.addEventListener("online", () => { if (initialized) loadStatus(); });
  window.addEventListener("offline", () => {
    if (!initialized) return;
    pause();
    showError("Koneksi terputus. Status akan diperbarui ketika perangkat kembali terhubung.", true);
  });

  function pause() {
    clearTimeout(timer); timer = null;
    generation++; request?.abort(); request = null;
    if (initialized) $("#track-retry").disabled = false;
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden && validLink && navigator.onLine !== false) timer = setTimeout(loadStatus, 8000);
  }

  async function loadStatus() {
    if (!initialized || !validLink || document.hidden || request || navigator.onLine === false) return;
    clearTimeout(timer); timer = null;
    const controller = new AbortController(), turn = generation;
    request = controller;
    $("#track-retry").disabled = true;
    let timedOut = false, permanentFailure = false, timeout;
    try {
      const { response, data } = await Promise.race([
        (async () => {
          const response = await fetch(`/api/track?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`, {
            headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin", signal: controller.signal
          });
          return { response, data: await response.json() };
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("Status pesanan belum dapat diperiksa.")); }, 12000); })
      ]);
      if (turn !== generation || controller.signal.aborted) return;
      if (!response.ok) {
        permanentFailure = [400, 401, 403, 404].includes(response.status);
        throw new Error(typeof data.error === "string" ? data.error : "Status pesanan belum tersedia.");
      }
      if (!validOrder(data.order)) { permanentFailure = true; throw new Error("Data pesanan belum dapat ditampilkan. Muat ulang halaman untuk mencoba kembali."); }
      render(data.order);
    } catch (error) {
      if (turn !== generation || (error.name === "AbortError" && !timedOut)) return;
      const message = timedOut ? "Koneksi terlalu lama. Kami akan mencoba memperbarui status kembali." : error.message || "Status pesanan belum dapat dimuat.";
      showError(message, !permanentFailure);
    } finally {
      clearTimeout(timeout);
      if (request === controller) {
        request = null;
        $("#track-retry").disabled = false;
        if (!permanentFailure) schedule();
      }
    }
  }

  function validOrder(order) {
    return order && order.id === id && [...statuses, "dibatalkan"].includes(order.status)
      && Number.isSafeInteger(order.total) && order.total > 0
      && typeof order.updatedAt === "string" && Number.isFinite(new Date(order.updatedAt).getTime())
      && Array.isArray(order.items) && order.items.length > 0 && order.items.length <= 100
      && order.items.every(item => item && typeof item.name === "string" && item.name.trim() && Number.isSafeInteger(item.quantity) && item.quantity > 0 && Number.isSafeInteger(item.subtotal) && item.subtotal >= 0)
      && (order.canAddItems === undefined || typeof order.canAddItems === "boolean")
      && window.DapoerOrderRecovery?.validAdditions?.(order.additions) !== false;
  }

  function render(order) {
    if (shownOrder && window.DapoerOrderRecovery.compareUpdatedAt(order.updatedAt, shownOrder.updatedAt) < 0) return;
    const previousStatus = shownOrder?.status;
    shownOrder = order;
    $("#track-loading").hidden = true;
    $("#track-error").hidden = true;
    $("#track-sync").hidden = true;
    $("#track-retry").hidden = true;
    $("#track-content").hidden = false;
    $("#track-order-id").textContent = order.id;
    const queue = Number.isSafeInteger(order.queueNumber) && order.queueNumber > 0 ? `A${String(order.queueNumber).padStart(3, "0")}` : "";
    $("#track-queue").hidden = !queue;
    $("#track-queue-number").textContent = queue || "—";
    const queueDate = typeof order.queueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(order.queueDate) ? new Date(`${order.queueDate}T00:00:00Z`) : null;
    const validQueueDate = queueDate && Number.isFinite(queueDate.getTime()) && queueDate.toISOString().slice(0, 10) === order.queueDate;
    $("#track-queue-date").textContent = validQueueDate ? `${queueDate.toLocaleDateString("id-ID", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" })} · WIB` : "";
    $("#track-total").textContent = rupiah(order.total);
    $("#track-status").textContent = order.status;
    $("#track-updated").textContent = `Diperbarui ${new Date(order.updatedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`;

    const terminal = ["dibatalkan", "selesai"].includes(order.status);
    if (terminal) window.DapoerOrderRecovery?.forget?.({ id, token });
    const recoveryUrl = window.DapoerOrderRecovery?.getWhatsAppUrl({ id, token, order });
    const canConfirm = !!recoveryUrl && !terminal;
    const recovery = $("#track-whatsapp-recovery");
    recovery.hidden = !canConfirm;
    const recoveryLink = $("#track-whatsapp-link");
    if (canConfirm) recoveryLink.href = recoveryUrl;
    else recoveryLink.removeAttribute("href");

    const currentIndex = statuses.indexOf(order.status);
    document.querySelectorAll(".step").forEach((step, index) => {
      step.classList.toggle("done", currentIndex >= 0 && index < currentIndex);
      step.classList.toggle("active", currentIndex >= 0 && index === currentIndex);
    });
    $("#cancelled-note").hidden = order.status !== "dibatalkan";
    const root = $("#track-items"); root.replaceChildren();
    order.items.forEach(item => {
      const row = document.createElement("div"); row.className = "track-item";
      const name = document.createElement("span"); name.textContent = `${item.name} × ${item.quantity}`;
      const subtotal = document.createElement("strong"); subtotal.textContent = rupiah(item.subtotal);
      row.append(name, subtotal); root.append(row);
    });
    if (previousStatus && previousStatus !== order.status) document.title = `Status: ${order.status} | Dapoer Pasta`;
    window.DapoerOrderAdditions?.update?.(order);
  }

  function showError(message, transient = false) {
    window.DapoerOrderAdditions?.unavailable?.();
    $("#track-whatsapp-recovery").hidden = true;
    $("#track-whatsapp-link").removeAttribute("href");
    $("#track-loading").hidden = true;
    $("#track-retry").hidden = !validLink;
    if (shownOrder && transient) {
      $("#track-sync").hidden = false;
      $("#track-sync").textContent = `${message} Detail di bawah adalah pembaruan terakhir yang berhasil dimuat.`;
      $("#track-error").hidden = true;
      return;
    }
    shownOrder = null;
    $("#track-content").hidden = true;
    $("#track-whatsapp-recovery").hidden = true;
    $("#track-whatsapp-link").removeAttribute("href");
    $("#track-sync").hidden = true;
    $("#track-error").hidden = false;
    $("#track-error").textContent = message;
  }
  window.DapoerTrack = Object.freeze({
    update: order => {
      if (!validOrder(order)) { showError("Data tambahan belum dapat diverifikasi. Perbarui status sebelum melanjutkan."); return false; }
      // A GET started before an addition must never replace its newer result.
      pause(); render(order); schedule(); return true;
    },
    refresh: loadStatus,
    unavailable: () => showError("Pesanan belum dapat diverifikasi. Perbarui status untuk melanjutkan.")
  });
})();
