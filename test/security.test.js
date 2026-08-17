import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppContext } from "../src/app-context.js";
import { defaultAgentPolicy } from "../src/agents/user-payment-agent.js";
import { listBusinesses, listServices } from "../src/businesses/registry.js";
import { AppError } from "../src/domain/errors.js";

const wallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function setup(t, config = {}, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "payment-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = await createAppContext({
    config: {
      dataFile: join(directory, "database.json"),
      offerSigningSecret: "security-offer-secret-at-least-32-characters",
      demoRailSecret: "security-rail-secret-at-least-32-characters",
      ...config,
    },
    ...overrides,
  });
  const policy = defaultAgentPolicy({ merchants: listBusinesses(), services: listServices(), network: context.config.defaultNetwork });
  return { context, policy };
}

function createSession(context, overrides = {}) {
  return context.sessionService.create({
    userId: "security_user",
    payerAddress: wallet,
    service: "supplier-research",
    maximumChargeUsdc: "1.00",
    input: { industry: "Packaging", location: "Pune", priority: "balanced" },
    ...overrides,
  });
}

test("expired capped offer is rejected before signing", async (t) => {
  const { context, policy } = await setup(t, { authorizationMinutes: -1 });
  const session = await createSession(context);
  await assert.rejects(
    context.userPaymentAgent.authorizeMaximum(session.offer, policy),
    (error) => error.code === "AGENT_POLICY_REJECTED" && error.details.includes("expiryAllowed"),
  );
});

test("emergency stop blocks new payment authorizations", async (t) => {
  const { context, policy } = await setup(t, { emergencyStop: true });
  const session = await createSession(context);
  const authorization = await context.paymentRail.createAuthorization(session.offer);
  await assert.rejects(
    context.sessionService.authorize(session.sessionId, authorization),
    (error) => error.code === "AUTHORIZATION_REJECTED" && error.details.includes("Emergency stop is enabled"),
  );
  // User-side evaluation is intentionally independent of the merchant's emergency state.
  assert.equal((await context.userPaymentAgent.evaluateOffer(session.offer, policy)).approved, true);
});

test("authorization nonce replay is rejected", async (t) => {
  const { context, policy } = await setup(t);
  const session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  await context.store.transaction((database) => {
    database.usedAuthorizationNonces[authorization.nonce] = { sessionId: "older_session", usedAt: new Date().toISOString() };
  });
  await assert.rejects(
    context.sessionService.authorize(session.sessionId, authorization),
    (error) => error.code === "AUTHORIZATION_REJECTED" && error.details.includes("Authorization nonce has already been used"),
  );
});

test("authorization cannot be moved to another session", async (t) => {
  const { context, policy } = await setup(t);
  const first = await createSession(context);
  const second = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(first.offer, policy);
  await assert.rejects(
    context.sessionService.authorize(second.sessionId, authorization),
    (error) => error.code === "AUTHORIZATION_REJECTED",
  );
});

test("token or network tampering is rejected", async (t) => {
  const { context, policy } = await setup(t);
  const session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  authorization.tokenAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
  authorization.network = "eip155:1";
  await assert.rejects(
    context.sessionService.authorize(session.sessionId, authorization),
    (error) => error.details.includes("Token contract does not match") && error.details.includes("Network is not supported"),
  );
});

test("settlement recalculates and rejects a tampered ledger", async (t) => {
  const { context, policy } = await setup(t);
  const session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  await context.sessionService.authorize(session.sessionId, authorization);
  await context.sessionService.transition(session.sessionId, "ACTIVE", "security test");
  await context.usageLedger.record(session.sessionId, {
    eventType: "LLM_INPUT_TOKENS",
    quantity: 100,
    idempotencyKey: "integrity-event",
  });
  await context.sessionService.transition(session.sessionId, "USAGE_FINALIZED", "security test");
  await context.store.transaction((database) => {
    database.usageEvents[session.sessionId][0].calculatedAmountAtomic = "1";
  });
  await assert.rejects(
    context.merchantBillingAgent.settleAuthorizedUsage(session.sessionId),
    (error) => error.code === "USAGE_INTEGRITY_FAILURE" || error.code === "SETTLEMENT_REJECTED",
  );
});

