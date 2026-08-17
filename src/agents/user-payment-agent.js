import { PolicyError } from "../domain/errors.js";
import { formatUsdc, parseUsdc } from "../domain/money.js";

export class UserPaymentAgent {
  constructor({ offerService, paymentRail }) {
    this.offerService = offerService;
    this.paymentRail = paymentRail;
  }

  inspectOffer(offer) {
    return {
      signatureValid: this.offerService.verify(offer),
      merchantAddress: offer.merchantAddress,
      serviceId: offer.serviceId,
      serviceCategory: offer.serviceCategory,
      maximumAmountAtomic: offer.maximumAmountAtomic,
      maximumAmountUsdc: formatUsdc(offer.maximumAmountAtomic),
      currency: offer.currency,
      network: offer.network,
      recurring: offer.recurring,
      validUntil: offer.validUntil,
    };
  }

  checkBalance(walletAddress) {
    return this.paymentRail.getBalance(walletAddress);
  }

  async evaluateOffer(offer, policy) {
    const balance = await this.paymentRail.getBalance(offer.payerAddress);
    const dailySpend = await this.paymentRail.getDailySpend(offer.payerAddress);
    const maximum = BigInt(offer.maximumAmountAtomic);
    const maxPerSession = parseUsdc(policy.maximumPerSessionUsdc);
    const maxDaily = parseUsdc(policy.maximumDailyUsdc);
    const manualThreshold = parseUsdc(policy.requireManualApprovalAboveUsdc);
    const expiryMinutes = (new Date(offer.validUntil).getTime() - Date.now()) / 60_000;
    const checks = {
      offerSignature: this.offerService.verify(offer),
      merchantAllowlisted: policy.merchantAllowlist.map((address) => address.toLowerCase()).includes(offer.merchantAddress.toLowerCase()),
      serviceAllowed: policy.allowedServices.includes(offer.serviceId),
      categoryAllowed: !policy.allowedCategories || policy.allowedCategories.includes(offer.serviceCategory),
      tokenAllowed: offer.currency === policy.allowedToken,
      networkAllowed: policy.allowedNetworks.includes(offer.network),
      nonRecurring: offer.recurring === false,
      expiryAllowed: expiryMinutes > 0 && expiryMinutes <= policy.maximumAuthorizationMinutes,
      withinSessionLimit: maximum <= maxPerSession,
      withinDailyLimit: dailySpend + maximum <= maxDaily,
      sufficientBalance: balance >= maximum,
      manualApprovalNotRequired: maximum <= manualThreshold,
    };
    return {
      approved: Object.values(checks).every(Boolean),
      checks,
      balanceUsdc: formatUsdc(balance),
      dailySpendUsdc: formatUsdc(dailySpend),
      decision: Object.values(checks).every(Boolean) ? "AUTHORIZE_AUTOMATICALLY" : "REJECT_OR_REQUEST_APPROVAL",
    };
  }

  async authorizeMaximum(offer, policy) {
    const evaluation = await this.evaluateOffer(offer, policy);
    if (!evaluation.approved) {
      const failedChecks = Object.entries(evaluation.checks).filter(([, passed]) => !passed).map(([name]) => name);
      throw new PolicyError("User payment agent rejected the offer", "AGENT_POLICY_REJECTED", failedChecks);
    }
    return { authorization: await this.paymentRail.createAuthorization(offer), evaluation };
  }

  verifyReceipt(receipt, originalOffer) {
    const checks = {
      signatureValid: this.offerService.verifyReceipt(receipt),
      offerBound: receipt.offerHash === originalOffer.offerHash,
      sessionBound: receipt.sessionId === originalOffer.sessionId,
      payerBound: receipt.payerAddress?.toLowerCase() === originalOffer.payerAddress.toLowerCase(),
      merchantBound: receipt.merchantAddress?.toLowerCase() === originalOffer.merchantAddress.toLowerCase(),
      withinMaximum: BigInt(receipt.actualChargeAtomic) <= BigInt(originalOffer.maximumAmountAtomic),
      amountReconciles: BigInt(receipt.actualChargeAtomic) + BigInt(receipt.amountNotChargedAtomic)
        === BigInt(originalOffer.maximumAmountAtomic),
    };
    return { valid: Object.values(checks).every(Boolean), checks };
  }

  reportDispute(receipt, reason) {
    return {
      type: "PAYMENT_DISPUTE_REQUEST",
      receiptId: receipt.receiptId,
      sessionId: receipt.sessionId,
      paymentReference: receipt.transactionReference,
      reason: String(reason || "").trim(),
      createdAt: new Date().toISOString(),
      status: "REQUIRES_EXTERNAL_DISPUTE_WORKFLOW",
    };
  }
}

export function defaultAgentPolicy({ merchants, services, network }) {
  return {
    merchantAllowlist: merchants.map((merchant) => merchant.merchantAddress),
    maximumPerSessionUsdc: "1.00",
    maximumDailyUsdc: "5.00",
    allowedServices: services.map((service) => service.id),
    allowedCategories: [...new Set(merchants.map((merchant) => merchant.category))],
    allowedToken: "USDC",
    allowedNetworks: [network],
    maximumAuthorizationMinutes: 30,
    requireManualApprovalAboveUsdc: "2.00",
  };
}
