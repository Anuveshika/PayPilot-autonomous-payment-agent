import test from "node:test";
import assert from "node:assert/strict";
import { PricingEngine } from "../src/services/pricing-engine.js";

const policy = {
  baseFeeAtomic: "50000",
  minimumChargeAtomic: "50000",
  rates: {
    TOKENS: { numeratorAtomic: "2000000", denominator: "1000000" },
    EXTERNAL: { numeratorAtomic: "12000", denominator: "10000", quantityIsAtomic: true },
    CREDIT: { numeratorAtomic: "-1", denominator: "1", quantityIsAtomic: true },
  },
};

test("pricing engine uses rational arithmetic and upward rounding", () => {
  const engine = new PricingEngine();
  assert.equal(engine.calculateEvent(policy, "TOKENS", 1), 2n);
  assert.equal(engine.calculateEvent(policy, "EXTERNAL", 50_001), 60_002n);
  assert.equal(engine.calculateEvent(policy, "CREDIT", 10), -10n);
});

test("minimum charge applies only to positive subtotals", () => {
  const engine = new PricingEngine();
  const events = [{ eventId: "evt", eventType: "TOKENS", quantity: "10", calculatedAmountAtomic: "20" }];
  assert.equal(engine.calculateFinal(policy, events), 50_000n);
});

test("pricing engine rejects unsupported or altered usage", () => {
  const engine = new PricingEngine();
  assert.throws(() => engine.calculateEvent(policy, "UNKNOWN", 1), (error) => error.code === "UNSUPPORTED_USAGE_TYPE");
  assert.throws(
    () => engine.calculateFinal(policy, [{ eventId: "evt", eventType: "TOKENS", quantity: "10", calculatedAmountAtomic: "21" }]),
    (error) => error.code === "USAGE_INTEGRITY_FAILURE",
  );
});
