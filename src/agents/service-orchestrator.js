import { getService } from "../businesses/registry.js";
import { AppError, LimitReachedError } from "../domain/errors.js";
import { createId } from "../domain/ids.js";
import { formatUsdc } from "../domain/money.js";
import { SessionState } from "../domain/state-machine.js";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ServiceOrchestrator {
  constructor({ sessionService, usageLedger, merchantBillingAgent, eventHub, aiProvider }) {
    this.sessionService = sessionService;
    this.usageLedger = usageLedger;
    this.merchantBillingAgent = merchantBillingAgent;
    this.eventHub = eventHub;
    this.aiProvider = aiProvider;
    this.running = new Map();
  }

  run(sessionId) {
    if (this.running.has(sessionId)) return this.running.get(sessionId);
    const operation = this.#execute(sessionId).finally(() => this.running.delete(sessionId));
    this.running.set(sessionId, operation);
    return operation;
  }

  async #execute(sessionId) {
    let session = this.sessionService.getRaw(sessionId);
    if (session.status !== SessionState.AUTHORIZED) {
      throw new AppError(`Session must be AUTHORIZED before execution; current state is ${session.status}`, {
        code: "SESSION_NOT_AUTHORIZED",
        status: 409,
      });
    }
    const service = getService(session.serviceId);
    const runId = createId("run");
    const plan = service.plan(session.input);
    await this.sessionService.updateExecution(sessionId, { runId, plan, completedSteps: [], currentStep: null });
    await this.sessionService.transition(sessionId, SessionState.ACTIVE, "Autonomous service execution started");

    let sequence = 0;
    let activeStep = "startup";
    let result;
    try {
      await this.usageLedger.record(sessionId, {
        eventType: "BASE_FEE",
        quantity: 1,
        metadata: { description: "Session base service fee" },
        idempotencyKey: `${runId}:base-fee`,
      });
      const context = {
        meter: async (eventType, quantity, metadata) => {
          const event = await this.usageLedger.record(sessionId, {
            eventType,
            quantity,
            metadata,
            idempotencyKey: `${runId}:${activeStep}:${sequence++}`,
          });
          const current = this.usageLedger.total(sessionId);
          const raw = this.sessionService.getRaw(sessionId);
          this.eventHub.publish(sessionId, "budget.updated", {
            currentChargeUsdc: formatUsdc(current),
            remainingAuthorizationUsdc: formatUsdc(BigInt(raw.maximumChargeAtomic) - current),
            decision: "CONTINUE_WITHIN_CAP",
          });
          await pause(70);
          return event;
        },
        step: async (stepId, work) => {
          activeStep = stepId;
          const selected = plan.find((item) => item.id === stepId);
          await this.sessionService.updateExecution(sessionId, { currentStep: stepId });
          this.eventHub.publish(sessionId, "agent.decision", {
            stepId,
            rationale: `Proceed with ${selected?.label || stepId}; deterministic policy remains the final budget gate.`,
          });
          await pause(110);
          await work();
          const latest = this.sessionService.getRaw(sessionId);
          const completedSteps = [...latest.execution.completedSteps, stepId];
          await this.sessionService.updateExecution(sessionId, { currentStep: null, completedSteps });
        },
        generateStructured: async (request) => {
          const generated = await this.aiProvider.generateStructured({
            ...request,
            correlationId: `${sessionId}:${runId}:${activeStep}`,
          });
          await context.meter("LLM_INPUT_TOKENS", generated.usage.inputTokens, {
            provider: generated.provider,
            model: generated.model,
            operation: activeStep,
          });
          await context.meter("LLM_OUTPUT_TOKENS", generated.usage.outputTokens, {
            provider: generated.provider,
            model: generated.model,
            operation: activeStep,
          });
          return generated.output;
        },
      };
      result = await service.execute(context, session.input);
      await this.sessionService.setResult(sessionId, result);
      await this.sessionService.transition(sessionId, SessionState.USAGE_FINALIZED, "Service completed and immutable usage was finalized");
    } catch (error) {
      if (error instanceof LimitReachedError) {
        await this.sessionService.transition(sessionId, SessionState.LIMIT_REACHED, "Next billable operation was blocked at the authorization cap");
        result = {
          title: `${service.name} — partial result`,
          summary: "The agent stopped before an operation that would exceed the authorized maximum.",
          findings: ["Completed work is preserved.", "No charge beyond the authorized maximum was attempted."],
          recommendation: "Review the partial result or create a new capped session for additional work.",
          partial: true,
        };
        await this.sessionService.setResult(sessionId, result);
        await this.sessionService.transition(sessionId, SessionState.USAGE_FINALIZED, "Completed usage was finalized after the cap was reached");
      } else {
        const latest = this.sessionService.getRaw(sessionId);
        if (latest.status === SessionState.ACTIVE) {
          await this.sessionService.transition(sessionId, SessionState.SERVICE_FAILED, `Service failed: ${error.message}`);
          await this.sessionService.transition(sessionId, SessionState.CANCELLED, "System failure: result withheld and no settlement attempted");
        }
        throw error;
      }
    }

    await this.merchantBillingAgent.settleAuthorizedUsage(sessionId);
    await this.sessionService.transition(sessionId, SessionState.DELIVERED, "Settled result and signed receipt delivered");
    return this.sessionService.get(sessionId);
  }
}
