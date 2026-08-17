import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  assertFreshRazorpayWebhook,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
} from "../src/payments/razorpay-signatures.js";

test("Razorpay checkout proof is bound to the server order and payment ids", () => {
  const secret = "rzp-secret";
  const signature = createHmac("sha256", secret).update("order_123|pay_456").digest("hex");
  assert.equal(verifyRazorpayCheckoutSignature({ orderId: "order_123", paymentId: "pay_456", signature }, secret), true);
  assert.equal(verifyRazorpayCheckoutSignature({ orderId: "order_attacker", paymentId: "pay_456", signature }, secret), false);
});

test("Razorpay webhook verification uses the untouched raw request body", () => {
  const body = Buffer.from('{"event":"payment.captured","created_at":123}');
  const secret = "webhook-secret";
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyRazorpayWebhookSignature(body, signature, secret), true);
  assert.equal(verifyRazorpayWebhookSignature(Buffer.from("{}"), signature, secret), false);
});

test("Razorpay webhook replay window rejects stale events", () => {
  const now = Date.UTC(2026, 7, 12, 10, 0, 0);
  assert.equal(assertFreshRazorpayWebhook({ created_at: now / 1000 - 60 }, { now }), true);
  assert.throws(
    () => assertFreshRazorpayWebhook({ created_at: now / 1000 - 301 }, { now }),
    (error) => error.code === "RAZORPAY_WEBHOOK_STALE",
  );
});
