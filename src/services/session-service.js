import { getBusiness, getService } from "../businesses/registry.js";
import { AppError, ConflictError, NotFoundError } from "../domain/errors.js";
import { createId } from "../domain/ids.js";
import { formatUsdc, parseUsdc, sumAtomic } from "../domain/money.js";
import { SessionState, terminalStates, transitionSession } from "../domain/state-machine.js";

const walletPattern = /^0x[a-fA-F0-9]{40}$/;

export class SessionService {
  constructor({ store, config, offerService, policyEngine, eventHub }) {
    this.store = store;
    this.config = config;
    this.offerService = offerService;
    this.policyEngine = policyEngine;
    this.eventHub = eventHub;
  }

  async create(request) {
    const service = getService(request.service);
    const business = getBusiness(service.businessId);
    const maximum = parseUsdc(request.maximumChargeUsdc);
    const serviceMaximum = BigInt(service.pricing.serviceMaximumAtomic);
    if (maximum < BigInt(service.pricing.minimumChargeAtomic) || maximum > serviceMaximum) {
      throw new AppError(`Maximum charge must be between ${formatUsdc(service.pricing.minimumChargeAtomic)} and ${formatUsdc(serviceMaximum)} USDC`, {
        code: "INVALID_SESSION_MAXIMUM",
      });
    }
    const payerAddress = String(request.payerAddress || "");
    if (!walletPattern.test(payerAddress)) throw new AppError("payerAddress must be a 20-byte EVM address", { code: "INVALID_WALLET" });
    const userId = String(request.userId || "").trim();
    if (!/^[a-zA-Z0-9_-]{3,80}$/.test(userId)) throw new AppError("userId must contain 3-80 letters, numbers, underscores, or hyphens", { code: "INVALID_USER" });
    const input = service.validateInput(request.input);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.config.authorizationMinutes * 60_000).toISOString();
    const sessionId = createId("ses");
    const offer = this.offerService.create({
      sessionId,
      userId,
      payerAddress,
      business,
      service,
      maximumChargeAtomic: maximum,
      expiresAt,
    });
    const session = {
      sessionId,
      userId,
      payerAddress,
      businessId: business.id,
      businessName: business.name,
      merchantAddress: business.merchantAddress,
      serviceId: service.id,
      serviceName: service.name,
      input,
      status: SessionState.CREATED,
      maximumChargeAtomic: String(maximum),
      pricingVersion: service.pricing.version,
      currency: this.config.token.symbol,
      network: this.config.defaultNetwork,
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      revision: 0,
      stateHistory: [{ state: SessionState.CREATED, at: createdAt, reason: "Session created" }],
      offer,
      authorization: null,
      execution: { plan: [], completedSteps: [], currentStep: null, runId: null },
      result: null,
      payment: null,
      receipt: null,
    };
    transitionSession(session, SessionState.AUTHORIZATION_REQUIRED, "Signed capped payment offer published");
    await this.store.transaction((database) => {
      database.sessions[sessionId] = session;
      database.usageEvents[sessionId] = [];
    });
    this.eventHub.publish(sessionId, "session.created", this.toPublic(session));
    return this.get(sessionId);
  }

  getRaw(sessionId) {
    const session = this.store.read((database) => database.sessions[sessionId]);
    if (!session) throw new NotFoundError("Session", sessionId);
    return session;
  }

  get(sessionId) {
    return this.toPublic(this.getRaw(sessionId));
  }

  list({ userId } = {}) {
    return this.store.read((database) => Object.values(database.sessions))
      .filter((session) => !userId || session.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => this.toPublic(session));
  }

  async authorize(sessionId, authorization) {
    const current = this.getRaw(sessionId);
    await this.policyEngine.validateAuthorization(current, authorization);
    const session = await this.store.transaction((database) => {
      const draft = database.sessions[sessionId];
      if (draft.status !== SessionState.AUTHORIZATION_REQUIRED) throw new ConflictError("Session no longer accepts authorization");
      draft.authorization = authorization;
      transitionSession(draft, SessionState.AUTHORIZED, "User payment agent authorized the capped offer");
      return draft;
    });
    this.eventHub.publish(sessionId, "session.authorized", this.toPublic(session));
    return this.toPublic(session);
  }

  async transition(sessionId, nextState, reason) {
    const session = await this.store.transaction((database) => {
      const draft = database.sessions[sessionId];
      if (!draft) throw new NotFoundError("Session", sessionId);
      return transitionSession(draft, nextState, reason);
    });
    this.eventHub.publish(sessionId, "session.state", { status: nextState, reason });
    return session;
  }

  async updateExecution(sessionId, update) {
    const session = await this.store.transaction((database) => {
      const draft = database.sessions[sessionId];
      if (!draft) throw new NotFoundError("Session", sessionId);
      Object.assign(draft.execution, update);
      draft.updatedAt = new Date().toISOString();
      draft.revision += 1;
      return draft;
    });
    this.eventHub.publish(sessionId, "execution.updated", session.execution);
    return session;
  }

  async setResult(sessionId, result) {
    return this.store.transaction((database) => {
      database.sessions[sessionId].result = result;
      database.sessions[sessionId].updatedAt = new Date().toISOString();
    });
  }

  async cancel(sessionId) {
    const session = this.getRaw(sessionId);
    if (terminalStates.has(session.status)) throw new ConflictError(`Session is already ${session.status}`);
    return this.toPublic(await this.transition(sessionId, SessionState.CANCELLED, "Cancelled by user"));
  }

  toPublic(session) {
    const events = this.store.read((database) => database.usageEvents[session.sessionId] || []);
    const current = sumAtomic(events.map((event) => event.calculatedAmountAtomic));
    const maximum = BigInt(session.maximumChargeAtomic);
    return {
      ...session,
      result: session.status === SessionState.DELIVERED ? session.result : null,
      authorizedMaximumUsdc: formatUsdc(maximum),
      currentChargeAtomic: String(current),
      currentChargeUsdc: formatUsdc(current),
      remainingAuthorizationUsdc: formatUsdc(maximum - current),
      offer: { ...session.offer, signature: session.offer.signature },
      authorization: session.authorization ? { ...session.authorization, signature: "[redacted]" } : null,
    };
  }
}
