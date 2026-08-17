import test from "node:test";
import assert from "node:assert/strict";
import { applyBasisPoints, formatUsdc, parseUsdc } from "../src/domain/money.js";

test("USDC parsing uses exact six-decimal atomic integers", () => {
  assert.equal(parseUsdc("1.00"), 1_000_000n);
  assert.equal(parseUsdc("0.000001"), 1n);
  assert.equal(formatUsdc(420_000n), "0.420000");
  assert.throws(() => parseUsdc("0.0000001"), /at most 6 places/);
  assert.throws(() => parseUsdc("1e-3"), /at most 6 places/);
});

test("basis-point markup rounds upward without floating point", () => {
  assert.equal(applyBasisPoints(1n, 12_000), 2n);
  assert.equal(applyBasisPoints(50_000n, 12_000), 60_000n);
});
