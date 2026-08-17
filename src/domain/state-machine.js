import { ConflictError } from "./errors.js";

export const SessionState = Object.freeze({
  CREATED: "CREATED",
  AUTHORIZATION_REQUIRED: "AUTHORIZATION_REQUIRED",
  AUTHORIZED: "AUTHORIZED",
  ACTIVE: "ACTIVE",
  USAGE_FINALIZED: "USAGE_FINALIZED",
  SETTLEMENT_SUBMITTED: "SETTLEMENT_SUBMITTED",
  SETTLED: "SETTLED",
  DELIVERED: "DELIVERED",
  AUTHORIZATION_REJECTED: "AUTHORIZATION_REJECTED",
  LIMIT_REACHED: "LIMIT_REACHED",
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_UNCERTAIN: "PAYMENT_UNCERTAIN",
  SERVICE_FAILED: "SERVICE_FAILED",
  REFUND_PENDING: "REFUND_PENDING",
  CANCELLED: "CANCELLED",
  MANUAL_REVIEW: "MANUAL_REVIEW",
});

const transitions = new Map([
  [SessionState.CREATED, [SessionState.AUTHORIZATION_REQUIRED, SessionState.CANCELLED]],
  [SessionState.AUTHORIZATION_REQUIRED, [SessionState.AUTHORIZED, SessionState.AUTHORIZATION_REJECTED, SessionState.CANCELLED]],
  [SessionState.AUTHORIZATION_REJECTED, [SessionState.AUTHORIZATION_REQUIRED, SessionState.CANCELLED]],
  [SessionState.AUTHORIZED, [SessionState.ACTIVE, SessionState.CANCELLED]],
  [SessionState.ACTIVE, [SessionState.USAGE_FINALIZED, SessionState.LIMIT_REACHED, SessionState.PAYMENT_REQUIRED, SessionState.SERVICE_FAILED, SessionState.CANCELLED]],
  [SessionState.LIMIT_REACHED, [SessionState.USAGE_FINALIZED, SessionState.AUTHORIZATION_REQUIRED, SessionState.CANCELLED]],
  [SessionState.PAYMENT_REQUIRED, [SessionState.ACTIVE, SessionState.PAYMENT_FAILED, SessionState.PAYMENT_UNCERTAIN, SessionState.CANCELLED]],
  [SessionState.USAGE_FINALIZED, [SessionState.SETTLEMENT_SUBMITTED, SessionState.CANCELLED, SessionState.MANUAL_REVIEW]],
  [SessionState.SETTLEMENT_SUBMITTED, [SessionState.SETTLED, SessionState.PAYMENT_FAILED, SessionState.PAYMENT_UNCERTAIN]],
  [SessionState.PAYMENT_UNCERTAIN, [SessionState.SETTLED, SessionState.PAYMENT_FAILED, SessionState.MANUAL_REVIEW]],
  [SessionState.PAYMENT_FAILED, [SessionState.SETTLEMENT_SUBMITTED, SessionState.CANCELLED, SessionState.MANUAL_REVIEW]],
  [SessionState.SETTLED, [SessionState.DELIVERED, SessionState.REFUND_PENDING]],
  [SessionState.REFUND_PENDING, [SessionState.DELIVERED, SessionState.MANUAL_REVIEW]],
  [SessionState.SERVICE_FAILED, [SessionState.USAGE_FINALIZED, SessionState.CANCELLED, SessionState.MANUAL_REVIEW]],
]);

export function canTransition(from, to) {
  return transitions.get(from)?.includes(to) ?? false;
}

export function transitionSession(session, nextState, reason, now = new Date().toISOString()) {
  if (!canTransition(session.status, nextState)) {
    throw new ConflictError(`Cannot transition session from ${session.status} to ${nextState}`, "INVALID_STATE_TRANSITION");
  }
  session.status = nextState;
  session.updatedAt = now;
  session.revision = (session.revision || 0) + 1;
  session.stateHistory.push({ state: nextState, at: now, reason });
  return session;
}

export const terminalStates = new Set([
  SessionState.DELIVERED,
  SessionState.CANCELLED,
  SessionState.MANUAL_REVIEW,
]);
