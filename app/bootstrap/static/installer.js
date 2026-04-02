const state = { eventSource: null, status: null, progress: 0 };
const $ = (id) => document.getElementById(id);

function updateProgress(pct) {
  if (pct === undefined || pct === null) return;
  state.progress = pct;
  const fill = $("progress-fill");
  const text = $("progress-percentage");
  if (fill) fill.style.width = `${pct}%`;
  if (text) text.textContent = `${pct}%`;
}
const PROFILE_LABELS = {
  mac: "mac",
  pi_cpu: "pi_cpu",
  pi_hailo: "pi_hailo",
};
const PROFILE_DEFAULTS = {
  mac: {
    llm_fast: "qwen2.5:7b-instruct-q4_K_M",
    llm_thinking: "qwen2.5:14b-instruct-q4_K_M",
    function_model: "gemma3:1b",
    vision_model: "llava:7b-v1.6-mistral-q4_K_M",
    stt_model: "faster-whisper base.en",
    tts_voice: "en_US-lessac-medium",
    wake_word: "openWakeWord",
  },
  pi_cpu: {
    llm_fast: "qwen2:1.5b",
    llm_thinking: "qwen2:1.5b",
    function_model: "gemma3:1b",
    vision_model: "moondream:latest",
    stt_model: "whisper.cpp base.en",
    tts_voice: "en_US-lessac-medium",
    wake_word: "openWakeWord",
  },
  pi_hailo: {
    llm_fast: "qwen2.5-instruct:1.5b",
    llm_thinking: "qwen2.5-instruct:1.5b",
    function_model: "gemma3:1b",
    vision_model: "Qwen2-VL-2B-Instruct.hef",
    stt_model: "whisper.cpp base.en",
    tts_voice: "en_US-lessac-medium",
    wake_word: "openWakeWord",
  },
};

function humanStatus(value) {
  if (value === "ready") return "Ready";
  if (value === "running") return "Running";
  if (value === "failed") return "Failed";
  if (value === "awaiting_setup") return "Awaiting setup";
  return value ? String(value) : "Idle";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || `Request failed with ${response.status}`);
  }
  return payload;
}

function applyProfileDefaults(profile, defaults) {
  Object.entries(defaults || {}).forEach(([key, value]) => {
    const field = $(key);
    if (field && !field.dataset.touched) {
      field.value = value;
    }
  });
  if ($("profile-input")) {
    $("profile-input").value = profile;
  }
}

function trackAdvancedFields() {
  [
    "llm_fast",
    "llm_thinking",
    "function_model",
    "vision_model",
    "stt_model",
    "tts_voice",
    "wake_word",
  ].forEach((id) => {
    const field = $(id);
    if (!field) {
      return;
    }
    field.addEventListener("input", () => {
      field.dataset.touched = "true";
    });
  });
}

function renderHealth(health) {
  const target = $("health-cards");
  target.innerHTML = "";
  (health.cards || []).forEach((card) => {
    const node = document.createElement("article");
    node.className = `health-card ${card.status}`;
    node.innerHTML = `<strong>${card.label}</strong><p>${card.detail}</p>`;
    target.appendChild(node);
  });
}

function renderConfigSummary(config) {
  const card = $("config-summary-card");
  const target = $("config-summary");
  if (!card || !target) {
    return;
  }
  const rows = [];
  if (config.app_name) rows.push(["App name", config.app_name]);
  if (config.admin_username) rows.push(["Admin username", config.admin_username]);
  if (config.profile) rows.push(["Platform profile", PROFILE_LABELS[config.profile] || config.profile]);
  if (config.models) {
    rows.push(["Fast LLM", config.models.llm_fast]);
    rows.push(["Thinking LLM", config.models.llm_thinking]);
    rows.push(["Function model", config.models.function_model]);
    rows.push(["Vision model", config.models.vision_model]);
    rows.push(["STT model", config.models.stt_model]);
    rows.push(["TTS voice", config.models.tts_voice]);
    rows.push(["Wake word", config.models.wake_word]);
  }
  target.innerHTML = "";
  card.classList.toggle("hidden", rows.length === 0);
  rows.forEach(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    target.appendChild(dt);
    target.appendChild(dd);
  });
}

