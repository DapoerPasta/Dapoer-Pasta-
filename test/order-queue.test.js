const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { queueMetadata, ensureOrderQueueSchema } = require("../api/_lib/order-queue");

test("queue labels use persisted positive numbers without truncating busy days", () => {
  for (const [number, label] of [[1, "A001"], [12, "A012"], [999, "A999"], [1000, "A1000"], [2147483647, "A2147483647"]]) {
    assert.deepEqual(queueMetadata({ queue_number: number, queue_date: "2026-10-09" }), {
      queueNumber: number, queueDate: "2026-10-09", queueLabel: label
    });
  }
  assert.equal(queueMetadata({ queueNumber: 9, queueDate: "2026-10-09" }).queueLabel, "A009");
  assert.equal(queueMetadata({ queue_number: "10", queue_date: new Date("2026-10-09T00:00:00Z") }).queueLabel, "A010");
});

test("missing, malformed and impossible queue metadata never invents a printable number", () => {
  const empty = { queueNumber: null, queueDate: null, queueLabel: null };
  for (const data of [
    {}, { queue_number: 0, queue_date: "2026-10-09" },
    { queue_number: -1, queue_date: "2026-10-09" }, { queue_number: 1.5, queue_date: "2026-10-09" },
    { queue_number: 2147483648, queue_date: "2026-10-09" },
    { queue_number: 1, queue_date: "2026-02-30" }, { queue_number: 1, queue_date: "2026-13-01" },
    { queue_number: 1, queue_date: "2026-10-09<script>" }, { queue_number: null, queue_date: "2026-10-09" }
  ]) assert.deepEqual(queueMetadata(data), empty);
});

test("atomic queue migration retries rolled-back deadlocks and lock timeouts", async () => {
  let calls = 0;
  await ensureOrderQueueSchema(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("Transient schema lock"), { code: calls === 1 ? "40P01" : "55P03" });
  });
  assert.equal(calls, 3);
});

test("schema failures stop after bounded retries and unrelated errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(() => ensureOrderQueueSchema(async () => {
    calls++; throw Object.assign(new Error("Lock unavailable"), { code: "55P03" });
  }), /Lock unavailable/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(() => ensureOrderQueueSchema(async () => {
    calls++; throw Object.assign(new Error("Invalid schema"), { code: "23505" });
  }), /Invalid schema/);
  assert.equal(calls, 1);
});

test("saveOrder preserves its boolean contract and returns queue metadata from one atomic save statement", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const target = require.resolve("../api/_lib/db");
  const calls = [];
  const saved = { queueNumber: 42, queueDate: "2026-10-09", createdAt: "2026-10-09T03:00:00Z", updatedAt: "2026-10-09T03:00:00Z" };
  const sql = async (parts, ...values) => {
    const text = parts.join("?");
    calls.push({ text, values });
    return /SELECT dapoer_save_order_with_queue/.test(text) ? [{ saved }] : [];
  };
  const originalLoad = Module._load;
  process.env.DATABASE_URL = "postgresql://unit-test-only.invalid/queue";
  delete require.cache[target];
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === target && name === "@neondatabase/serverless") return { neon: () => sql };
    return originalLoad.call(this, name, parent, isMain);
  };
  let db;
  try { db = require(target); } finally { Module._load = originalLoad; }
  try {
    const order = {
      id: "DP-UNIT-QUEUE", trackingToken: "a".repeat(48),
      customer: { name: "Unit", phone: "081234567890", address: "Test address", notes: "", paymentMethod: "OVO" },
      items: [{ id: "test-product", quantity: 1 }], total: 100
    };
    assert.equal(await db.saveOrder(order), true);
    assert.equal(order.queueLabel, "A042");
    assert.equal(order.queueDate, "2026-10-09");
    assert.equal(order.createdAt, saved.createdAt);
    assert.equal(calls.filter(call => /SELECT dapoer_save_order_with_queue/.test(call.text)).length, 1);
    assert.equal(calls.filter(call => /^\s*SELECT queue_number/.test(call.text)).length, 0);
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    delete require.cache[target];
  }
});
