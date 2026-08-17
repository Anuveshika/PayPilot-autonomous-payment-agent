import test from "node:test";
import assert from "node:assert/strict";
import { SessionState, transitionSession } from "../src/domain/state-machine.js";

test("session state machine rejects skipped settlement states", () => {
  const session = {
    status: SessionState.AUTHORIZED,
    revision: 0,
    stateHistory: [],
  };
  assert.throws(() => transitionSession(session, SessionState.SETTLED, "skip"), /Cannot transition/);
  transitionSession(session, SessionState.ACTIVE, "start");
  assert.equal(session.status, SessionState.ACTIVE);
});
