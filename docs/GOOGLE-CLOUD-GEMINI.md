# Connect the payment agent to a Google Cloud Gemini project

The code supports two production patterns. Both use Google-managed identity; do not download a service-account JSON key into the container.

## Pattern A: call Vertex AI directly

Use this when the payment agent itself should call Gemini.

1. Enable Vertex AI in the Google Cloud project.
2. Create a dedicated Cloud Run service account for the payment agent.
3. Grant that service account `roles/aiplatform.user` on the project that owns the Gemini workload.
4. Configure:

```text
AI_PROVIDER=vertex
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global
GEMINI_MODEL=gemini-2.5-flash
```

`VertexGeminiProvider` uses the official `@google/genai` SDK with `vertexai: true`. On Cloud Run, Application Default Credentials are supplied by the attached service account. Google token counts are required in every response; missing or invalid counts fail closed instead of creating an estimated charge.

## Pattern B: call your existing private Cloud Run Gemini service

Use this when the deployed AI project already owns prompts, RAG, tools, model selection, or business logic. This keeps payment policy separate from AI execution.

1. Keep the existing AI Cloud Run service private.
2. Grant the payment-agent service account `roles/run.invoker` on that service.
3. Configure:

```text
AI_PROVIDER=cloud-run
AI_SERVICE_URL=https://AI_SERVICE_HOST/v1/generate
AI_SERVICE_AUDIENCE=https://AI_SERVICE_HOST/
AI_SERVICE_TIMEOUT_MS=60000
```

The payment agent obtains a Google-signed ID token with `google-auth-library` and sends this contract:

```json
{
  "operation": "generateStructured",
  "systemInstruction": "...",
  "prompt": "...",
  "responseSchema": { "type": "OBJECT" },
  "correlationId": "session:run:step"
}
```

Your service must return:

```json
{
  "output": { "title": "...", "summary": "..." },
  "usage": { "inputTokens": 1200, "outputTokens": 240 },
  "provider": "google-vertex-ai",
  "model": "your-approved-gemini-model"
}
```

Return token usage from the provider response, not from the model's prose. Use the correlation ID for tracing and idempotency; do not use it as authorization.

Example IAM binding:

```bash
gcloud run services add-iam-policy-binding AI_SERVICE_NAME \
  --region=AI_SERVICE_REGION \
  --member="serviceAccount:payment-agent@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

## Security boundary

Gemini receives validated task data and a schema for business output. It never receives a wallet key, Razorpay secret, Circle credential, settlement capability, or authority to set a charge. The payment agent meters the provider-reported token counts and the deterministic policy engine decides whether the next operation fits inside the cap.

Official references:

- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart
- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
