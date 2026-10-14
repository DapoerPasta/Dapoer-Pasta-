const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../assets/js/admin-session.js"), "utf8");

function tab({ failingStorage = false } = {}) {
  const windowListeners = new Map(), sent = [], documentEvents = [];
  let receiveBroadcast;
  class BroadcastChannel {
    addEventListener(name, listener) { if (name === "message") receiveBroadcast = listener; }
    postMessage(message) { sent.push(message); }
  }
  const window = { addEventListener(name, listener) { windowListeners.set(name, listener); } };
  const context = vm.createContext({
    window, BroadcastChannel, Date, Math, crypto: require("node:crypto").webcrypto,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    document: { dispatchEvent(event) { documentEvents.push(event); } },
    localStorage: { setItem(key, value) { if (failingStorage) throw new Error("Storage disabled"); window.stored = { key, value }; } }
  });
  vm.runInContext(source, context);
  return { bridge: window.DapoerAdminSession, sent, documentEvents, window,
    broadcast: data => receiveBroadcast({ data }),
    storage: event => windowListeners.get("storage")(event) };
}

test("successful logout signals local listeners and other tabs without storing identity or credentials", () => {
  const one = tab(), two = tab();
  const events = [];
  two.bridge.subscribe(event => events.push(event));
  one.bridge.notifyLogout();
  assert.equal(one.documentEvents[0].type, "dapoer:admin-session");
  assert.deepEqual(Object.keys(one.sent[0]).sort(), ["at", "authenticated", "id", "reason"]);
  assert.equal(one.sent[0].authenticated, false);
  two.broadcast(one.sent[0]);
  two.storage({ key: one.window.stored.key, newValue: one.window.stored.value });
  assert.equal(events.length, 1);
  assert.equal(two.documentEvents.length, 1);
});

test("session bridge works when storage is blocked and unsubscribing removes the listener", () => {
  const one = tab({ failingStorage: true });
  let calls = 0;
  const unsubscribe = one.bridge.subscribe(() => calls++);
  one.bridge.notifyLogout("expired");
  assert.equal(calls, 1);
  assert.equal(one.sent[0].reason, "expired");
  unsubscribe();
  one.bridge.notifyLogout();
  assert.equal(calls, 1);
});

test("unrelated storage or malformed broadcast events cannot change session state", () => {
  const one = tab();let calls = 0;one.bridge.subscribe(() => calls++);
  one.storage({ key: "unrelated", newValue: "{}" });
  one.storage({ key: "dapoer-admin-session-v1", newValue: "not json" });
  one.broadcast({ authenticated: true, id: "login" });
  one.broadcast({ authenticated: false });
  assert.equal(calls, 0);
});
