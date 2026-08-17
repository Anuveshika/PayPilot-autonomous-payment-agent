import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../domain/errors.js";

export function verifyRazorpayCheckoutSignature({ orderId, paymentId, signature }, keySecret) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  return secureEqual(hmac(`${orderId}|${paymentId}`, keySecret), signature);
}

export function verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret) {
  if ((!Buffer.isBuffer(rawBody) && typeof rawBody !== "string") || !signature || !webhookSecret) return false;
  return secureEqual(hmac(rawBody, webhookSecret), signature);
}

export function assertFreshRazorpayWebhook(payload, { now = Date.now(), maximumAgeMs = 5 * 60_000 } = {}) {
  const createdAtSeconds = Number(payload?.created_at);
  if (!Number.isFinite(createdAtSeconds)) {
    throw new AppError("Razorpay webhook is missing created_at", { code: "RAZORPAY_WEBHOOK_INVALID" });
  }
  const age = now - createdAtSeconds * 1_000;
  if (age < -60_000 || age > maximumAgeMs) {
    throw new AppError("Razorpay webhook is outside the accepted replay window", { code: "RAZORPAY_WEBHOOK_STALE" });
  }
  return true;
}

function hmac(value, secret) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function secureEqual(expected, received) {
  const left = Buffer.from(String(expected), "utf8");
  const right = Buffer.from(String(received), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
