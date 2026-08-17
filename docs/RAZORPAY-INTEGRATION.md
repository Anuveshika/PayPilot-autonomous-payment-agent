# Use the autonomous payment agent with Razorpay

Razorpay and Circle/x402 should be two payment rails behind one session, usage, policy, and receipt system—not two competing billing systems.

## Recommended routing

| Customer and job | Rail | Experience |
|---|---|---|
| Human, fixed-price INR job | Razorpay Order + Checkout | Pay once, then run and deliver |
| Human, variable-price one-time job | Run only within an approved merchant-risk threshold, calculate actual, create an exact Razorpay Order, pay, then deliver | One final Checkout approval |
| Returning human with eligible recurring use | Razorpay UPI Autopay/subscription mandate | Initial mandate consent, subsequent exact debits within mandate rules |
| Autonomous software agent | Circle/x402 USDC | Scoped automatic authorization and settlement |

Do **not** use a normal Razorpay manual-capture payment as “authorize maximum, capture less.” Razorpay's current Capture API says the captured amount must equal the stored order amount. It is not equivalent to x402 `upto`.

If an upfront maximum is collected through Razorpay, it is a prepaid balance, not an unused amount that was “never charged.” You must clearly disclose the balance and support refund/credit treatment. The cleaner one-time variable-price flow is to request the exact Razorpay payment after deterministic usage is finalized and release the result only after `captured` confirmation.

## Integration sequence for the existing application

1. The existing backend creates the payment-agent session and stores its `sessionId` beside the Razorpay customer/order metadata.
2. The agent publishes the maximum estimate and pricing version before starting.
3. The service meters work and calculates the exact INR amount with a separately versioned INR pricing policy. Never convert USDC to INR with a hard-coded rate.
4. The backend creates the Razorpay Order server-side for the exact amount in paise and includes `sessionId` in server-controlled notes/metadata.
5. Razorpay Checkout opens only from a user action. Keep the key secret on the server.
6. Verify the Checkout signature using the server-stored order ID—not a client-supplied order ID.
7. Treat `payment.captured`/`order.paid` webhooks as durable payment confirmation. Return `200` quickly and process asynchronously.
8. Verify `X-Razorpay-Signature` over the untouched raw body, deduplicate by `x-razorpay-event-id`, and handle out-of-order events.
9. Release the result and issue a unified receipt containing rail, Razorpay order/payment IDs, amount/currency, pricing version, usage digest, and agent session ID.

This repository now includes timing-safe helpers in `src/payments/razorpay-signatures.js` for Checkout and webhook verification plus a five-minute replay-window guard. A full Razorpay rail still needs your account credentials, product choice, webhook endpoint, persistent event table, and refund policy.

## UPI detail for 2026

Razorpay documents that UPI Collect is being deprecated for most flows effective 28 February 2026. Prefer UPI Intent, QR, or Turbo UPI where applicable. Use UPI Autopay only for a genuine recurring/mandate use case and confirm account eligibility and applicable AFA/mandate limits with Razorpay.

Official references:

- https://razorpay.com/docs/developer-tools/integrations/standard-checkout/
- https://razorpay.com/docs/webhooks/validate-test/
- https://razorpay.com/docs/payments/payment-methods/upi/
- https://razorpay.com/docs/payments/payment-gateway/s2s-integration/recurring-payments/upi/
