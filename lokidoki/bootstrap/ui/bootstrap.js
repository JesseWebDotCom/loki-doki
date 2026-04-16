(() => {
    "use strict";

    const dataNode = document.getElementById("bootstrap-data");
    let bootstrapData = {};
    try { bootstrapData = JSON.parse(dataNode?.textContent || "{}"); } catch (_) {}

    const progressRingEl = document.getElementById("progress-ring");
    const ringPctEl = document.getElementById("ring-pct");
    const pageTitleEl = document.getElementById("page-title");
    const taskEl = document.getElementById("current-task");
    const counterEl = document.getElementById("step-counter");
    const consoleEl = document.getElementById("console");
    const toggleConsoleBtn = document.getElementById("toggle-console-btn");
    const launchBtn = document.getElementById("launch-btn");
    const haltBanner = document.getElementById("halt-banner");
    const haltErrorEl = document.getElementById("halt-error");
    const haltRemediationEl = document.getElementById("halt-remediation");
    const retryBtn = document.getElementById("retry-btn");
    const profileLabelEl = document.getElementById("profile-label");
    const wizardEl = document.querySelector(".wizard");
    const stepperEl = document.getElementById("category-stepper");

    const CIRC = 2 * Math.PI * 52;
    const DEBUG = new URLSearchParams(window.location.search).has("debug");

    // The five stepper chips. Order matters — this is left-to-right render order.
    // Labels are kept short and warm so a non-technical user grasps the
    // big picture at a glance; details live in the step name + log panel.
    // (No icons — the chips are simple dots; "Show details" reveals the
    // labels for admins.)
    const CATEGORIES = [
        { id: "system",   label: "Setup" },
        { id: "frontend", label: "App" },
        { id: "ai",       label: "Brain" },
        { id: "audio",    label: "Voice" },
        { id: "finalize", label: "Launch" },
    ];

    // Big playful headline by category — kid-friendly. The technical step
    // name (e.g. "Installing AI engine") still shows under the ring for
    // admins who want to know exactly what's happening.
    const CATEGORY_MESSAGE = {
        system:   "Setting up your computer...",
        frontend: "Building the app...",
        ai:       "Waking up the brain...",
        audio:    "Tuning the voice...",
        finalize: "Almost ready...",
    };

    // Friendly rewrites of step IDs / labels — shown to humans. The raw
    // Python step label still appears in the log panel so admins can
    // correlate against backend code.
    const FRIENDLY_LABELS = {
        "detect-profile":         "Checking your computer",
        "embed-python":           "Setting up Python",
        "install-uv":             "Installing package manager",
        "sync-python-deps":       "Installing Python libraries",
        "check-hailo-runtime":    "Checking AI accelerator",
        "embed-node":             "Setting up Node.js",
        "install-frontend-deps":  "Installing app libraries",
        "build-frontend":         "Building the app",
        "install-llm-engine":     "Installing AI engine",
        "install-hailo-ollama":   "Installing AI engine",
        "ensure-hef-files":       "Loading AI accelerator files",
        "pull-llm-fast":          "Downloading quick-thinker model",
        "pull-llm-thinking":      "Downloading deep-thinker model",
        "warm-resident-llm":      "Waking up AI models",
        "install-vision":         "Setting up vision",
        "pull-vision-model":      "Downloading vision model",
        "install-piper":          "Installing voice (speech)",
        "install-whisper":        "Installing voice (listening)",
        "install-wake-word":      "Installing wake word",
        "install-detectors":      "Installing object detectors",
        "install-image-gen":      "Installing image generator",
        "seed-database":          "Preparing database",
        "spawn-app":              "Starting LokiDoki",
    };

    function friendlyLabel(stepId) {
        return FRIENDLY_LABELS[stepId] || stepLabels.get(stepId) || stepId;
    }

    if (profileLabelEl) {
        profileLabelEl.textContent = bootstrapData.profile_label || "...";
    }

    // ── Build the stepper chip DOM once ──
    const catEls = new Map();
    if (stepperEl) {
        for (const cat of CATEGORIES) {
            const el = document.createElement("div");
            el.className = "category";
            el.dataset.category = cat.id;
            el.innerHTML = `
                <div class="cat-icon"><span class="cat-check">✓</span></div>
                <span class="cat-label">${cat.label}</span>
            `;
            stepperEl.appendChild(el);
            catEls.set(cat.id, el);
        }
    }

    // ── State (the single source of truth; UI is derived from this) ──
    const stepState = new Map();      // stepId → "pending"|"active"|"done"|"failed"
    const stepLabels = new Map();     // stepId → human label
    const stepCategory = new Map();   // stepId → category bucket
    let totalSteps = 0;
    let lastFailedStepId = null;
    let lastFailedError = "";
    let lastFailedRemediation = "";
    let lastFailedRetryable = true;
    let completed = false;
    let appUrl = "/";
    let currentStepId = null;
    let bytesDone = 0;
    let bytesTotal = 0;
    let appReady = false;             // /api/health has answered after handoff

    let firstRender = true;

    // ── Pure state reducer — no DOM ──

    function reduce(evt) {
        if (DEBUG) console.log("[sse]", evt);
        switch (evt.type) {
            case "step_start":
                stepState.set(evt.step_id, "active");
                stepLabels.set(evt.step_id, evt.label || evt.step_id);
                totalSteps = Math.max(totalSteps, stepState.size);
                currentStepId = evt.step_id;
                bytesDone = 0;
                bytesTotal = 0;
                break;
            case "step_done":
                stepState.set(evt.step_id, "done");
                if (currentStepId === evt.step_id) {
                    bytesDone = 0;
                    bytesTotal = 0;
                }
                break;
            case "step_failed":
                stepState.set(evt.step_id, "failed");
                lastFailedStepId = evt.step_id;
                lastFailedError = evt.error || "";
                lastFailedRemediation = evt.remediation || "";
                lastFailedRetryable = evt.retryable !== false;
                break;
            case "step_progress":
                if (evt.step_id === currentStepId && evt.bytes_total) {
                    bytesDone = evt.bytes_done || 0;
                    bytesTotal = evt.bytes_total;
                }
                break;
            case "step_log":
                log(`  ${evt.step_id}: ${evt.line}`);
                break;
            case "pipeline_complete":
                appUrl = evt.app_url || "/";
                completed = true;
                break;
            case "pipeline_halted":
                log(`[halted] ${evt.reason}`);
                break;
        }
    }

    // ── Derived state ──

    function computeDerived() {
        let done = 0;
        let activeId = null;
        let anyFailed = null;
        let anyPending = false;
        for (const [id, state] of stepState) {
            if (state === "done") done++;
            else if (state === "active") activeId = id;
            else if (state === "failed") anyFailed = id;
            else anyPending = true;
        }
        const total = totalSteps || stepState.size || 1;
        const allDone = total > 0 && done === total && !anyFailed && !anyPending && activeId === null;
        return { done, activeId, anyFailed, allDone, total };
    }

    function computeCategoryStates() {
        const cats = new Map();
        for (const cat of CATEGORIES) {
            cats.set(cat.id, { total: 0, done: 0, active: 0, failed: 0 });
        }
        for (const [id, state] of stepState) {
            const cat = stepCategory.get(id);
            if (!cat || !cats.has(cat)) continue;
            const c = cats.get(cat);
            c.total++;
            if (state === "done") c.done++;
            else if (state === "active") c.active++;
            else if (state === "failed") c.failed++;
        }
        return cats;
    }

    // ── DOM render (idempotent) ──

    function render() {
        const d = computeDerived();

        // Disable transitions on the very first render (initial replay burst)
        if (firstRender) {
            wizardEl.classList.add("no-transition");
        }

        // Progress
        const pct = Math.min(100, Math.round((d.done / d.total) * 100));
        if (ringPctEl) ringPctEl.textContent = `${pct}%`;
        progressRingEl.style.strokeDashoffset = CIRC - (pct / 100) * CIRC;


        // Stepper chips
        const cats = computeCategoryStates();
        for (const [catId, s] of cats) {
            const el = catEls.get(catId);
            if (!el) continue;
            const isDone = s.total > 0 && s.done === s.total && s.failed === 0;
            const isActive = !isDone && s.active > 0;
            const isFailed = s.failed > 0;
            el.classList.toggle("done", isDone);
            el.classList.toggle("active", isActive);
            el.classList.toggle("failed", isFailed);
        }

        // Final-state resolution
        if (completed || appReady || d.allDone) {
            // Success — title flips so the page stops claiming it's
            // still "getting ready" once it isn't. Button uses visibility
            // (not display) so its slot is reserved from page load and
            // nothing shifts when it appears.
            wizardEl.classList.remove("halted");
            wizardEl.classList.add("complete");
            haltBanner.hidden = true;
            launchBtn.style.visibility = appReady ? "visible" : "hidden";
            launchBtn.onclick = () => { window.location.href = appUrl; };
            if (pageTitleEl) {
                pageTitleEl.textContent = appReady
                    ? "LokiDoki is ready!"
                    : "Almost ready...";
            }
            // Keep taskEl in the layout (don't .hidden = true) so the
            // button doesn't jump upward when we transition to success.
            taskEl.hidden = false;
            taskEl.textContent = "";
            counterEl.textContent = "";
        } else if (d.anyFailed && !d.activeId) {
            // Halted — no active step, show halt
            wizardEl.classList.remove("complete");
            wizardEl.classList.add("halted");
            if (pageTitleEl) pageTitleEl.textContent = "Getting LokiDoki ready";
            haltBanner.hidden = false;
            haltErrorEl.textContent = lastFailedError || `Failed: ${friendlyLabel(d.anyFailed)}`;
            haltRemediationEl.textContent = lastFailedRemediation || "";
            retryBtn.hidden = !lastFailedRetryable;
            launchBtn.style.visibility = "hidden";
            taskEl.hidden = false;
            taskEl.textContent = friendlyLabel(d.anyFailed);
            counterEl.textContent = `Step ${d.done} of ${d.total}`;
        } else if (d.activeId) {
            // Running — playful headline tracks the category, technical
            // step name stays underneath for admins.
            wizardEl.classList.remove("halted", "complete");
            haltBanner.hidden = true;
            launchBtn.style.visibility = "hidden";
            taskEl.hidden = false;
            taskEl.textContent = friendlyLabel(d.activeId);
            if (pageTitleEl) {
                const cat = stepCategory.get(d.activeId);
                pageTitleEl.textContent =
                    CATEGORY_MESSAGE[cat] || "Getting LokiDoki ready";
            }
            if (bytesTotal > 0) {
                const mb = (b) => (b / 1048576).toFixed(0);
                counterEl.textContent = `${mb(bytesDone)} / ${mb(bytesTotal)} MB`;
            } else {
                counterEl.textContent = `Step ${d.done} of ${d.total}`;
            }
        } else {
            // Idle
            wizardEl.classList.remove("halted", "complete");
            haltBanner.hidden = true;
            launchBtn.style.visibility = "hidden";
            taskEl.hidden = false;
            taskEl.textContent = "Preparing...";
            counterEl.textContent = totalSteps > 0 ? `Step 0 of ${totalSteps}` : "";
        }

        // Re-enable transitions after the first render
        if (firstRender) {
            void wizardEl.offsetHeight; // flush
            wizardEl.classList.remove("no-transition");
            firstRender = false;
        }
    }

    // ── rAF-batched event processing ──
    //
    // All events (replay burst and live) are collected and applied per
    // animation frame. A 20-event burst arriving in 1ms gets reduced and
    // rendered once, not 20 times — no flashing, no stale partial state.

    const pending = [];
    let rafId = null;

    function schedule() {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(flush);
    }

    function flush() {
        rafId = null;
        const batch = pending.splice(0, pending.length);
        for (const evt of batch) reduce(evt);
        render();
    }

    function log(line) {
        const t = new Date().toISOString().slice(11, 19);
        consoleEl.appendChild(document.createTextNode(`[${t}] ${line}\n`));
        while (consoleEl.childNodes.length > 500) consoleEl.removeChild(consoleEl.firstChild);
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    // ── Console toggle ──

    toggleConsoleBtn.addEventListener("click", () => {
        const open = !consoleEl.hidden;
        consoleEl.hidden = open;
        // Counter + OS subtitle live behind "Show details" too — they
        // tell admins which platform/profile is running and how far
        // along it is, but they're noise for non-tech users.
        counterEl.hidden = open;
        profileLabelEl.hidden = open;
        // The wizard.details class swaps the friendly view for the
        // labelled stepper + percent number — see bootstrap.css.
        wizardEl.classList.toggle("details", !open);
        toggleConsoleBtn.textContent = open ? "Show details" : "Hide details";
    });

    // ── Retry ──

    retryBtn.addEventListener("click", async () => {
        if (!lastFailedStepId) return;
        retryBtn.disabled = true;
        // Optimistically clear; incoming step_start will confirm
        wizardEl.classList.remove("halted");
        haltBanner.hidden = true;
        taskEl.textContent = "Retrying...";
        try {
            const res = await fetch("/api/v1/bootstrap/retry", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ step_id: lastFailedStepId }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            log(`[retry-error] ${err.message}`);
            lastFailedError = err.message;
            wizardEl.classList.add("halted");
            haltBanner.hidden = false;
            haltErrorEl.textContent = err.message;
        } finally {
            retryBtn.disabled = false;
        }
    });

    // ── Pre-populate step count + categories ──

    fetch("/api/v1/bootstrap/steps")
        .then(r => r.ok ? r.json() : { steps: [] })
        .then(data => {
            for (const s of data.steps || []) {
                if (!stepState.has(s.id)) stepState.set(s.id, "pending");
                stepLabels.set(s.id, s.label);
                if (s.category) stepCategory.set(s.id, s.category);
            }
            totalSteps = stepState.size;
            schedule();
        })
        .catch(() => {});

    // ── SSE ──

    const evtSource = new EventSource("/api/v1/bootstrap/events");

    let gotSSE = false;
    evtSource.onmessage = (e) => {
        gotSSE = true;
        let p;
        try { p = JSON.parse(e.data); } catch (_) { return; }
        pending.push(p);
        schedule();
    };

    // ── Health-poll → manual launch ──
    // Polling /api/health serves two cases:
    //   1. SSE never connects (page loaded after install finished)
    //   2. SSE drops mid-stream — the spawn-app step releases :8000,
    //      bootstrap server dies, FastAPI takes over and needs a few
    //      seconds to boot.
    // When the app answers, we mark `appReady = true` and re-render.
    // Render shows the Launch button and waits for the user to click it
    // (no auto-redirect — user explicitly opted into auto-redirect being
    // removed because the wizard was vanishing too fast to read).
    let pollTimer = null;

    function startHealthPoll(reason) {
        if (pollTimer || appReady) return;
        log(`[health-poll] ${reason}`);
        // Re-render so the user sees we're handing off (instead of a
        // stalled-looking 95% ring).
        if (!completed) {
            taskEl.textContent = "Starting app...";
        }
        pollTimer = setInterval(() => {
            fetch("/api/health").then(r => {
                if (r.ok && !appReady) {
                    appReady = true;
                    clearInterval(pollTimer);
                    pollTimer = null;
                    try { evtSource.close(); } catch (_) {}
                    schedule();
                }
            }).catch(() => {});
        }, 1000);
    }

    evtSource.onerror = () => {
        startHealthPoll("sse lost");
    };

    // If SSE never connects at all (page loaded after install finished),
    // kick off the poll after a short grace period.
    setTimeout(() => {
        if (!gotSSE) startHealthPoll("sse never connected");
    }, 3000);
})();
