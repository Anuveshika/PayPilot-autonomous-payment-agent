# Production payment integration guide

The built-in `DemoPaymentRail` is intentionally not a blockchain implementation. Do not deploy it as a payment rail.

## Recommended rail choice

For capped one-time jobs, use an x402 `upto` adapter on an EVM network: the buyer authorizes a maximum and the seller supplies the deterministic atomic settlement override after execution. Current x402 seller documentation uses `@x402/express`, `@x402/core`, `@x402/evm`, `UptoEvmScheme`, and `setSettlementOverrides()`.

For streaming workloads, use small rolling exact charges. Circle Gateway Nanopayments currently documents x402 `exact` payments backed by off-chain EIP-3009 authorizations and batched settlement. Pause the service at the earliest configured exposure boundary.

Primary documentation:

- x402 seller quickstart: https://docs.cdp.coinbase.com/x402/quickstart-for-sellers
- x402 buyer quickstart: https://docs.cdp.coinbase.com/x402/quickstart-for-buyers
- Circle Gateway Nanopayments: https://developers.circle.com/gateway/nanopayments
- Circle seller quickstart: https://developers.circle.com/gateway/nanopayments/quickstarts/seller

## Adapter contract

Implement the methods described in `src/payments/payment-rail.js`, inject the adapter through `createAppContext({ paymentRail })`, and set `PAYMENT_MODE` to its production identifier.

The production adapter must:

- Accept an external wallet-signed payload; the backend must not create user signatures.
- Verify through the chosen x402 facilitator/payment provider.
- Validate payer, recipient, asset, network, amount maximum, authorization validity, nonce, and resource/session binding.
- Settle the exact deterministic `amountAtomic`, never a model-provided number.
- Return a durable provider payment ID and transaction/settlement reference.
- Make `settle()` idempotent for the supplied key.
- Resolve timeouts through provider status lookup before retrying.
- Surface ambiguous outcomes as `PAYMENT_UNCERTAIN`.

## Infrastructure gates

Before handling funds:

- Replace the JSON store with PostgreSQL or another transactional database.
- Lock the session row during finalization and enforce unique indexes on authorization nonce and settlement idempotency key.
- Add authenticated users, wallet ownership verification, authorization controls, rate limiting, audit access controls, and tenant isolation.
- Move secrets to a managed key service. Keep operational receiving wallets separate from treasury.
- Add emergency-stop runbooks, reconciliation jobs, provider webhooks/status polling, immutable audit retention, refund/credit approvals, dispute handling, and alerting.
- Implement jurisdiction-appropriate KYC/AML, sanctions, tax, consumer disclosure, privacy, and money-transmission review with qualified counsel.
- Test on a supported testnet, then use low value and strict allowlists for the first mainnet pilot.

`NODE_ENV=production` already refuses to start with `PAYMENT_MODE=demo` or the development offer-signing secret.
