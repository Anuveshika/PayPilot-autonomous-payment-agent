import { createId } from "../domain/ids.js";
import { signHmac, verifyHmac } from "../domain/canonical.js";
import { parseUsdc, sumAtomic } from "../domain/money.js";
import { PolicyError } from "../domain/errors.js";

export class DemoPaymentRail {
  constructor(store, config) {
    this.store = store;
    this.secret = config.demoRailSecret;
    this.mode = "demo";
  }

  #walletSecret(walletAddress) {
    return signHmac({ walletAddress: walletAddress.toLowerCase() }, this.secret);
  }

  async getBalance(walletAddress) {
    const spent = this.store.read((database) => sumAtomic(
      Object.values(database.settlements)
        .filter((settlement) => settlement.payerAddress.toLowerCase() === walletAddress.toLowerCase() && settlement.status === "SETTLED")
        .map((settlement) => settlement.amountAtomic),
    ));
    return parseUsdc("10.00") - spent;
  }

  async getDailySpend(walletAddress, date = new Date().toISOString().slice(0, 10)) {
    return this.store.read((database) => sumAtomic(
      Object.values(database.settlements)
        .filter((settlement) => settlement.payerAddress.toLowerCase() === walletAddress.toLowerCase()
          && settlement.status === "SETTLED" && settlement.createdAt.startsWith(date))
        .map((settlement) => settlement.amountAtomic),
    ));
  }

  async createAuthorization(offer) {
    const payload = {
      scheme: offer.scheme,
      offerHash: offer.offerHash,
      sessionId: offer.sessionId,
      payerAddress: offer.payerAddress,
      merchantAddress: offer.merchantAddress,
      maximumAmountAtomic: offer.maximumAmountAtomic,
      pricingVersion: offer.pricingVersion,
      network: offer.network,
      tokenAddress: offer.tokenAddress,
      currency: offer.currency,
      nonce: createId("authnonce"),
      validUntil: offer.validUntil,
      createdAt: new Date().toISOString(),
      rail: "demo-signed-cap",
    };
    return { ...payload, signature: signHmac(payload, this.#walletSecret(offer.payerAddress)) };
  }

  async verifyAuthorization(authorization) {
    const { signature, ...payload } = authorization;
    return verifyHmac(payload, signature, this.#walletSecret(authorization.payerAddress));
  }

  async settle({ session, authorization, amountAtomic, idempotencyKey }) {
    const existing = this.store.read((database) => database.settlementIdempotency[idempotencyKey]
      ? database.settlements[database.settlementIdempotency[idempotencyKey]]
      : null);
    if (existing) return existing;
    const balance = await this.getBalance(session.payerAddress);
    if (BigInt(amountAtomic) > balance) throw new PolicyError("Demo wallet has insufficient balance", "INSUFFICIENT_BALANCE");
    return {
      paymentId: createId("pay"),
      provider: "demo-signed-cap",
      status: "SETTLED",
      sessionId: session.sessionId,
      payerAddress: session.payerAddress,
      merchantAddress: session.merchantAddress,
      amountAtomic: String(amountAtomic),
      authorizationNonce: authorization.nonce,
      idempotencyKey,
      transactionReference: `demo:${createId("tx")}`,
      createdAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
    };
  }
}
