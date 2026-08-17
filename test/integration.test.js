import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppContext } from "../src/app-context.js";
import { defaultAgentPolicy } from "../src/agents/user-payment-agent.js";
import { listBusinesses, listServices } from "../src/businesses/registry.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "payment-agent-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = await createAppContext({
    config: {
      dataFile: join(directory, "database.json"),
      offerSigningSecret: "test-offer-secret-that-is-long-enough",
      demoRailSecret: "test-rail-secret-that-is-different",
    },
  });
  const agentPolicy = defaultAgentPolicy({
    merchants: listBusinesses(),
    services: listServices(),
    network: context.config.defaultNetwork,
  });
  return { context, agentPolicy };
}

async function createSession(context, overrides = {}) {
  return context.sessionService.create({
    userId: "test_user",
    payerAddress: wallet,
    service: "supplier-research",
    maximumChargeUsdc: "1.00",
    input: { industry: "Food packaging", location: "Bengaluru", priority: "balanced" },
    ...overrides,
  });
}

test("autonomous capped flow settles actual usage and delivers a signed receipt", async (t) => {
  const { context, agentPolicy } = await fixture(t);
  let session = await createSession(context);
  assert.equal(session.status, "AUTHORIZATION_REQUIRED");
  assert.equal(session.offer.scheme, "upto");

  const decision = await context.userPaymentAgent.authorizeMaximum(session.offer, agentPolicy);
  session = await context.sessionService.authorize(session.sessionId, decision.authorization);
  assert.equal(session.status, "AUTHORIZED");

  session = await context.orchestrator.run(session.sessionId);
  assert.equal(session.status, "DELIVERED");
  assert.ok(BigInt(session.receipt.actualChargeAtomic) > 0n);
  assert.ok(BigInt(session.receipt.actualChargeAtomic) < BigInt(session.maximumChargeAtomic));
  assert.equal(
    BigInt(session.receipt.actualChargeAtomic) + BigInt(session.receipt.amountNotChargedAtomic),
    BigInt(session.maximumChargeAtomic),
  );
  assert.ok(session.result.findings.length >= 3);
  assert.ok(context.usageLedger.list(session.sessionId).length >= 6);
  assert.match(session.receipt.transactionReference, /^demo:/);
  assert.equal(context.userPaymentAgent.verifyReceipt(session.receipt, context.sessionService.getRaw(session.sessionId).offer).valid, true);
  assert.equal(context.store.read((database) => Object.keys(database.settlements).length), 1);
});

test("user payment agent rejects a merchant outside its allowlist", async (t) => {
  const { context, agentPolicy } = await fixture(t);
  const session = await createSession(context);
  await assert.rejects(
    context.userPaymentAgent.authorizeMaximum(session.offer, { ...agentPolicy, merchantAllowlist: [] }),
    (error) => error.code === "AGENT_POLICY_REJECTED" && error.details.includes("merchantAllowlisted"),
  );
});

test("merchant policy rejects authorization tampering", async (t) => {
  const { context, agentPolicy } = await fixture(t);
  const session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, agentPolicy);
  authorization.maximumAmountAtomic = "2000000";
  await assert.rejects(
    context.sessionService.authorize(session.sessionId, authorization),
    (error) => error.code === "AUTHORIZATION_REJECTED",
  );
});

test("low cap stops expensive work and settles only completed usage", async (t) => {
  const { context, agentPolicy } = await fixture(t);
  let session = await createSession(context, {
    service: "campaign-concept",
    maximumChargeUsdc: "0.10",
    input: { product: "Expense agent", audience: "Finance teams" },
  });
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, agentPolicy);
  await context.sessionService.authorize(session.sessionId, authorization);
  session = await context.orchestrator.run(session.sessionId);
  assert.equal(session.status, "DELIVERED");
  assert.equal(session.result.partial, true);
  assert.ok(BigInt(session.receipt.actualChargeAtomic) <= 100_000n);
  assert.ok(session.stateHistory.some((entry) => entry.state === "LIMIT_REACHED"));
});

test("usage idempotency returns one immutable event", async (t) => {
  const { context, agentPolicy } = await fixture(t);
  let session = await createSession(context);
  const { authorization } = await context.userPaymentAgent.authorizeMaximum(session.offer, agentPolicy);
  await context.sessionService.authorize(session.sessionId, authorization);
  await context.sessionService.transition(session.sessionId, "ACTIVE", "test metering");
  const usage = {
    eventType: "LLM_INPUT_TOKENS",
    quantity: 100,
    idempotencyKey: "same-window",
  };
  const first = await context.usageLedger.record(session.sessionId, usage);
  const second = await context.usageLedger.record(session.sessionId, usage);
  assert.equal(first.eventId, second.eventId);
  assert.equal(context.usageLedger.list(session.sessionId).length, 1);
});
