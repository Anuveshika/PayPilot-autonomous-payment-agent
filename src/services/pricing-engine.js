import { AppError } from "../domain/errors.js";
import { ceilDiv, formatUsdc, sumAtomic } from "../domain/money.js";

export class PricingEngine {
  calculateEvent(policy, eventType, quantity) {
    const numericQuantity = BigInt(quantity);
    if (numericQuantity <= 0n) {
      throw new AppError("Usage quantity must be a positive integer", { code: "INVALID_USAGE_QUANTITY" });
    }
    if (eventType === "BASE_FEE") return BigInt(policy.baseFeeAtomic) * numericQuantity;
    const rate = policy.rates[eventType];
    if (!rate) throw new AppError(`Unsupported usage event type '${eventType}'`, { code: "UNSUPPORTED_USAGE_TYPE" });
    const numerator = BigInt(rate.numeratorAtomic);
    const denominator = BigInt(rate.denominator);
    if (numerator < 0n) return -ceilDiv(numericQuantity * -numerator, denominator);
    return ceilDiv(numericQuantity * numerator, denominator);
  }

  calculateFinal(policy, events) {
    for (const event of events) {
      const expected = this.calculateEvent(policy, event.eventType, event.quantity);
      if (expected !== BigInt(event.calculatedAmountAtomic)) {
        throw new AppError(`Usage event '${event.eventId}' failed deterministic price validation`, {
          code: "USAGE_INTEGRITY_FAILURE",
        });
      }
    }
    const subtotal = sumAtomic(events.map((event) => event.calculatedAmountAtomic));
    const minimum = BigInt(policy.minimumChargeAtomic || 0);
    return subtotal > 0n && subtotal < minimum ? minimum : subtotal;
  }

  explain(events) {
    const grouped = new Map();
    for (const event of events) {
      const current = grouped.get(event.eventType) || { eventType: event.eventType, quantity: 0n, amountAtomic: 0n, events: 0 };
      current.quantity += BigInt(event.quantity);
      current.amountAtomic += BigInt(event.calculatedAmountAtomic);
      current.events += 1;
      grouped.set(event.eventType, current);
    }
    return [...grouped.values()].map((item) => ({
      eventType: item.eventType,
      quantity: String(item.quantity),
      amountAtomic: String(item.amountAtomic),
      amountUsdc: formatUsdc(item.amountAtomic),
      events: item.events,
    }));
  }
}
