const elements = {
  serviceList: document.querySelector("#service-list"),
  serviceCount: document.querySelector("#service-count"),
  dynamicFields: document.querySelector("#dynamic-fields"),
  form: document.querySelector("#session-form"),
  maximum: document.querySelector("#maximum"),
  wallet: document.querySelector("#wallet"),
  launch: document.querySelector("#launch-button"),
  error: document.querySelector("#form-error"),
  empty: document.querySelector("#empty-state"),
  view: document.querySelector("#session-view"),
  title: document.querySelector("#live-title"),
  status: document.querySelector("#live-status"),
  current: document.querySelector("#current-charge"),
  maximumCharge: document.querySelector("#maximum-charge"),
  remaining: document.querySelector("#remaining-charge"),
  percent: document.querySelector("#budget-percent"),
  progress: document.querySelector("#budget-progress"),
  decision: document.querySelector("#agent-decision p"),
  plan: document.querySelector("#plan-list"),
  stepProgress: document.querySelector("#step-progress"),
  ledger: document.querySelector("#ledger-list"),
  ledgerToggle: document.querySelector("#toggle-ledger"),
  result: document.querySelector("#result-card"),
  receipt: document.querySelector("#receipt-card"),
};

const state = { services: [], selected: null, session: null, events: [], stream: null, poll: null };
const terminal = new Set(["DELIVERED", "CANCELLED", "MANUAL_REVIEW"]);
const fieldSets = {
  "supplier-research": `
    <div class="form-grid two">
      <label>Industry<input name="industry" value="Food packaging" maxlength="100" required></label>
      <label>Location<input name="location" value="Bengaluru" maxlength="100" required></label>
    </div>
    <label>Priority<select name="priority"><option value="balanced">Balanced cost and speed</option><option value="economy">Economy</option><option value="fast">Fast</option></select></label>`,
  "document-analysis": `
    <div class="form-grid two">
      <label>Document name<input name="documentName" value="Vendor agreement.pdf" maxlength="120" required></label>
      <label>Number of pages<input name="pages" type="number" value="12" min="1" max="100" required></label>
    </div>`,
  "campaign-concept": `
    <div class="form-grid two">
      <label>Product<input name="product" value="Autonomous expense platform" maxlength="120" required></label>
      <label>Audience<input name="audience" value="Finance operations leaders" maxlength="120" required></label>
    </div>`,
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  }[character]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Request failed");
    error.details = payload.error?.details;
    throw error;
  }
  return payload;
}

async function initialize() {
  const { data } = await api("/v1/services");
  state.services = data;
  state.selected = data[0]?.id;
  renderServices();
  renderFields();
}

function renderServices() {
  elements.serviceCount.textContent = `${state.services.length} services`;
  elements.serviceList.innerHTML = state.services.map((service, index) => `
    <label class="service-option ${service.id === state.selected ? "selected" : ""}" style="--accent:${escapeHtml(service.business.accent)}">
      <input type="radio" name="service-selector" value="${escapeHtml(service.id)}" ${service.id === state.selected ? "checked" : ""}>
      <div class="service-icon">${String(index + 1).padStart(2, "0")}</div>
      <small>up to ${escapeHtml(service.suggestedMaximumUsdc)}</small>
      <strong>${escapeHtml(service.business.name)}</strong>
      <p>${escapeHtml(service.name)}</p>
    </label>`).join("");
  elements.serviceList.querySelectorAll("input").forEach((input) => input.addEventListener("change", () => {
    state.selected = input.value;
    renderServices();
    renderFields();
  }));
}

function renderFields() {
  const service = state.services.find((item) => item.id === state.selected);
  elements.dynamicFields.innerHTML = fieldSets[state.selected] || "";
  if (service) elements.maximum.value = service.suggestedMaximumUsdc;
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.error.textContent = "";
  elements.launch.disabled = true;
  elements.launch.firstElementChild.textContent = "Evaluating signed offer…";
  const form = new FormData(elements.form);
  const input = {};
  for (const [key, value] of form.entries()) {
    if (!["maximumChargeUsdc", "payerAddress"].includes(key)) input[key] = key === "pages" ? Number(value) : value;
  }
  try {
    const created = await api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        userId: "demo_user",
        payerAddress: elements.wallet.value.trim(),
        service: state.selected,
        maximumChargeUsdc: elements.maximum.value.trim(),
        input,
      }),
    });
    state.session = created.data;
    state.events = [];
    renderSession();
    connectStream(state.session.sessionId);
    const authorized = await api(`/v1/sessions/${state.session.sessionId}/authorize`, { method: "POST", body: "{}" });
    state.session = authorized.data;
    const passed = Object.values(authorized.agentEvaluation?.checks || {}).filter(Boolean).length;
    const total = Object.keys(authorized.agentEvaluation?.checks || {}).length;
    elements.decision.textContent = `Offer approved automatically — ${passed}/${total} policy checks passed.`;
    renderSession();
    await api(`/v1/sessions/${state.session.sessionId}/start`, { method: "POST", body: "{}" });
    schedulePoll();
  } catch (error) {
    elements.error.textContent = `${error.message}${error.details ? `: ${error.details.join(", ")}` : ""}`;
    elements.status.className = "status-badge failed";
    elements.status.textContent = "ACTION NEEDED";
  } finally {
    elements.launch.disabled = false;
    elements.launch.firstElementChild.textContent = "Authorize & run agent";
  }
});

