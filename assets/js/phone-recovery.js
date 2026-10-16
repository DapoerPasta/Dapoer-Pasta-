/* Recovery codes are sent by an authenticated admin to the saved WhatsApp number. */
(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const KEY = "dapoer-phone-recovery-v1", PENDING_KEY = "dapoer-phone-recovery-request-v1", VERIFY_KEY = "dapoer-phone-recovery-verification-v1";
  const MAX_AGE = 10 * 60 * 1000;
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  const challengeId = value => typeof value === "string" && /^[a-f0-9]{48}$/i.test(value);
  const phone = value => {
    if (typeof value !== "string" || value.length > 40 || !/^[+0-9()\s.-]+$/.test(value)) return null;
    const digits = value.replace(/\D/g, "");
    const normalized = digits.startsWith("0") ? "62" + digits.slice(1) : digits;
    return /^628[1-9][0-9]{7,10}$/.test(normalized) ? normalized : null;
  };
  let initialized = false, challenge = null, pending = null, verification = null, busy = false, generation = 0, controller = null, expiryTimer = null;
  function read(key) { try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return null; } }
  function store(key, value) { try { value ? sessionStorage.setItem(key, JSON.stringify(value)) : sessionStorage.removeItem(key); } catch {} }
  function fresh(value) { return Number.isFinite(value) && value > Date.now() && value <= Date.now() + MAX_AGE + 60000; }
  function validChallenge(value) { return challengeId(value?.challengeId) && typeof value.expiresAt === "string" && fresh(Date.parse(value.expiresAt)); }
  function validPending(value) { return uuid(value?.requestId) && phone(value.phone) === value.phone && Number.isFinite(value.savedAt) && value.savedAt <= Date.now() + 60000 && Date.now() - value.savedAt < MAX_AGE; }
  function validVerification(value) { return validChallenge(challenge) && value?.challengeId === challenge.challengeId && uuid(value.requestId) && /^[0-9]{6}$/.test(value.code) && Number.isFinite(value.savedAt) && value.savedAt <= Date.now() + 60000 && Date.now() - value.savedAt < MAX_AGE; }
  function clearVerification() { verification = null; store(VERIFY_KEY, null); }
  function notice(text, error = false) {
    const node = $("#phone-recovery-notice"); node.textContent = text || ""; node.hidden = !text; node.classList.toggle("is-error", error);
  }
  function render() {
    if (!initialized) return;
    const hasChallenge = validChallenge(challenge);
    $("#phone-recovery-request").hidden = hasChallenge;
    $("#phone-recovery-challenge").hidden = !hasChallenge;
    $("#phone-recovery-request-submit").disabled = busy;
    $("#phone-recovery-request-submit").textContent = busy && !challenge ? "Memeriksa permintaan…" : pending ? "Periksa Permintaan Kode Sebelumnya" : "Minta Kode Verifikasi";
    $("#phone-recovery-phone").disabled = busy || !!pending;
    $("#phone-recovery-verify-submit").disabled = busy || !hasChallenge;
    $("#phone-recovery-verify-submit").textContent = busy && challenge ? "Memeriksa kode…" : verification ? "Periksa Kode yang Sama" : "Lihat Pesanan Saya";
    $("#phone-recovery-code").disabled = busy || !!verification;
    $("#phone-recovery-restart").disabled = busy;
    $("#phone-recovery-restart").hidden = !hasChallenge && !pending;
    $("#phone-recovery-request").setAttribute("aria-busy", String(busy && !challenge));
    $("#phone-recovery-verify").setAttribute("aria-busy", String(busy && !!challenge));
    if (hasChallenge) {
      $("#phone-recovery-expiry").textContent = `Kode berlaku sampai ${new Date(challenge.expiresAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" })} WIB. Maksimal 5 percobaan.`;
      const message = `Halo Admin Dapoer Pasta, saya ingin memulihkan tautan pesanan saya. Referensi verifikasi: ${challenge.challengeId}. Mohon kirim kode hanya ke nomor WhatsApp yang tercatat pada pesanan.`;
      $("#phone-recovery-whatsapp").href = `https://api.whatsapp.com/send?phone=6285175391181&text=${encodeURIComponent(message)}`;
    } else $("#phone-recovery-whatsapp").removeAttribute("href");
    clearTimeout(expiryTimer);
    if (hasChallenge) expiryTimer = setTimeout(expire, Math.max(1, Date.parse(challenge.expiresAt) - Date.now()));
  }
  function expire() {
    generation++; controller?.abort(); controller = null; busy = false; challenge = null; verification = null; pending = null;
    store(KEY, null); store(PENDING_KEY, null); clearVerification(); $("#phone-recovery-code").value = "";
    $("#phone-recovery-results").hidden = true; $("#phone-recovery-orders").replaceChildren();
    notice("Kode atau sesi verifikasi sudah berakhir. Minta kode baru; pesanan Anda tetap tersimpan.", true); render();
  }
  function restart() {
    if (busy) return;
    generation++; clearTimeout(expiryTimer); controller?.abort(); controller = null; pending = null; challenge = null; verification = null;
    store(KEY, null); store(PENDING_KEY, null); clearVerification(); $("#phone-recovery-code").value = ""; $("#phone-recovery-results").hidden = true; $("#phone-recovery-orders").replaceChildren();
    notice(""); render(); $("#phone-recovery-phone").focus();
  }
  async function post(payload) {
    const request = new AbortController(); controller = request; let timeout;
    try {
      return await Promise.race([
        (async () => { const response = await fetch("/api/track", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload), signal: request.signal }); return { response, data: await response.json() }; })(),
        new Promise((_, reject) => { timeout = setTimeout(() => { request.abort(); reject(new Error("timeout")); }, 12000); })
      ]);
    } finally { clearTimeout(timeout); if (controller === request) controller = null; }
  }
  function newId() { const value = (window.crypto || globalThis.crypto)?.randomUUID?.(); return uuid(value) ? value : null; }
  async function requestCode(event) {
    event?.preventDefault?.(); if (busy) return;
    const normalized = phone($("#phone-recovery-phone").value);
    if (!pending && !normalized) { notice("Tulis nomor WhatsApp Indonesia yang digunakan saat memesan, contoh 08xxxxxxxxxx.", true); $("#phone-recovery-phone").focus(); return; }
    if (!pending) { const requestId = newId(); if (!requestId) { notice("Gunakan browser terbaru untuk meminta kode verifikasi.", true); return; } pending = { phone: normalized, requestId, savedAt: Date.now() }; store(PENDING_KEY, pending); }
    if (!validPending(pending)) { pending = null; store(PENDING_KEY, null); notice("Permintaan sebelumnya sudah berakhir. Silakan minta kode baru.", true); render(); return; }
    const intent = { ...pending }, turn = generation; busy = true; notice(""); render();
    try {
      const { response, data } = await post({ action: "request-recovery", phone: intent.phone, requestId: intent.requestId });
      if (turn !== generation) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429) { pending = null; store(PENDING_KEY, null); }
        notice(response.status === 429 ? "Permintaan terlalu sering. Tunggu beberapa saat, lalu periksa permintaan yang sama." : "Permintaan kode belum dapat dipastikan. Coba periksa permintaan yang sama atau hubungi admin.", true); return;
      }
      if (data.status !== "awaiting-admin" || !validChallenge(data)) throw new Error("invalid response");
      challenge = { challengeId: data.challengeId, expiresAt: data.expiresAt }; store(KEY, challenge); pending = null; store(PENDING_KEY, null); $("#phone-recovery-phone").value = "";
      notice("Permintaan tercatat. Admin akan memeriksa nomor pemesan dan mengirim kode melalui WhatsApp. Tekan Minta kode ke admin untuk menghubungi admin.");
    } catch { if (turn === generation) notice("Koneksi belum memastikan permintaan kode. Tekan Periksa Permintaan Kode Sebelumnya untuk melanjutkan permintaan yang sama.", true); }
    finally { if (turn === generation) { busy = false; render(); if (challenge) $("#phone-recovery-code").focus(); } }
  }
  function safeOrders(value) {
    if (!Array.isArray(value) || value.length > 100) return null;
    const seen = new Set();
    for (const order of value) {
      const tracking = window.DapoerOrderRecovery?.safeOrderUrl(order?.trackingUrl, "/track/");
      if (!tracking || tracking.id !== order.id || seen.has(order.id) || !["baru", "diproses", "dikirim"].includes(order.status) || !window.DapoerOrderRecovery?.billing(order)) return null;
      seen.add(order.id);
    }
    return value;
  }
  function showOrders(orders) {
    const root = $("#phone-recovery-orders"); root.replaceChildren();
    if (!orders.length) { const empty = document.createElement("p"); empty.textContent = "Tidak ada pesanan yang dapat dipulihkan. Hubungi admin untuk bantuan."; root.append(empty); }
    for (const order of orders) {
      const tracking = window.DapoerOrderRecovery.safeOrderUrl(order.trackingUrl, "/track/");
      const card = document.createElement("article"), heading = document.createElement("strong"), summary = document.createElement("p"), link = document.createElement("a");
      heading.textContent = order.id;
      const queue = Number.isSafeInteger(order.queueNumber) && order.queueNumber > 0 ? `Antrean A${String(order.queueNumber).padStart(3, "0")} · ` : "";
      const charges = window.DapoerOrderRecovery.billing(order);
      summary.textContent = `${queue}${order.status} · Rp ${order.total.toLocaleString("id-ID")}${charges?.shippingConfirmed ? " (total akhir)" : " (subtotal menu, ongkir belum ditetapkan)"}`;
      link.textContent = "Buka pesanan ini"; link.href = tracking.url; link.referrerPolicy = "no-referrer";
      link.addEventListener("click", event => {
        if (!validChallenge(challenge)) { event.preventDefault(); expire(); return; }
        window.DapoerOrderRecovery?.selectRecovered?.({ id: tracking.id, token: tracking.token, expiresAt: challenge.expiresAt });
      });
      card.append(heading, summary, link); root.append(card);
    }
    $("#phone-recovery-results").hidden = false; $("#phone-recovery-challenge").hidden = true; $("#phone-recovery-request").hidden = true;
    $("#phone-recovery-restart").hidden = true;
  }
  async function verifyCode(event) {
    event?.preventDefault?.(); if (busy) return;
    if (!validChallenge(challenge)) { expire(); return; }
    const code = $("#phone-recovery-code").value;
    if (!verification && !/^[0-9]{6}$/.test(code)) { notice("Isi kode 6 digit yang dikirim admin melalui WhatsApp.", true); $("#phone-recovery-code").focus(); return; }
    if (!verification) { const requestId = newId(); if (!requestId) { notice("Gunakan browser terbaru untuk memverifikasi pesanan.", true); return; } verification = { requestId, code, challengeId: challenge.challengeId, savedAt: Date.now() }; store(VERIFY_KEY, verification); }
    const intent = { ...verification }, turn = generation; busy = true; notice(""); render();
    try {
      const { response, data } = await post({ action: "verify-recovery", challengeId: intent.challengeId, code: intent.code, requestId: intent.requestId });
      if (turn !== generation) return;
      if (!validChallenge(challenge)) { expire(); return; }
      if (!response.ok) { if ([400, 401, 403, 404, 409].includes(response.status)) clearVerification(); notice(response.status === 429 ? "Terlalu banyak percobaan. Tunggu beberapa saat sebelum memeriksa kode yang sama." : "Verifikasi belum dapat dipastikan. Periksa kode yang sama atau hubungi admin.", true); return; }
      if (data.status === "expired") { expire(); return; }
      if (data.status === "awaiting-admin") { clearVerification(); notice("Kode belum dikirim admin. Hubungi admin melalui tombol WhatsApp, lalu masukkan kode setelah menerimanya."); return; }
      if (data.status === "invalid" && Number.isInteger(data.remainingAttempts) && data.remainingAttempts >= 0 && data.remainingAttempts < 5) {
        clearVerification(); $("#phone-recovery-code").value = "";
        if (!data.remainingAttempts) { expire(); return; }
        notice(`Kode belum sesuai. Periksa pesan WhatsApp dari admin. Sisa ${data.remainingAttempts} percobaan.`, true); return;
      }
      const orders = data.status === "verified" ? safeOrders(data.orders) : null;
      if (!orders) throw new Error("invalid response");
      clearVerification(); $("#phone-recovery-code").value = ""; notice("Nomor berhasil diverifikasi. Buka pesanan yang ingin dilanjutkan.");
      busy = false; render(); showOrders(orders); return;
    } catch { if (turn === generation) notice("Koneksi belum memastikan verifikasi. Tekan Periksa Kode yang Sama untuk melanjutkan tanpa mengulang percobaan.", true); }
    finally { if (turn === generation && busy) { busy = false; render(); } }
  }
  document.addEventListener("DOMContentLoaded", () => {
    const tracking = window.DapoerOrderRecovery?.safeOrderUrl(`/track/${location.search}`, "/track/"); if (!$("#phone-recovery") || tracking) return;
    initialized = true; $("#phone-recovery").hidden = false;
    const saved = read(KEY); if (validChallenge(saved)) challenge = { challengeId: saved.challengeId, expiresAt: saved.expiresAt }; else store(KEY, null);
    const previous = read(PENDING_KEY); if (!challenge && validPending(previous)) { pending = previous; $("#phone-recovery-phone").value = previous.phone; } else store(PENDING_KEY, null);
    const previousVerification = read(VERIFY_KEY); if (validVerification(previousVerification)) { verification = previousVerification; $("#phone-recovery-code").value = previousVerification.code; } else clearVerification();
    $("#phone-recovery-request").addEventListener("submit", requestCode); $("#phone-recovery-verify").addEventListener("submit", verifyCode);
    $("#phone-recovery-restart").addEventListener("click", restart); $("#phone-recovery-clear").addEventListener("click", restart);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && challenge && !validChallenge(challenge)) expire(); });
    window.addEventListener("pageshow", () => { if (challenge && !validChallenge(challenge)) expire(); });
    render();
  });
})();