function toggleSetupModal(show) {
  const modal = $("setup-modal");
  modal.classList.toggle("hidden", !show);
  modal.setAttribute("aria-hidden", show ? "false" : "true");
  document.body.classList.toggle("modal-open", show);
}

function renderStatus(data) {
  state.status = data;
  applyProfileDefaults(data.profile || "mac", PROFILE_DEFAULTS[data.profile || "mac"] || PROFILE_DEFAULTS.mac);
  const canLaunch = Boolean(data.can_launch);
  const hasBlockingIssues = Array.isArray(data.blocking_issues) && data.blocking_issues.length > 0;
  const focus = document.querySelector(".wizard-focus");
  if (focus) {
    focus.classList.toggle("ready-view", canLaunch);
  }

  // Main status shows the current specific action
  const summary = $("summary");
  if (summary) {
    if (canLaunch) {
      summary.textContent = "Installation complete. LokiDoki is ready to launch.";
    } else {
      summary.textContent = data.current_action || "Initialising...";
    }
  }

  const progressText = $("progress-step-text");
  if (progressText) {
    if (canLaunch) {
      progressText.textContent = "Installation complete. LokiDoki is ready to launch.";
    } else {
      progressText.textContent = data.current_action || "Initialising...";
    }
  }

  let inferredPct = 0;
  if (canLaunch) {
    inferredPct = 100;
  } else if (data.steps) {
    const active = data.steps.find(s => s.status === "running");
    if (active) {
      inferredPct = active.pct;
    } else {
      const done = [...data.steps]
        .reverse()
        .find(s => s.status === "done" && s.pct < 100);
      if (done) inferredPct = done.pct;
    }
  }
  updateProgress(inferredPct);

  // Upper right badge shows overall status
  const pill = $("status-pill");
  let pillText = humanStatus(data.status);
  let pillClass = data.status || "muted";
  if (canLaunch) {
    pillText = "Ready";
    pillClass = "ready";
  } else if (data.status === "running") {
    pillText = "Repairing";
    pillClass = "running";
  } else if (hasBlockingIssues) {
    pillText = "Needs attention";
    pillClass = data.status === "failed" ? "failed" : "running";
  }
  pill.textContent = pillText;
  pill.className = `pill ${pillClass}`;
  // Show/hide header Open Application button
  const headerBtn = $("header-view-app-btn");
  if (headerBtn) {
    headerBtn.style.display = canLaunch ? "inline-flex" : "none";
    headerBtn.disabled = !canLaunch;
    headerBtn.textContent = "Open Application";
  }

  // Render steps in a compact grid format
  const steps = $("steps");
  steps.innerHTML = "";
  (data.steps || []).forEach((step) => {
    const div = document.createElement("div");
    div.className = `step-item ${step.status}`;
    div.innerHTML = `
      <div class="step-meta">
        <i data-lucide="${step.icon || 'circle'}"></i>
        <span class="step-label">${step.label}</span>
      </div>
      <span class="status-badge ${step.status}">${step.status === 'done' ? 'Ready' : step.status === 'running' ? 'Installing' : step.status === 'failed' ? 'Failed' : 'Pending'}</span>
    `;
    steps.appendChild(div);
  });
  if (window.lucide) window.lucide.createIcons();

  // Remove config summary as requested to save space
  const configCard = $("config-summary-card");
  if (configCard) configCard.classList.add("hidden");

  $("view-app-btn").disabled = !canLaunch;
  if ($("install-btn")) {
    $("install-btn").disabled = data.status === "running";
    $("install-btn").classList.toggle("hidden", data.status === "running" || canLaunch);
  }
  $("ready-card").classList.toggle("hidden", !canLaunch);
  const viewAppBtn = $("view-app-btn");
  if (viewAppBtn) {
    viewAppBtn.disabled = !canLaunch;
    viewAppBtn.textContent = "Open Application";
  }
  const readySubtext = $("ready-subtext");
  if (hasBlockingIssues) {
    $("ready-text").textContent = "LokiDoki still needs attention.";
    if (readySubtext) {
      readySubtext.textContent = "Resolve the remaining blockers before opening the app.";
    }
  } else {
    $("ready-text").textContent = canLaunch ? "LokiDoki is ready!" : "Starting app…";
    if (readySubtext) {
      readySubtext.textContent = canLaunch
        ? "All dependencies and neural engines are successfully loaded. You can launch the app now."
        : "Completing the final startup checks.";
    }
  }
  toggleSetupModal(Boolean(data.setup_required));

  if (data.log_tail?.length) {
    $("logs").textContent = data.log_tail.join("\n");
    $("logs").scrollTop = $("logs").scrollHeight;
  }
}

