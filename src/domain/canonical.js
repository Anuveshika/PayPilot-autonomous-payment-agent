import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function signHmac(value, secret) {
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("hex");
}

export function verifyHmac(value, signature, secret) {
  const expected = Buffer.from(signHmac(value, secret), "hex");
  const received = Buffer.from(String(signature || ""), "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
