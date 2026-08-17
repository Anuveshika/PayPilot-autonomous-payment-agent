import { loadConfig, validateProductionConfig } from "./config.js";
import { JsonStore } from "./storage/json-store.js";
import { EventHub } from "./services/event-hub.js";
import { PricingEngine } from "./services/pricing-engine.js";
import { OfferService } from "./services/offer-service.js";
import { UsageLedger } from "./services/usage-ledger.js";
import { DemoPaymentRail } from "./payments/demo-payment-rail.js";
import { PaymentPolicyEngine } from "./services/payment-policy-engine.js";
import { SessionService } from "./services/session-service.js";
import { UserPaymentAgent } from "./agents/user-payment-agent.js";
import { MerchantBillingAgent } from "./agents/merchant-billing-agent.js";
import { ServiceOrchestrator } from "./agents/service-orchestrator.js";
import { createAiProvider } from "./ai/provider.js";

export async function createAppContext(overrides = {}) {
  const config = loadConfig(overrides.config);
  validateProductionConfig(config);
  const store = overrides.store || await new JsonStore(config.dataFile).init();
  const eventHub = new EventHub();
  const pricingEngine = new PricingEngine();
  const offerService = new OfferService(config);
  const paymentRail = overrides.paymentRail || builtInPaymentRail(store, config);
  const aiProvider = createAiProvider(config, overrides.aiProvider);
  const usageLedger = new UsageLedger(store, pricingEngine, eventHub);
  const policyEngine = new PaymentPolicyEngine({ store, config, offerService, paymentRail, pricingEngine });
  const sessionService = new SessionService({ store, config, offerService, policyEngine, eventHub });
  const userPaymentAgent = new UserPaymentAgent({ offerService, paymentRail });
  const merchantBillingAgent = new MerchantBillingAgent({
    store,
    config,
    paymentRail,
    policyEngine,
    pricingEngine,
    usageLedger,
    eventHub,
  });
  const orchestrator = new ServiceOrchestrator({ sessionService, usageLedger, merchantBillingAgent, eventHub, aiProvider });
  return {
    config,
    store,
    eventHub,
    pricingEngine,
    offerService,
    paymentRail,
    aiProvider,
    usageLedger,
    policyEngine,
    sessionService,
    userPaymentAgent,
    merchantBillingAgent,
    orchestrator,
  };
}

function builtInPaymentRail(store, config) {
  if (config.paymentMode === "demo") return new DemoPaymentRail(store, config);
  throw new Error(`PAYMENT_MODE=${config.paymentMode} requires an injected production PaymentRail adapter`);
}