test("two concurrent run requests create one execution and one settlement", async (t) => {
  const { context, policy } = await setup(t);
  const session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  await context.sessionService.authorize(session.sessionId, authorization);
  const [first, second] = await Promise.all([
    context.orchestrator.run(session.sessionId),
    context.orchestrator.run(session.sessionId),
  ]);
  assert.equal(first.receipt.receiptId, second.receipt.receiptId);
  assert.equal(context.store.read((database) => Object.keys(database.settlements).length), 1);
});

test("cancelled session cannot start and receipt tampering is detectable", async (t) => {
  const { context, policy } = await setup(t);
  let session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  await context.sessionService.authorize(session.sessionId, authorization);
  await context.sessionService.cancel(session.sessionId);
  await assert.rejects(context.orchestrator.run(session.sessionId), (error) => error.code === "SESSION_NOT_AUTHORIZED");

  session = await createSession(context);
  const signed = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  await context.sessionService.authorize(session.sessionId, signed.authorization);
  const completed = await context.orchestrator.run(session.sessionId);
  completed.receipt.actualChargeAtomic = "0";
  assert.equal(context.userPaymentAgent.verifyReceipt(completed.receipt, context.sessionService.getRaw(session.sessionId).offer).valid, false);
});

test("spending and manual-approval policies fail closed", async (t) => {
  const { context, policy } = await setup(t);
  const session = await createSession(context);
  const restricted = {
    ...policy,
    maximumDailyUsdc: "0.50",
    requireManualApprovalAboveUsdc: "0.25",
  };
  const evaluation = await context.userPaymentAgent.evaluateOffer(session.offer, restricted);
  assert.equal(evaluation.approved, false);
  assert.equal(evaluation.checks.withinDailyLimit, false);
  assert.equal(evaluation.checks.manualApprovalNotRequired, false);
});

test("provider-reported Gemini usage becomes deterministic ledger events", async (t) => {
  const aiProvider = {
    async generateStructured() {
      return {
        output: { title: "Generated", summary: "Safe", findings: ["Checked"], recommendation: "Review" },
        usage: { inputTokens: 321, outputTokens: 45 },
        provider: "test-vertex",
        model: "gemini-test",
      };
    },
  };
  const { context, policy } = await setup(t, {}, { aiProvider });
  const session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  await context.sessionService.authorize(session.sessionId, authorization);
  const completed = await context.orchestrator.run(session.sessionId);
  const events = context.usageLedger.list(session.sessionId);
  assert.equal(completed.result.title, "Generated");
  assert.ok(events.some((event) => event.eventType === "LLM_INPUT_TOKENS" && event.quantity === "321" && event.metadata.provider === "test-vertex"));
  assert.ok(events.some((event) => event.eventType === "LLM_OUTPUT_TOKENS" && event.quantity === "45"));
});

test("AI provider failure releases no result and submits no payment", async (t) => {
  const aiProvider = { generateStructured: async () => { throw new AppError("Gemini unavailable", { code: "AI_UNAVAILABLE", status: 503 }); } };
  const { context, policy } = await setup(t, {}, { aiProvider });
  const session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  await context.sessionService.authorize(session.sessionId, authorization);
  await assert.rejects(context.orchestrator.run(session.sessionId), (error) => error.code === "AI_UNAVAILABLE");
  const failed = context.sessionService.getRaw(session.sessionId);
  assert.equal(failed.status, "CANCELLED");
  assert.equal(failed.payment, null);
  assert.equal(failed.result, null);
});

test("ambiguous payment outcome is preserved as PAYMENT_UNCERTAIN without retry", async (t) => {
  const { context, policy } = await setup(t);
  const session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy);
  await context.sessionService.authorize(session.sessionId, authorization);
  let attempts = 0;
  context.paymentRail.settle = async () => {
    attempts += 1;
    throw new AppError("Provider timed out after submission", { code: "PAYMENT_UNCERTAIN", status: 503 });
  };
  await assert.rejects(context.orchestrator.run(session.sessionId), (error) => error.code === "PAYMENT_UNCERTAIN");
  assert.equal(context.sessionService.getRaw(session.sessionId).status, "PAYMENT_UNCERTAIN");
  assert.equal(attempts, 1);
  assert.equal(context.store.read((database) => Object.keys(database.settlements).length), 0);
});