function connectStream(sessionId) {
  state.stream?.close();
  const stream = new EventSource(`/v1/sessions/${sessionId}/stream`);
  state.stream = stream;
  const events = ["snapshot", "session.created", "session.authorized", "session.state", "execution.updated", "usage.recorded", "budget.updated", "agent.decision", "payment.submitted", "payment.settled", "payment.failed"];
  for (const eventName of events) {
    stream.addEventListener(eventName, (message) => {
      const event = JSON.parse(message.data);
      if (eventName === "agent.decision") elements.decision.textContent = event.data?.rationale || "Agent decision recorded.";
      if (eventName === "payment.settled") elements.decision.textContent = "Actual usage settled successfully. Preparing the result and receipt.";
      refreshSession();
    });
  }
}

function schedulePoll() {
  clearTimeout(state.poll);
  state.poll = setTimeout(async () => {
    await refreshSession();
    if (state.session && !terminal.has(state.session.status)) schedulePoll();
  }, 260);
}

async function refreshSession() {
  if (!state.session) return;
  const sessionId = state.session.sessionId;
  try {
    const [session, events] = await Promise.all([api(`/v1/sessions/${sessionId}`), api(`/v1/sessions/${sessionId}/events`)]);
    state.session = session.data;
    state.events = events.data;
    renderSession();
    if (terminal.has(state.session.status)) {
      state.stream?.close();
      clearTimeout(state.poll);
    }
  } catch (error) {
    elements.error.textContent = error.message;
  }
}

function renderSession() {
  const session = state.session;
  if (!session) return;
  elements.empty.classList.add("hidden");
  elements.view.classList.remove("hidden");
  elements.title.textContent = session.serviceName;
  elements.status.textContent = session.status.replaceAll("_", " ");
  elements.status.className = `status-badge ${["CANCELLED", "PAYMENT_FAILED", "SERVICE_FAILED"].includes(session.status) ? "failed" : ""}`;
  elements.current.textContent = session.currentChargeUsdc;
  elements.maximumCharge.textContent = session.authorizedMaximumUsdc;
  elements.remaining.textContent = session.remainingAuthorizationUsdc;
  const percent = Math.min(100, Math.round((Number(session.currentChargeAtomic) / Number(session.maximumChargeAtomic)) * 100));
  elements.percent.textContent = `${percent}%`;
  elements.progress.style.width = `${percent}%`;
  renderPlan(session.execution);
  renderLedger();
  renderResult(session);
  renderReceipt(session);
}

function renderPlan(execution) {
  const plan = execution.plan || [];
  const completed = new Set(execution.completedSteps || []);
  elements.stepProgress.textContent = `${completed.size} / ${plan.length}`;
  elements.plan.innerHTML = plan.length ? plan.map((step, index) => {
    const done = completed.has(step.id);
    const active = execution.currentStep === step.id;
    return `<div class="plan-item ${done ? "done" : active ? "active" : ""}">
      <span class="check">${done ? "✓" : active ? "•" : index + 1}</span>
      <span>${escapeHtml(step.label)}</span><small>${done ? "complete" : active ? "working" : "queued"}</small>
    </div>`;
  }).join("") : `<div class="plan-item"><span class="check">•</span><span>Waiting for authorization</span><small>pending</small></div>`;
}

function renderLedger() {
  elements.ledger.innerHTML = state.events.length ? [...state.events].reverse().map((event) => `
    <div class="ledger-row"><div><strong>${escapeHtml(event.eventType.replaceAll("_", " "))}</strong><small>${escapeHtml(event.quantity)} ${escapeHtml(event.unit)}</small></div><span>${escapeHtml(event.calculatedAmountUsdc)} USDC</span></div>`).join("") : `<div class="ledger-row"><div><strong>No usage yet</strong><small>Events appear as work is completed</small></div><span>0.000000</span></div>`;
}

function renderResult(session) {
  if (!session.result) { elements.result.classList.add("hidden"); return; }
  elements.result.classList.remove("hidden");
  elements.result.innerHTML = `<h3>${escapeHtml(session.result.title)}</h3><p>${escapeHtml(session.result.summary)}</p><ul>${(session.result.findings || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><p><strong>Recommendation:</strong> ${escapeHtml(session.result.recommendation)}</p>`;
}

function renderReceipt(session) {
  if (!session.receipt) { elements.receipt.classList.add("hidden"); return; }
  elements.receipt.classList.remove("hidden");
  elements.receipt.innerHTML = `<div class="receipt-total"><div><small>ACTUAL SETTLED</small><br><strong>${escapeHtml(session.receipt.actualChargeUsdc)} USDC</strong><br><small>${escapeHtml(session.receipt.amountNotChargedUsdc)} USDC was not charged</small></div><button id="download-receipt" type="button">Download signed receipt ↓</button></div>`;
  document.querySelector("#download-receipt").addEventListener("click", () => downloadReceipt(session.receipt));
}

function downloadReceipt(receipt) {
  const blob = new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${receipt.receiptId}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

elements.ledgerToggle.addEventListener("click", () => {
  const nowHidden = elements.ledger.classList.toggle("hidden");
  elements.ledgerToggle.textContent = nowHidden ? "Show details" : "Hide details";
});

initialize().catch((error) => { elements.error.textContent = error.message; });
