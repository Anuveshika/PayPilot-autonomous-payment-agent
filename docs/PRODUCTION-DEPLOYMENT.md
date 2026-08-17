# Production deployment runbook: Google Cloud

## Current release gate

The repository is a hardened reference application, but it intentionally fails closed in production until two adapters are supplied:

1. A transactional production store. The current JSON store is single-process and Cloud Run's writable filesystem is ephemeral.
2. A real payment rail implementing `src/payments/payment-rail.js`. Merely setting `PAYMENT_MODE=circle` or `razorpay` is rejected.

Do not bypass those checks. Complete the gates below in staging first.

## 1. Choose the production topology

Recommended Google Cloud components:

- Cloud Run: payment API/dashboard
- Cloud SQL for PostgreSQL: sessions, immutable usage, nonces, settlements, webhook events
- Secret Manager: offer-signing key, payment credentials, Razorpay webhook secret
- Vertex AI or private Cloud Run: Gemini workload
- Cloud Tasks or Pub/Sub: asynchronous execution, settlement reconciliation, webhook work
- Cloud Logging, Error Reporting, Monitoring and alert policies

Keep staging and production in separate Google Cloud projects.

## 2. Replace the local store

Create normalized PostgreSQL tables and constraints for:

- `sessions` with optimistic revision and state
- `session_state_events` append-only
- `usage_events` with unique `(session_id, idempotency_key)`
- `authorizations` with globally unique nonce
- `settlements` with unique idempotency key and provider payment ID
- `webhook_events` with unique provider event ID
- `pricing_policies` immutable by version
- `receipts` with hash/signature

Finalize in one database transaction using `SELECT ... FOR UPDATE` on the session. Cloud Run can scale horizontally, so an in-memory lock is insufficient. Use a bounded connection pool; Cloud SQL documents a per-Cloud-Run-instance connection limit.

## 3. Implement the real payment rail

For Circle/x402, implement verification, settlement, provider-status lookup, timeout-to-`PAYMENT_UNCERTAIN`, wallet and network binding, and provider IDs/transaction data in the receipt. Test on a supported testnet before mainnet.

For Razorpay, use an exact-payment or eligible mandate adapter as described in `RAZORPAY-INTEGRATION.md`; do not emulate variable capture.

## 4. Create Google Cloud identities and APIs

```bash
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com \
  aiplatform.googleapis.com cloudtasks.googleapis.com

gcloud iam service-accounts create payment-agent \
  --display-name="Autonomous payment agent"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:payment-agent@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

Grant only the specific Secret Manager secret versions and Cloud SQL/Task permissions needed. Do not grant Owner/Editor and do not store a downloaded service-account key.

## 5. Configure secrets

Generate separate high-entropy values for offer signing, payment-provider credentials, and webhooks. Store them in Secret Manager, pin explicit versions in the release, enable access audit logs, and rotate them independently. Never expose them to the browser or Gemini service.

## 6. Build and deploy staging

The included Dockerfile listens on Cloud Run's `PORT` and runs as a non-root user.

```bash
gcloud run deploy payment-agent-staging \
  --source=. \
  --region=REGION \
  --service-account=payment-agent@PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars="NODE_ENV=production,HOST=0.0.0.0,AI_PROVIDER=vertex,GOOGLE_CLOUD_PROJECT=PROJECT_ID,GOOGLE_CLOUD_LOCATION=global,GEMINI_MODEL=APPROVED_MODEL,PAYMENT_MODE=IMPLEMENTED_RAIL" \
  --set-secrets="OFFER_SIGNING_SECRET=offer-signing:VERSION" \
  --no-allow-unauthenticated
```

Attach Cloud SQL and the remaining payment secrets according to the implemented adapters. Expose only authenticated application entry points; use a separate signed public endpoint where a payment provider requires webhooks.

## 7. Staging acceptance tests

Run:

```bash
npm ci
npm run check
npm run test:coverage
```

Then test provider sandboxes/testnets for success, decline, insufficient funds, timeout, delayed success, duplicate webhook, webhook reordering, replay, authorization expiry, cap reached, concurrent finalization, refund, dispute, provider outage, database failover, task retry and emergency stop.

The automated suite currently contains 36 tests and enforces at least 88% line, 70% branch and 85% function coverage over server code. Coverage is not proof of correctness; provider sandbox and load/chaos tests remain required.

## 8. Observability and reconciliation

Add structured logs with session ID, provider ID and correlation ID, but never signatures, wallet keys, prompts containing private documents, API keys, or full webhook bodies. Alert on `PAYMENT_UNCERTAIN`, reconciliation mismatches, nonce collisions, repeated signature failures, settlement latency, dead-letter tasks and emergency-stop activation.

Run an independent reconciliation job comparing internal settlements with provider records. Never retry an uncertain payment until status lookup proves the first attempt failed.

## 9. Controlled production launch

1. Security review and threat model.
2. Legal/compliance review for jurisdictions, KYC/AML, sanctions, tax, refunds and consumer disclosures.
3. Restore/failover drill and webhook replay drill.
4. Small merchant/user allowlist, testnet first, then low mainnet/INR limits.
5. Daily reconciliation and on-call coverage.
6. Gradually raise caps only after measured success and dispute rates are acceptable.

No test suite can guarantee “without any error.” The production target is fail-closed behavior, bounded financial exposure, observable failures, idempotent recovery and a rehearsed rollback.
