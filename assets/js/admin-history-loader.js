(() => {
  // Returning browsers may still have the previous immutable admin script.
  if (window.DapoerAdminDailyHistory) return;
  if (typeof window.init === "function") {
    document.removeEventListener("DOMContentLoaded", window.init);
  }
  const script = document.createElement("script");
  script.src = "/assets/js/admin.js?v=20261005-tracklink&history=20261006";
  script.addEventListener("error", () => {
    const message = document.querySelector("#login-message");
    if (message) message.textContent = "Dashboard belum dapat dimuat. Silakan muat ulang halaman.";
  });
  document.head.append(script);
})();
