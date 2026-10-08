(() => {
  // This layer decorates the existing UI; it does not handle application data.
  const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const selector = ".reveal, .login-card, .admin-topbar, .stats-grid, .stock-section, .orders-section, .track-brand, .track-card, .track-help, .receipt-actions, .receipt-paper";
  const known = new WeakSet();
  const playedKeys = new Set();
  const waiting = new Set();
  const active = new Map();
  const heroTimers = new Map();
  let enabled = !preference?.matches;
  let observer;

  function remember(element) {
    known.add(element);
    const key = element.getAttribute("data-motion-key");
    if (key) playedKeys.add(key);
  }

  function stopHero(element) {
    clearTimeout(heroTimers.get(element));
    heroTimers.delete(element);
    element.classList.remove("motion-enter");
  }

  function settle(element) {
    remember(element);
    observer?.unobserve(element);
    waiting.delete(element);
  }

  function play(element, delay) {
    settle(element);
    if (!enabled || document.hidden) return;
    if (element.matches(".hero-copy, .hero-art")) {
      element.classList.add("motion-enter");
      heroTimers.set(element, setTimeout(() => stopHero(element), 1300));
      return;
    }
    if (typeof element.animate !== "function") return;
    const animation = element.animate([
      { opacity: 0, transform: "translateY(18px)" },
      { opacity: 1, transform: "translateY(0)" }
    ], { duration: 480, delay, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "backwards" });
    active.set(animation, element);
    animation.finished.then(() => active.delete(animation), () => active.delete(animation));
  }

  function reveal(root = document) {
    // Discard cards replaced by a stock poll before they entered the viewport.
    waiting.forEach(element => { if (!element.isConnected) { observer?.unobserve(element); waiting.delete(element); } });
    active.forEach((element, animation) => { if (!element.isConnected) { animation.cancel(); active.delete(animation); } });
    root.querySelectorAll(selector).forEach(element => {
      if (element.matches(".reveal")) element.classList.add("show");
      if (known.has(element) || waiting.has(element)) return;
      const key = element.getAttribute("data-motion-key");
      if (!enabled || !observer || (key && playedKeys.has(key))) { remember(element); return; }
      waiting.add(element);
      observer.observe(element);
    });
  }

  function stopAll() {
    active.forEach((element, animation) => animation.cancel());
    active.clear();
    heroTimers.forEach((timer, element) => stopHero(element));
    waiting.forEach(element => settle(element));
  }

  function updatePreference(event) {
    enabled = !event.matches;
    document.documentElement.classList.toggle("motion-enabled", enabled);
    if (!enabled) stopAll();
  }

  if (typeof window.IntersectionObserver === "function") {
    observer = new IntersectionObserver(entries => {
      let index = 0;
      entries.forEach(entry => {
        if (entry.isIntersecting && waiting.has(entry.target)) play(entry.target, Math.min(index++ * 65, 195));
      });
    }, { threshold: .08 });
  }
  document.documentElement.classList.toggle("motion-enabled", enabled);
  preference?.addEventListener?.("change", updatePreference);
  window.addEventListener("beforeprint", stopAll);
  // Keyboard focus must never wait for a visual entrance to finish.
  document.addEventListener("focusin", event => {
    waiting.forEach(element => { if (element.contains(event.target)) settle(element); });
    active.forEach((element, animation) => {
      if (element.contains(event.target)) { animation.cancel(); active.delete(animation); }
    });
    heroTimers.forEach((timer, element) => { if (element.contains(event.target)) stopHero(element); });
  });
  window.DapoerMotion = { reveal };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => reveal());
  else reveal();
})();
