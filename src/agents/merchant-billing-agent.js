import { createId } from "../domain/ids.js";
import { sha256, signHmac } from "../domain/canonical.js";
import { formatUsdc } from "../domain/money.js";
import { SessionState, transitionSession } from "../domain/state-machine.js";
import { getService } from "../businesses/registry.js";

export class MerchantBillingAgent {
  constructor({ store, config, paymentRail, policyEngine, pricingEngine, usageLedger, eventHub }) {
    this.store = store;
    this.config = config;
    this.paymentRail = paymentRail;
    this.policyEngine = policyEngine;
    this.pricingEngine = pricingEngine;
    this.usageLedger = usageLedger;
    this.eventHub = eventHub;
  }

  calculateFinalCharge(sessionId) {
    const session = this.store.read((database) => database.sessions[sessionId]);
    const events = this.usageLedger.list(sessionId);
    return this.pricingEngine.calculateFinal(getService(session.serviceId).pricing, events);
  }

  checkSettlementStatus(paymentId) {
    return this.store.read((database) => database.settlements[paymentId] || null);
  }

  async settleAuthorizedUsage(sessionId) {
    let session = this.store.read((database) => database.sessions[sessionId]);
    const events = this.usageLedger.list(sessionId);
    const amount = this.pricingEngine.calculateFinal(getService(session.serviceId).pricing, events);
    await this.policyEngine.validateSettlement(session, session.authorization, events, amount);
    const idempotencyKey = sha256({
      userId: session.userId,
      sessionId,
      billingWindow: "final",
      amountAtomic: String(amount),
      merchantAddress: session.merchantAddress,
    });

    session = await this.store.transaction((database) => {
      const draft = database.sessions[sessionId];
      transitionSession(draft, SessionState.SETTLEMENT_SUBMITTED, "Deterministic charge passed settlement policy");
      return draft;
    });
    this.eventHub.publish(sessionId, "payment.submitted", { amountAtomic: String(amount), amountUsdc: formatUsdc(amount) });

    try {
      const payment = await this.paymentRail.settle({
        session,
        authorization: session.authorization,
        amountAtomic: amount,
        idempotencyKey,
      });
      const receipt = this.#buildReceipt(session, events, amount, payment);
      await this.store.transaction((database) => {
        const draft = database.sessions[sessionId];
        const existingPaymentId = database.settlementIdempotency[idempotencyKey];
        const durablePayment = existingPaymentId ? database.settlements[existingPaymentId] : payment;
        database.settlements[durablePayment.paymentId] = durablePayment;
        database.settlementIdempotency[idempotencyKey] = durablePayment.paymentId;
        database.usedAuthorizationNonces[draft.authorization.nonce] = {
          sessionId,
          paymentId: durablePayment.paymentId,
          usedAt: new Date().toISOString(),
        };
        draft.payment = durablePayment;
        draft.receipt = receipt;
        transitionSession(draft, SessionState.SETTLED, "Payment rail confirmed settlement");
      });
      this.eventHub.publish(sessionId, "payment.settled", receipt);
      return receipt;
    } catch (error) {
      await this.store.transaction((database) => {
        const draft = database.sessions[sessionId];
        transitionSession(draft, error.code === "PAYMENT_UNCERTAIN" ? SessionState.PAYMENT_UNCERTAIN : SessionState.PAYMENT_FAILED, error.message);
      });
      this.eventHub.publish(sessionId, "payment.failed", { code: error.code || "PAYMENT_FAILED", message: error.message });
      throw error;
    }
  }

  #buildReceipt(session, events, amount, payment) {
    const issuedAt = new Date().toISOString();
    const maximum = BigInt(session.maximumChargeAtomic);
    const body = {
      receiptId: createId("rcpt"),
      sessionId: session.sessionId,
      userId: session.userId,
      businessId: session.businessId,
      serviceId: session.serviceId,
      payerAddress: session.payerAddress,
      merchantAddress: session.merchantAddress,
      currency: session.currency,
      network: session.network,
      pricingVersion: session.pricingVersion,
      authorizedMaximumAtomic: session.maximumChargeAtomic,
      authorizedMaximumUsdc: formatUsdc(maximum),
      actualChargeAtomic: String(amount),
      actualChargeUsdc: formatUsdc(amount),
      amountNotChargedAtomic: String(maximum - amount),
      amountNotChargedUsdc: formatUsdc(maximum - amount),
      paymentStatus: payment.status,
      paymentProvider: payment.provider,
      transactionReference: payment.transactionReference,
      usage: this.pricingEngine.explain(events),
      usageEventCount: events.length,
      offerHash: session.offer.offerHash,
      authorizationNonce: session.authorization.nonce,
      issuedAt,
    };
    const receiptHash = sha256(body);
    return { ...body, receiptHash, signature: signHmac({ ...body, receiptHash }, this.config.offerSigningSecret) };
  }
}
