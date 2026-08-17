import { createId } from "../domain/ids.js";
import { LimitReachedError, NotFoundError, PolicyError } from "../domain/errors.js";
import { SessionState } from "../domain/state-machine.js";
import { formatUsdc, sumAtomic } from "../domain/money.js";
import { getService } from "../businesses/registry.js";

const meterableStates = new Set([SessionState.ACTIVE]);

export class UsageLedger {
  constructor(store, pricingEngine, eventHub) {
    this.store = store;
    this.pricingEngine = pricingEngine;
    this.eventHub = eventHub;
  }

  async record(sessionId, { eventType, quantity, unit, metadata = {}, idempotencyKey }) {
    if (!idempotencyKey) throw new PolicyError("Every usage event requires an idempotency key", "MISSING_IDEMPOTENCY_KEY");
    const stored = await this.store.transaction((database) => {
      const session = database.sessions[sessionId];
      if (!session) throw new NotFoundError("Session", sessionId);
      if (!meterableStates.has(session.status)) {
        throw new PolicyError(`Usage cannot be recorded while session is ${session.status}`, "SESSION_NOT_METERABLE");
      }
      const uniqueKey = `${sessionId}:${idempotencyKey}`;
      const existingId = database.usageIdempotency[uniqueKey];
      if (existingId) return database.usageEvents[sessionId].find((event) => event.eventId === existingId);

      const service = getService(session.serviceId);
      const amount = this.pricingEngine.calculateEvent(service.pricing, eventType, quantity);
      const current = sumAtomic((database.usageEvents[sessionId] || []).map((event) => event.calculatedAmountAtomic));
      const projected = current + amount;
      if (projected > BigInt(session.maximumChargeAtomic)) {
        throw new LimitReachedError(session.maximumChargeAtomic, projected);
      }
      const event = {
        eventId: createId("evt"),
        sessionId,
        userId: session.userId,
        eventType,
        quantity: String(quantity),
        unit: unit || defaultUnit(eventType),
        calculatedAmountAtomic: String(amount),
        calculatedAmountUsdc: formatUsdc(amount),
        pricingVersion: session.pricingVersion,
        metadata,
        recordedAt: new Date().toISOString(),
        idempotencyKey,
      };
      database.usageEvents[sessionId] ||= [];
      database.usageEvents[sessionId].push(event);
      database.usageIdempotency[uniqueKey] = event.eventId;
      return event;
    });
    this.eventHub.publish(sessionId, "usage.recorded", stored);
    return stored;
  }

  list(sessionId) {
    const exists = this.store.read((database) => Boolean(database.sessions[sessionId]));
    if (!exists) throw new NotFoundError("Session", sessionId);
    return this.store.read((database) => database.usageEvents[sessionId] || []);
  }

  total(sessionId) {
    return sumAtomic(this.list(sessionId).map((event) => event.calculatedAmountAtomic));
  }
}

function defaultUnit(eventType) {
  return {
    BASE_FEE: "session",
    LLM_INPUT_TOKENS: "token",
    LLM_OUTPUT_TOKENS: "token",
    COMPUTE_SECONDS: "second",
    EXTERNAL_API_COST: "usdc-atomic-cost",
    IMAGE_GENERATION: "image",
    DOCUMENT_PAGE: "page",
    CREDIT: "usdc-atomic-credit",
  }[eventType] || "unit";
}
