const { operationError, requestId, validateExpectedStatus } = require("./operations");

const MAX_SHIPPING_FEE = 100000000;

function normalizeDeliveryMethod(value) {
  if (value === undefined) return "delivery";
  if (value !== "delivery" && value !== "pickup") throw operationError("INVALID_DELIVERY_METHOD");
  return value;
}

function fulfillmentMetadata(order = {}) {
  const deliveryMethod = (order.deliveryMethod ?? order.delivery_method) === "pickup" ? "pickup" : "delivery";
  const rawFee = order.shippingFee !== undefined ? order.shippingFee : order.shipping_fee;
  const candidate = rawFee === null || rawFee === undefined ? null : Number(rawFee);
  const shippingFee = deliveryMethod === "pickup" ? 0 :
    Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= MAX_SHIPPING_FEE ? candidate : null;
  const total = Number(order.total);
  const itemsSubtotal = Number.isSafeInteger(total) && total >= (shippingFee ?? 0) ? total - (shippingFee ?? 0) : 0;
  const shippingConfirmed = shippingFee !== null;
  return { deliveryMethod, shippingFee, itemsSubtotal, grandTotal: shippingConfirmed ? total : null, shippingConfirmed };
}

function validateShippingUpdate(input = {}) {
  if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id)) throw operationError("INVALID_ORDER");
  const operationId = requestId(input.requestId);
  if (!operationId) throw operationError("INVALID_REQUEST_ID");
  if (!Number.isSafeInteger(input.shippingFee) || input.shippingFee < 0 || input.shippingFee > MAX_SHIPPING_FEE) {
    throw operationError("INVALID_SHIPPING_FEE");
  }
  const observed = validateExpectedStatus(input);
  if (!observed) throw operationError("INVALID_EXPECTED_STATUS");
  return { id: input.id, requestId: operationId, shippingFee: input.shippingFee, ...observed };
}

module.exports = { MAX_SHIPPING_FEE, normalizeDeliveryMethod, fulfillmentMetadata, validateShippingUpdate };
