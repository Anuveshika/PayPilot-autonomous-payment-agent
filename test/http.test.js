import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppContext } from "../src/app-context.js";
import { createHttpApp } from "../src/api/http-app.js";

async function startHttpFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "payment-http-"));
  const context = await createAppContext({ config: { dataFile: join(directory, "database.json") } });
  const server = createHttpApp(context);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { context, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}

test("health and discovery endpoints expose configured services", async (t) => {
  const { baseUrl } = await startHttpFixture(t);
  const health = await jsonResponse(await fetch(`${baseUrl}/health`));
  const services = await jsonResponse(await fetch(`${baseUrl}/v1/services`));
  assert.deepEqual(health.body, { status: "ok", paymentMode: "demo", emergencyStop: false });
  assert.equal(services.status, 200);
  assert.equal(services.body.data.length, 3);
});

test("HTTP boundary rejects invalid JSON, unknown routes, and invalid wallets", async (t) => {
  const { baseUrl } = await startHttpFixture(t);
  const invalidJson = await jsonResponse(await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{broken",
  }));
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.error.code, "INVALID_JSON");

  const unknown = await jsonResponse(await fetch(`${baseUrl}/v1/unknown`));
  assert.equal(unknown.status, 404);

  const invalidWallet = await jsonResponse(await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: "api_user",
      payerAddress: "not-a-wallet",
      service: "supplier-research",
      maximumChargeUsdc: "1.00",
      input: { industry: "Packaging", location: "Delhi" },
    }),
  }));
  assert.equal(invalidWallet.status, 400);
  assert.equal(invalidWallet.body.error.code, "INVALID_WALLET");
});

test("complete payment flow works through the public HTTP contract", async (t) => {
  const { baseUrl } = await startHttpFixture(t);
  const created = await jsonResponse(await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: "api_user",
      payerAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
      service: "supplier-research",
      maximumChargeUsdc: "1.00",
      input: { industry: "Packaging", location: "Delhi", priority: "balanced" },
    }),
  }));
  assert.equal(created.status, 201);
  const sessionId = created.body.data.sessionId;

  const earlyReceipt = await jsonResponse(await fetch(`${baseUrl}/v1/sessions/${sessionId}/receipt`));
  assert.equal(earlyReceipt.status, 409);
  assert.equal(earlyReceipt.body.error.code, "RECEIPT_NOT_READY");

  const authorized = await jsonResponse(await fetch(`${baseUrl}/v1/sessions/${sessionId}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(authorized.body.data.status, "AUTHORIZED");

  const completed = await jsonResponse(await fetch(`${baseUrl}/v1/sessions/${sessionId}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wait: true }),
  }));
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.status, "DELIVERED");

  const [receipt, events] = await Promise.all([
    fetch(`${baseUrl}/v1/sessions/${sessionId}/receipt`).then(jsonResponse),
    fetch(`${baseUrl}/v1/sessions/${sessionId}/events`).then(jsonResponse),
  ]);
  assert.equal(receipt.body.data.paymentStatus, "SETTLED");
  assert.ok(events.body.data.length >= 6);
});
