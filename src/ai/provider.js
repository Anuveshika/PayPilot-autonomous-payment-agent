import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import { AppError } from "../domain/errors.js";

export class DemoAiProvider {
  constructor() {
    this.mode = "demo";
  }

  async generateStructured({ fallback, demoUsage = {} }) {
    return {
      output: structuredClone(fallback),
      usage: {
        inputTokens: positiveInteger(demoUsage.inputTokens ?? 1, "inputTokens"),
        outputTokens: positiveInteger(demoUsage.outputTokens ?? 1, "outputTokens"),
      },
      provider: "demo",
      model: "deterministic-fixture",
    };
  }
}

export class VertexGeminiProvider {
  constructor(config, client) {
    if (!config.project) throw new AppError("GOOGLE_CLOUD_PROJECT is required for AI_PROVIDER=vertex", { code: "AI_CONFIG_ERROR", status: 500 });
    this.config = config;
    this.client = client || new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location,
    });
    this.mode = "vertex";
  }

  async generateStructured({ systemInstruction, prompt, responseSchema }) {
    const response = await withTimeout(
      this.client.models.generateContent({
        model: this.config.model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.2,
        },
      }),
      this.config.timeoutMs,
    );
    return normalizeResponse({
      output: parseJson(response.text),
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
      },
      provider: "google-vertex-ai",
      model: this.config.model,
    });
  }
}

export class PrivateCloudRunAiProvider {
  constructor(config, auth = new GoogleAuth()) {
    if (!config.serviceUrl || !config.serviceAudience) {
      throw new AppError("AI_SERVICE_URL and AI_SERVICE_AUDIENCE are required for AI_PROVIDER=cloud-run", {
        code: "AI_CONFIG_ERROR",
        status: 500,
      });
    }
    this.config = config;
    this.auth = auth;
    this.mode = "cloud-run";
  }

  async generateStructured(request) {
    const client = await this.auth.getIdTokenClient(this.config.serviceAudience);
    const response = await client.request({
      url: this.config.serviceUrl,
      method: "POST",
      data: {
        operation: "generateStructured",
        systemInstruction: request.systemInstruction,
        prompt: request.prompt,
        responseSchema: request.responseSchema,
        correlationId: request.correlationId,
      },
      timeout: this.config.timeoutMs,
    });
    return normalizeResponse({
      output: response.data?.output,
      usage: response.data?.usage,
      provider: response.data?.provider || "private-google-cloud-service",
      model: response.data?.model || "service-managed-gemini",
    });
  }
}

export function createAiProvider(config, override) {
  if (override) return override;
  if (config.ai.provider === "demo") return new DemoAiProvider();
  if (config.ai.provider === "vertex") return new VertexGeminiProvider(config.ai);
  if (config.ai.provider === "cloud-run") return new PrivateCloudRunAiProvider(config.ai);
  throw new AppError(`Unsupported AI_PROVIDER '${config.ai.provider}'`, { code: "AI_CONFIG_ERROR", status: 500 });
}

function normalizeResponse(response) {
  if (!response.output || typeof response.output !== "object" || Array.isArray(response.output)) {
    throw new AppError("AI provider returned an invalid structured output", { code: "AI_INVALID_RESPONSE", status: 502 });
  }
  return {
    ...response,
    usage: {
      inputTokens: positiveInteger(response.usage?.inputTokens, "inputTokens"),
      outputTokens: positiveInteger(response.usage?.outputTokens, "outputTokens"),
    },
  };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new AppError(`AI provider did not return a valid ${name} count`, { code: "AI_USAGE_MISSING", status: 502 });
  }
  return number;
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    throw new AppError("Gemini returned malformed JSON", { code: "AI_INVALID_RESPONSE", status: 502 });
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError("AI request timed out", { code: "AI_TIMEOUT", status: 504 })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
