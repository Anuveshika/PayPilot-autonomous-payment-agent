import { PolicyError } from "../domain/errors.js";
import { SessionState } from "../domain/state-machine.js";
import { getBusiness, getService } from "../businesses/registry.js";

export class PaymentPolicyEngine {
  constructor({ store, config, offerService, paymentRail, pricingEngine }) {
    this.store = store;
    this.config = config;
    this.offerService = offerService;
    this.paymentRail = paymentRail;
    this.pricingEngine = pricingEngine;
  }

  async validateAuthorization(session, authorization) {
    const failures = [];
    const offer = session.offer;
    const business = getBusiness(session.businessId);
    const service = getService(session.serviceId);
    if (this.config.emergencyStop) failures.push("Emergency stop is enabled");
    if (session.status !== SessionState.AUTHORIZATION_REQUIRED) failures.push(`Session is ${session.status}`);
    if (!this.offerService.verify(offer)) failures.push("Offer signature or hash is invalid");
    if (new Date(offer.validUntil).getTime() <= Date.now()) failures.push("Offer has expired");
    if (new Date(authorization.validUntil).getTime() <= Date.now()) failures.push("Authorization has expired");
    if (authorization.validUntil !== offer.validUntil) failures.push("Authorization expiry changed from the signed offer");
    if (authorization.offerHash !== offer.offerHash) failures.push("Authorization is not bound to this offer");
    if (authorization.sessionId !== session.sessionId) failures.push("Authorization session does not match");
    if (authorization.payerAddress?.toLowerCase() !== session.payerAddress.toLowerCase()) failures.push("Payer wallet does not match");
    if (authorization.merchantAddress?.toLowerCase() !== business.merchantAddress.toLowerCase()) failures.push("Merchant wallet does not match registry");
    if (authorization.maximumAmountAtomic !== session.maximumChargeAtomic) failures.push("Maximum authorization changed");
    if (authorization.pricingVersion !== service.pricing.version) failures.push("Pricing version changed");
    if (authorization.currency !== this.config.token.symbol) failures.push("Currency must be USDC");
    if (authorization.tokenAddress?.toLowerCase() !== this.config.token.address.toLowerCase()) failures.push("Token contract does not match");
    if (authorization.network !== this.config.defaultNetwork) failures.push("Network is not supported");
    if (authorization.scheme !== "upto") failures.push("Authorization must use the upto scheme");
    if (!authorization.nonce) failures.push("Authorization nonce is required");
    if (authorization.nonce && this.store.read((database) => Boolean(database.usedAuthorizationNonces[authorization.nonce]))) {
      failures.push("Authorization nonce has already been used");
    }
    if (!(await this.paymentRail.verifyAuthorization(authorization))) failures.push("Payment authorization signature is invalid");
    if (failures.length) throw new PolicyError("Payment authorization rejected", "AUTHORIZATION_REJECTED", failures);
    return true;
  }

  async validateSettlement(session, authorization, events, actualAmountAtomic) {
    const failures = [];
    const service = getService(session.serviceId);
    if (this.config.emergencyStop) failures.push("Emergency stop is enabled");
    if (session.status !== SessionState.USAGE_FINALIZED) failures.push(`Session is ${session.status}, not USAGE_FINALIZED`);
    if (!authorization) failures.push("Session does not have a payment authorization");
    if (session.payment) failures.push("Session already has a payment record");
    if (new Date(authorization?.validUntil || 0).getTime() <= Date.now()) failures.push("Authorization expired before settlement");
    if (authorization?.offerHash !== session.offer.offerHash) failures.push("Authorization is not bound to the session offer");
    if (authorization?.sessionId !== session.sessionId) failures.push("Authorization session does not match");
    if (authorization?.payerAddress?.toLowerCase() !== session.payerAddress.toLowerCase()) failures.push("Authorization payer does not match");
    if (authorization?.merchantAddress?.toLowerCase() !== session.merchantAddress.toLowerCase()) failures.push("Authorization merchant does not match");
    if (authorization?.maximumAmountAtomic !== session.maximumChargeAtomic) failures.push("Authorization maximum does not match");
    if (authorization?.pricingVersion !== session.pricingVersion) failures.push("Authorization pricing version does not match");
    if (authorization?.currency !== this.config.token.symbol) failures.push("Authorization currency is not USDC");
    if (authorization?.tokenAddress?.toLowerCase() !== this.config.token.address.toLowerCase()) failures.push("Authorization token contract does not match");
    if (authorization?.network !== session.network) failures.push("Authorization network does not match");
    if (authorization?.validUntil !== session.offer.validUntil) failures.push("Authorization expiry does not match the signed offer");
    if (BigInt(actualAmountAtomic) > BigInt(session.maximumChargeAtomic)) failures.push("Actual charge exceeds authorized maximum");
    if (BigInt(actualAmountAtomic) < 0n) failures.push("Actual charge cannot be negative");
    if (authorization?.nonce && this.store.read((database) => Boolean(database.usedAuthorizationNonces[authorization.nonce]))) {
      failures.push("Authorization nonce has already been settled");
    }
    if (authorization && !(await this.paymentRail.verifyAuthorization(authorization))) failures.push("Authorization signature is invalid");
    for (const event of events) {
      if (event.sessionId !== session.sessionId) failures.push(`Usage event ${event.eventId} belongs to another session`);
      if (event.pricingVersion !== session.pricingVersion) failures.push(`Usage event ${event.eventId} uses another pricing version`);
    }
    try {
      const recalculated = this.pricingEngine.calculateFinal(service.pricing, events);
      if (recalculated !== BigInt(actualAmountAtomic)) failures.push("Final amount does not match deterministic usage calculation");
    } catch (error) {
      failures.push(error.message);
    }
    if (failures.length) throw new PolicyError("Settlement policy rejected the charge", "SETTLEMENT_REJECTED", failures);
    return true;
  }
}
