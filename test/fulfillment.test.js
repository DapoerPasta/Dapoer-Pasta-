const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { normalizeDeliveryMethod, fulfillmentMetadata, validateShippingUpdate } = require("../api/_lib/fulfillment");
const { orderFingerprint } = require("../api/_lib/operations");

test("delivery defaults preserve legacy fingerprints while pickup has a distinct checkout intent", () => {
  assert.equal(normalizeDeliveryMethod(undefined), "delivery");
  assert.equal(normalizeDeliveryMethod("pickup"), "pickup");
  for (const value of [null, "", "Delivery", "courier", 0, {}, []])
    assert.throws(() => normalizeDeliveryMethod(value), { code: "INVALID_DELIVERY_METHOD" });
  const base = { items: [{ id: "pasta", quantity: 1 }], expectedTotal: 30000,
    customer: { name: "Customer", phone: "08123456789", address: "Address", notes: "", paymentMethod: "DANA" } };
  const legacy = crypto.createHash("sha256").update(JSON.stringify({ items: base.items,
    customer: base.customer, expectedTotal: base.expectedTotal })).digest("hex");
  assert.equal(orderFingerprint(base), legacy);
  assert.equal(orderFingerprint({ ...base, deliveryMethod: "delivery" }), legacy);
  assert.notEqual(orderFingerprint({ ...base, deliveryMethod: "pickup" }), legacy);
  assert.equal(orderFingerprint({ ...base, deliveryMethod: "pickup" }),
    orderFingerprint({ ...base, customer: { ...base.customer, deliveryMethod: "pickup" } }));
});

test("fulfillment totals distinguish unknown, free delivery, charged delivery and pickup", () => {
  assert.deepEqual(fulfillmentMetadata({ total: "30000" }), { deliveryMethod: "delivery", shippingFee: null,
    itemsSubtotal: 30000, grandTotal: null, shippingConfirmed: false });
  assert.deepEqual(fulfillmentMetadata({ total: "42000", delivery_method: "delivery", shipping_fee: "12000" }),
    { deliveryMethod: "delivery", shippingFee: 12000, itemsSubtotal: 30000, grandTotal: 42000, shippingConfirmed: true });
  assert.equal(fulfillmentMetadata({ total: 30000, shippingFee: 0 }).grandTotal, 30000);
  assert.equal(fulfillmentMetadata({ total: 30000, shippingFee: 0 }).shippingConfirmed, true);
  assert.deepEqual(fulfillmentMetadata({ total: 30000, deliveryMethod: "pickup" }),
    { deliveryMethod: "pickup", shippingFee: 0, itemsSubtotal: 30000, grandTotal: 30000, shippingConfirmed: true });
});

test("shipping fee writes require a bounded integer, retry UUID and complete exact order observation", () => {
  const input = { id: "DP-order", requestId: crypto.randomUUID(), shippingFee: 12000,
    expectedStatus: "diproses", expectedUpdatedAt: "2026-10-16T01:00:00.123456Z" };
  assert.deepEqual(validateShippingUpdate(input), input);
  for (const shippingFee of [-1, 0.5, "12000", null, NaN, Infinity, 100000001, Number.MAX_SAFE_INTEGER])
    assert.throws(() => validateShippingUpdate({ ...input, shippingFee }), { code: "INVALID_SHIPPING_FEE" });
  for (const overrides of [{ requestId: undefined }, { requestId: "invalid" }])
    assert.throws(() => validateShippingUpdate({ ...input, ...overrides }), { code: "INVALID_REQUEST_ID" });
  for (const overrides of [{ expectedUpdatedAt: undefined }, { expectedStatus: undefined }, { expectedUpdatedAt: "2026-02-30T00:00:00Z" }])
    assert.throws(() => validateShippingUpdate({ ...input, ...overrides }), { code: "INVALID_EXPECTED_STATUS" });
  assert.throws(() => validateShippingUpdate({ ...input, id: "../private" }), { code: "INVALID_ORDER" });
});
