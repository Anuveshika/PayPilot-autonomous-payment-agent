# Architecture and invariants

## Trust boundaries

The application has four deliberately separate decision layers:

1. **User payment agent** — decides whether the user permits a capped authorization.
2. **Service orchestrator** — plans and performs business work within the available cap.
3. **Deterministic billing and policy engines** — calculate money and enforce settlement invariants.
4. **Payment rail** — verifies the scoped authorization and settles an approved amount.

The service plugin can request a typed usage event. It cannot provide its own calculated price, merchant wallet, payment amount, or payment function.

## Money model

Every stored amount is a decimal string containing USDC atomic units. One USDC is `1000000` atomic units. Conversion occurs only at API/UI boundaries. Rates are rational pairs:

```json
{
  "numeratorAtomic": "2000000",
  "denominator": "1000000"
}
```

That example bills 2 USDC per million units. Multiplication and ceiling division use `BigInt`; IEEE-754 floating point is never involved.

## Immutable metering

The usage collection is append-only through `UsageLedger.record()`. Each event has a required idempotency key. A correction is a new `CREDIT` event, never an edit. Before append, the ledger deterministically prices the event and checks:

```text
current immutable usage + next priced event <= authorized maximum
```

The settlement policy recalculates every event from the session's original pricing version. Stored amounts that do not match are rejected.

## Offer binding

The signed offer binds the payer, registered merchant, service, service category, maximum, pricing version, USDC token contract, CAIP-2 network, expiry, recurrence flag, session, and unique offer nonce. The user's authorization binds the same fields through the offer hash and has its own single-use nonce.

The HMAC signatures in this repository are explicitly a local simulator. A production adapter must use wallet/facilitator verification.

## State and settlement

State transitions are allowlisted in `src/domain/state-machine.js`; skipped states fail closed. A deterministic SHA-256 settlement idempotency key binds user, session, final billing window, amount, and merchant. The authorization nonce is marked used in the same durable transaction that records confirmed settlement.

For a multi-instance production deployment, replace the JSON store with a transactional database and row/advisory lock so exactly one worker can finalize a session.

## Plugin boundary

`registerBusinessPlugin()` is callable only by trusted startup code. Each plugin supplies:

- Business identity and server-registered merchant address
- Services owned by that business
- Input validation
- Versioned deterministic pricing
- A plan used for user visibility
- Execution code using typed `step` and `meter` functions

Untrusted user input is validated before entering a plan. It never flows into payment policy fields.
