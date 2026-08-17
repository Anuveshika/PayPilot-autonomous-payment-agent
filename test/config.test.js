import test from "node:test";
import assert from "node:assert/strict";
import { validateProductionConfig } from "../src/config.js";
import { createAppContext } from "../src/app-context.js";

test("production configuration refuses demo payment and AI providers", () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () => validateProductionConfig({ paymentMode: "demo", ai: { provider: "vertex" }, offerSigningSecret: "strong-secret" }),
      /PAYMENT_MODE=demo/,
    );
    assert.throws(
      () => validateProductionConfig({ paymentMode: "circle", ai: { provider: "demo" }, offerSigningSecret: "strong-secret" }),
      /AI_PROVIDER=demo/,
    );
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test("non-demo payment modes fail closed without a production adapter", async () => {
  await assert.rejects(
    createAppContext({ config: { paymentMode: "circle" } }),
    /requires an injected production PaymentRail adapter/,
  );
});
