import { createId } from "../domain/ids.js";
import { canonicalJson, sha256, signHmac, verifyHmac } from "../domain/canonical.js";

export class OfferService {
  constructor(config) {
    this.config = config;
  }

  create({ sessionId, userId, payerAddress, business, service, maximumChargeAtomic, expiresAt }) {
    const payload = {
      protocol: "x402-inspired-capped-session/v1",
      scheme: "upto",
      sessionId,
      userId,
      payerAddress,
      merchantId: business.id,
      merchantAddress: business.merchantAddress,
      serviceId: service.id,
      serviceCategory: business.category,
      maximumAmountAtomic: String(maximumChargeAtomic),
      pricingVersion: service.pricing.version,
      currency: this.config.token.symbol,
      tokenAddress: this.config.token.address,
      tokenDecimals: this.config.token.decimals,
      network: this.config.defaultNetwork,
      recurring: false,
      validUntil: expiresAt,
      nonce: createId("offernonce"),
    };
    const offerHash = sha256(payload);
    return { ...payload, offerHash, signature: signHmac({ ...payload, offerHash }, this.config.offerSigningSecret) };
  }

  verify(offer) {
    const { signature, ...signed } = offer;
    const { offerHash, ...payload } = signed;
    return sha256(payload) === offerHash && verifyHmac(signed, signature, this.config.offerSigningSecret);
  }

  verifyReceipt(receipt) {
    const { signature, ...signed } = receipt;
    const { receiptHash, ...payload } = signed;
    return sha256(payload) === receiptHash && verifyHmac(signed, signature, this.config.offerSigningSecret);
  }

  canonicalPayload(offer) {
    return canonicalJson(offer);
  }
}
