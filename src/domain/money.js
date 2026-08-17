import { AppError } from "./errors.js";

export const USDC_DECIMALS = 6;
export const USDC_SCALE = 1_000_000n;

export function parseUsdc(value) {
  const text = String(value ?? "").trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(text)) {
    throw new AppError("USDC amounts must be non-negative decimals with at most 6 places", {
      code: "INVALID_MONEY",
    });
  }
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

export function formatUsdc(atomic, { trim = false } = {}) {
  const amount = BigInt(atomic);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / USDC_SCALE;
  let fraction = String(absolute % USDC_SCALE).padStart(USDC_DECIMALS, "0");
  if (trim) fraction = fraction.replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function ceilDiv(numerator, denominator) {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d <= 0n) throw new AppError("Money rate denominator must be positive");
  return n === 0n ? 0n : (n + d - 1n) / d;
}

export function applyBasisPoints(amount, basisPoints) {
  return ceilDiv(BigInt(amount) * BigInt(basisPoints), 10_000n);
}

export function sumAtomic(values) {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

export function publicMoney(atomic) {
  return { atomic: String(atomic), usdc: formatUsdc(atomic) };
}