async function refresh() {
  const [status, health] = await Promise.all([
    fetchJson("/api/bootstrap/status"),
    fetchJson("/api/bootstrap/health"),
  ]);
  renderStatus(status);
  renderHealth(health);
}

function attachStream() {
  if (state.eventSource) {
    state.eventSource.close();
  }
  state.eventSource = new EventSource("/install/stream");
  state.eventSource.onmessage = async (event) => {
    const payload = JSON.parse(event.data);
    const isHeartbeat = payload.step === "heartbeat";
    if (payload.log) {
      const current = $("logs").textContent.trim();
      $("logs").textContent = current ? `${current}\n${payload.log}` : payload.log;
      $("logs").scrollTop = $("logs").scrollHeight;
    }
    if (!isHeartbeat && payload.pct !== undefined) {
      updateProgress(payload.pct);
    }
    if (!isHeartbeat) {
      await refresh();
    }
  };
}

async function startInstall() {
  await fetchJson("/api/install/start", { method: "POST", body: "{}" });
  await refresh();
}

async function submitSetupForm(event) {
  event.preventDefault();
  $("setup-error").textContent = "";
  const formData = new FormData(event.target);
  const payload = Object.fromEntries(formData.entries());
  payload.allow_signup = Boolean(formData.get("allow_signup"));
  try {
    await fetchJson("/api/setup/submit", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await startInstall();
  } catch (error) {
    $("setup-error").textContent = error.message;
  }
}

async function copyLogs() {
  const text = $("logs").textContent;
  await navigator.clipboard.writeText(text);
  $("copy-logs-btn").textContent = "Copied";
  setTimeout(() => { $("copy-logs-btn").textContent = "Copy Logs"; }, 1200);
}

document.addEventListener("DOMContentLoaded", async () => {
  trackAdvancedFields();
  $("profile-input").addEventListener("change", (event) => {
    const profile = event.target.value;
    applyProfileDefaults(profile, PROFILE_DEFAULTS[profile] || PROFILE_DEFAULTS.mac);
  });
  $("setup-form").addEventListener("submit", submitSetupForm);
  $("copy-logs-btn").addEventListener("click", copyLogs);
  if ($("install-btn")) $("install-btn").addEventListener("click", startInstall);
  if ($("view-app-btn")) $("view-app-btn").addEventListener("click", () => window.open("/", "_self"));
  if ($("header-view-app-btn")) $("header-view-app-btn").addEventListener("click", () => window.open("/", "_self"));

  const toggleLogsBtn = $("toggle-logs-btn");
  if (toggleLogsBtn) {
    toggleLogsBtn.addEventListener("click", () => {
      const wrapper = $("logs-wrapper");
      if (wrapper) {
        wrapper.classList.toggle("hidden");
        toggleLogsBtn.textContent = wrapper.classList.contains("hidden") ? "Show Details" : "Hide Details";
      }
    });
  }

  attachStream();
  await refresh();
  if (!state.status || state.status.status === "idle") {
    await startInstall();
  }
});
