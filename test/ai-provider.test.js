import test from "node:test";
import assert from "node:assert/strict";
import { DemoAiProvider, PrivateCloudRunAiProvider, VertexGeminiProvider } from "../src/ai/provider.js";

test("demo AI provider returns an isolated structured fallback and metered usage", async () => {
  const fallback = { answer: ["safe"] };
  const result = await new DemoAiProvider().generateStructured({ fallback, demoUsage: { inputTokens: 12, outputTokens: 4 } });
  assert.deepEqual(result.output, fallback);
  assert.notEqual(result.output, fallback);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 });
});

test("Vertex provider normalizes Gemini JSON and authoritative token counts", async () => {
  const calls = [];
  const client = {
    models: {
      async generateContent(request) {
        calls.push(request);
        return {
          text: "{\"summary\":\"ok\"}",
          usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 7 },
        };
      },
    },
  };
  const provider = new VertexGeminiProvider({ project: "project-id", location: "global", model: "gemini-test", timeoutMs: 1000 }, client);
  const result = await provider.generateStructured({ systemInstruction: "safe", prompt: "task", responseSchema: { type: "OBJECT" } });
  assert.deepEqual(result.output, { summary: "ok" });
  assert.deepEqual(result.usage, { inputTokens: 21, outputTokens: 7 });
  assert.equal(calls[0].config.responseMimeType, "application/json");
});

test("Vertex provider fails closed on malformed JSON or missing usage", async () => {
  const malformed = new VertexGeminiProvider(
    { project: "project-id", location: "global", model: "gemini-test", timeoutMs: 1000 },
    { models: { generateContent: async () => ({ text: "not-json", usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) } },
  );
  await assert.rejects(malformed.generateStructured({ prompt: "x" }), (error) => error.code === "AI_INVALID_RESPONSE");

  const unmetered = new VertexGeminiProvider(
    { project: "project-id", location: "global", model: "gemini-test", timeoutMs: 1000 },
    { models: { generateContent: async () => ({ text: "{\"ok\":true}" }) } },
  );
  await assert.rejects(unmetered.generateStructured({ prompt: "x" }), (error) => error.code === "AI_USAGE_MISSING");
});

test("private Cloud Run provider uses an ID-token client and correlation id", async () => {
  const observations = {};
  const auth = {
    async getIdTokenClient(audience) {
      observations.audience = audience;
      return {
        async request(request) {
          observations.request = request;
          return { data: { output: { result: "ok" }, usage: { inputTokens: 9, outputTokens: 3 }, model: "gemini-managed" } };
        },
      };
    },
  };
  const provider = new PrivateCloudRunAiProvider({
    serviceUrl: "https://ai.example/run",
    serviceAudience: "https://ai.example/",
    timeoutMs: 5000,
  }, auth);
  const result = await provider.generateStructured({ prompt: "task", correlationId: "ses:run:step" });
  assert.equal(observations.audience, "https://ai.example/");
  assert.equal(observations.request.data.correlationId, "ses:run:step");
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 3 });
});
