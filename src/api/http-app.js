import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AppError, ConflictError } from "../domain/errors.js";
import { listBusinesses, listServices } from "../businesses/registry.js";
import { defaultAgentPolicy } from "../agents/user-payment-agent.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(currentDirectory, "..", "public");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export function createHttpApp(context) {
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && staticFiles.has(url.pathname)) {
        const [fileName, contentType] = staticFiles.get(url.pathname);
        response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
        response.end(await readFile(join(publicDirectory, fileName)));
        return;
      }
      await route(context, request, response, url);
    } catch (error) {
      sendError(response, error);
    }
  });
  return server;
}

async function route(context, request, response, url) {
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/health") {
    return json(response, 200, { status: "ok", paymentMode: context.config.paymentMode, emergencyStop: context.config.emergencyStop });
  }
  if (request.method === "GET" && pathname === "/v1/businesses") return json(response, 200, { data: listBusinesses() });
  if (request.method === "GET" && pathname === "/v1/services") return json(response, 200, { data: listServices() });
  if (request.method === "GET" && pathname === "/v1/sessions") {
    return json(response, 200, { data: context.sessionService.list({ userId: url.searchParams.get("userId") || undefined }) });
  }
  if (request.method === "POST" && pathname === "/v1/sessions") {
    const session = await context.sessionService.create(await readJson(request));
    return json(response, 201, { data: session });
  }

  const match = pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(authorize|start|cancel|events|receipt|stream))?$/);
  if (match) {
    const [, sessionId, action] = match;
    if (request.method === "GET" && !action) return json(response, 200, { data: context.sessionService.get(sessionId) });
    if (request.method === "GET" && action === "events") return json(response, 200, { data: context.usageLedger.list(sessionId) });
    if (request.method === "GET" && action === "receipt") {
      const session = context.sessionService.getRaw(sessionId);
      if (!session.receipt) throw new ConflictError("Receipt is available only after settlement", "RECEIPT_NOT_READY");
      return json(response, 200, { data: session.receipt });
    }
    if (request.method === "GET" && action === "stream") return streamSession(context, sessionId, request, response);
    if (request.method === "POST" && action === "authorize") {
      const body = await readJson(request);
      let authorization = body.authorization;
      let evaluation = null;
      if (!authorization) {
        if (context.paymentRail.mode !== "demo") {
          throw new AppError("An external signed authorization is required outside demo mode", { code: "AUTHORIZATION_REQUIRED" });
        }
        const session = context.sessionService.getRaw(sessionId);
        const merchants = listBusinesses();
        const services = listServices();
        const baseline = defaultAgentPolicy({ merchants, services, network: context.config.defaultNetwork });
        const policy = mergeAgentPolicy(baseline, body.agentPolicy || {});
        ({ authorization, evaluation } = await context.userPaymentAgent.authorizeMaximum(session.offer, policy));
      }
      const session = await context.sessionService.authorize(sessionId, authorization);
      return json(response, 200, { data: session, agentEvaluation: evaluation });
    }
    if (request.method === "POST" && action === "start") {
      const body = await readJson(request);
      if (body.wait === true) {
        return json(response, 200, { data: await context.orchestrator.run(sessionId) });
      }
      context.orchestrator.run(sessionId).catch((error) => {
        console.error(JSON.stringify({ level: "error", sessionId, code: error.code, message: error.message }));
      });
      return json(response, 202, { data: context.sessionService.get(sessionId), message: "Autonomous execution started" });
    }
    if (request.method === "POST" && action === "cancel") {
      await readJson(request);
      return json(response, 200, { data: await context.sessionService.cancel(sessionId) });
    }
  }
  throw new AppError("Route not found", { code: "NOT_FOUND", status: 404 });
}

function mergeAgentPolicy(baseline, requested) {
  const allowed = [
    "merchantAllowlist",
    "maximumPerSessionUsdc",
    "maximumDailyUsdc",
    "allowedServices",
    "allowedCategories",
    "allowedToken",
    "allowedNetworks",
    "maximumAuthorizationMinutes",
    "requireManualApprovalAboveUsdc",
  ];
  return Object.fromEntries(allowed.map((key) => [key, requested[key] ?? baseline[key]]));
}

function streamSession(context, sessionId, request, response) {
  context.sessionService.getRaw(sessionId);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write(`event: snapshot\ndata: ${JSON.stringify(context.sessionService.get(sessionId))}\n\n`);
  const unsubscribe = context.eventHub.subscribe(sessionId, (event) => {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new AppError("Request body exceeds 1 MB", { code: "BODY_TOO_LARGE", status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("Request body must be valid JSON", { code: "INVALID_JSON" });
  }
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = error.status || 500;
  const body = {
    error: {
      code: error.code || "INTERNAL_ERROR",
      message: status >= 500 ? "An internal error occurred" : error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  if (status >= 500) console.error(error);
  json(response, status, body);
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
}
