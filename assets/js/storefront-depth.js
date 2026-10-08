(() => {
  // Decorative pointer feedback only; shopping and stock controls keep their handlers.
  const pointer = window.matchMedia?.("(hover: hover) and (pointer: fine)");
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const returning = new Map();
  let enabled = false;
  let current = null;
  let frame = 0;
  let position;

  function release(smooth = false) {
    cancelAnimationFrame(frame);
    frame = 0;
    if (!current) return;
    const { host, target, animation, rest } = current;
    const from = getComputedStyle(target).transform;
    current = null;
    animation?.cancel();
    host.classList.remove("depth-hover");
    if (!smooth || !enabled || !target.isConnected) return;
    const reset = target.animate([{ transform: from }, { transform: rest }], {
      duration: 300, easing: "cubic-bezier(.22, 1, .36, 1)"
    });
    returning.set(target, reset);
    const finish = () => { if (returning.get(target) === reset) returning.delete(target); };
    reset.finished.then(finish, finish);
  }

  function resetAll() {
    release();
    returning.forEach(animation => animation.cancel());
    returning.clear();
  }

  function updatePreference() {
    enabled = !!pointer?.matches && !reduced?.matches && typeof Element.prototype.animate === "function";
    document.documentElement.classList.toggle("depth-enabled", enabled);
    if (!enabled) resetAll();
  }

  function apply() {
    frame = 0;
    if (!current || !current.target.isConnected) { release(); return; }
    const { target, bounds, limit, rest, perspective } = current;
    const clamp = value => Math.max(-1, Math.min(1, value));
    const x = clamp((position.x - bounds.left) / bounds.width * 2 - 1);
    const y = clamp((position.y - bounds.top) / bounds.height * 2 - 1);
    const base = rest === "none" ? `perspective(${perspective}px)` : rest;
    const from = current.initial || getComputedStyle(target).transform;
    current.initial = null;
    current.animation?.cancel();
    current.animation = target.animate([
      { transform: from },
      { transform: `${base} rotateX(${(-y * limit).toFixed(2)}deg) rotateY(${(x * limit).toFixed(2)}deg)` }
    ], { duration: 180, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "forwards" });
    current.animation.finished.catch(() => {});
  }

  document.addEventListener("pointermove", event => {
    if (!enabled || event.pointerType !== "mouse") { release(); return; }
    const host = event.target.closest?.(".hero-art, .product-card");
    if (!host || host.contains(document.activeElement)) { release(true); return; }
    if (current?.host !== host) {
      release(true);
      const hero = host.classList.contains("hero-art");
      const target = host.querySelector(hero ? ".hero-scene" : ".product-depth-plane");
      if (!target) return;
      const reset = returning.get(target);
      const initial = reset ? getComputedStyle(target).transform : null;
      reset?.cancel();
      returning.delete(target);
      const bounds = host.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      current = { host, target, bounds, initial, rest: getComputedStyle(target).transform,
        limit: hero ? 6 : 3, perspective: hero ? 1100 : 1000, animation: null };
      host.classList.add("depth-hover");
    }
    position = { x: event.clientX, y: event.clientY };
    // Coalesce pointer events; there is no continuous JavaScript animation loop.
    if (!frame) frame = requestAnimationFrame(apply);
  }, { passive: true });
  document.addEventListener("pointerout", event => {
    if (current && !(event.relatedTarget instanceof Node && current.host.contains(event.relatedTarget))) release(true);
  }, { passive: true });
  document.addEventListener("pointerdown", resetAll, { passive: true });
  document.addEventListener("focusin", resetAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) resetAll(); });
  window.addEventListener("blur", resetAll);
  window.addEventListener("resize", resetAll);
  window.addEventListener("beforeprint", resetAll);
  pointer?.addEventListener?.("change", updatePreference);
  reduced?.addEventListener?.("change", updatePreference);
  updatePreference();

  function watchMenu() {
    const menu = document.querySelector("#menu-grid");
    if (!menu || typeof MutationObserver !== "function") return;
    new MutationObserver(() => {
      if (current && !current.target.isConnected) release();
      returning.forEach((animation, target) => {
        if (!target.isConnected) { animation.cancel(); returning.delete(target); }
      });
    }).observe(menu, { childList: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchMenu);
  else watchMenu();
})();
