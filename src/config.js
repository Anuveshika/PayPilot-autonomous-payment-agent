import { resolve } from "node:path";

function booleanEnv(name, fallback = false) {
  const value = process.env[name];
  return value === undefined ? fallback : value.toLowerCase() === "true";
}

export function loadConfig(overrides = {}) {
  const developmentSecret = "local-demo-only-change-before-production-2026";
  return {
    port: Number(process.env.PORT || 4021),
    host: process.env.HOST || "127.0.0.1",
    dataFile: resolve(process.env.DATA_FILE || ".data/database.json"),
    paymentMode: process.env.PAYMENT_MODE || "demo",
    defaultNetwork: process.env.DEFAULT_NETWORK || "eip155:84532",
    token: {
      symbol: "USDC",
      decimals: 6,
      address: process.env.USDC_TOKEN_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
    offerSigningSecret: process.env.OFFER_SIGNING_SECRET || developmentSecret,
    demoRailSecret: process.env.DEMO_RAIL_SECRET || `${developmentSecret}-rail`,
    emergencyStop: booleanEnv("EMERGENCY_STOP"),
    authorizationMinutes: 30,
    ai: {
      provider: process.env.AI_PROVIDER || "demo",
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || "global",
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      serviceUrl: process.env.AI_SERVICE_URL,
      serviceAudience: process.env.AI_SERVICE_AUDIENCE,
      timeoutMs: Number(process.env.AI_SERVICE_TIMEOUT_MS || 60_000),
    },
    ...overrides,
  };
}

export function validateProductionConfig(config) {
  if (process.env.NODE_ENV !== "production") return;
  if (config.paymentMode === "demo") throw new Error("PAYMENT_MODE=demo is forbidden in production");
  if (config.ai.provider === "demo") throw new Error("AI_PROVIDER=demo is forbidden in production");
  if (config.offerSigningSecret.includes("local-demo-only")) {
    throw new Error("OFFER_SIGNING_SECRET must be configured in production");
  }
}
