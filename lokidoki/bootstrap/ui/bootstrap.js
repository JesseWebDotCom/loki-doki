(() => {
    "use strict";

    const dataNode = document.getElementById("bootstrap-data");
    const bootstrapData = dataNode ? JSON.parse(dataNode.textContent || "{}") : {};
    const stepsGridEl = document.getElementById("steps-grid");
    const progressFillEl = document.getElementById("progress-fill");
    const taskEl = document.getElementById("current-task");
    const consoleEl = document.getElementById("console");
    const toggleConsoleBtn = document.getElementById("toggle-console-btn");
    const launchBtn = document.getElementById("launch-btn");
    const waitingBtn = document.getElementById("waiting-btn");
    const haltBanner = document.getElementById("halt-banner");
    const haltErrorEl = document.getElementById("halt-error");
    const haltRemediationEl = document.getElementById("halt-remediation");
    const retryBtn = document.getElementById("retry-btn");
    const profileLabelEl = document.getElementById("profile-label");

    if (profileLabelEl) {
        profileLabelEl.textContent = bootstrapData.profile_label || "…";
    }

    const steps = new Map();
    let lastFailedStepId = null;

    function log(line) {
        const at = new Date().toISOString().slice(11, 19);
        consoleEl.appendChild(document.createTextNode(`[${at}] ${line}\n`));
        while (consoleEl.childNodes.length > 500) {
            consoleEl.removeChild(consoleEl.firstChild);
        }
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    function ensureStepTile(stepId, label, canSkip) {
        let tile = steps.get(stepId);
        if (tile) return tile;
        tile = document.createElement("div");
        tile.className = "step";
        if (canSkip) tile.classList.add("can-skip");
        tile.dataset.stepId = stepId;
        tile.innerHTML = `
            <div class="step-dot"></div>
            <div class="step-label"></div>
            <div class="step-progress"></div>
            <button type="button" class="step-skip">Skip</button>
        `;
        tile.querySelector(".step-label").textContent = label || stepId;
        stepsGridEl.appendChild(tile);
        steps.set(stepId, tile);
        return tile;
    }

    function setStepStatus(stepId, status) {
        const tile = steps.get(stepId);
        if (!tile) return;
        tile.classList.remove("active", "done", "failed");
        if (status) tile.classList.add(status);
    }

    function updateOverallProgress() {
        const total = steps.size || 1;
        let done = 0;
        for (const tile of steps.values()) {
            if (tile.classList.contains("done")) done += 1;
        }
        progressFillEl.style.width = `${Math.round((done / total) * 100)}%`;
    }

    function onStepStart(evt) {
        ensureStepTile(evt.step_id, evt.label, evt.can_skip);
        setStepStatus(evt.step_id, "active");
        taskEl.textContent = evt.label || evt.step_id;
        log(`[start] ${evt.step_id}`);
    }

    function onStepLog(evt) {
        log(`  ${evt.step_id}: ${evt.line}`);
    }

    function onStepProgress(evt) {
        const tile = steps.get(evt.step_id);
        if (!tile) return;
        const progEl = tile.querySelector(".step-progress");
        if (!progEl) return;
        if (evt.bytes_total) {
            const mbDone = (evt.bytes_done || 0) / (1024 * 1024);
            const mbTotal = evt.bytes_total / (1024 * 1024);
            progEl.textContent = `${mbDone.toFixed(1)}/${mbTotal.toFixed(1)} MB`;
        } else if (typeof evt.pct === "number") {
            progEl.textContent = `${Math.round(evt.pct)}%`;
        }
    }

    function onStepDone(evt) {
        setStepStatus(evt.step_id, "done");
        const tile = steps.get(evt.step_id);
        if (tile) tile.querySelector(".step-progress").textContent = "";
        updateOverallProgress();
        log(`[done] ${evt.step_id} (${evt.duration_s.toFixed(2)}s)`);
    }

    function onStepFailed(evt) {
        setStepStatus(evt.step_id, "failed");
        lastFailedStepId = evt.step_id;
        haltBanner.hidden = false;
        haltErrorEl.textContent = evt.error;
        haltRemediationEl.textContent = evt.remediation || "";
        retryBtn.hidden = !evt.retryable;
        taskEl.textContent = "Pipeline halted — see banner below.";
        log(`[fail] ${evt.step_id}: ${evt.error}`);
    }

    function onPipelineComplete(evt) {
        progressFillEl.style.width = "100%";
        waitingBtn.hidden = true;
        launchBtn.hidden = false;
        launchBtn.onclick = () => { window.location.href = evt.app_url || "/"; };
        taskEl.textContent = "System Ready.";
        log(`[complete] app_url=${evt.app_url}`);
    }

    function onPipelineHalted(evt) {
        log(`[halted] ${evt.reason}`);
    }

    const handlers = {
        step_start: onStepStart,
        step_log: onStepLog,
        step_progress: onStepProgress,
        step_done: onStepDone,
        step_failed: onStepFailed,
        pipeline_complete: onPipelineComplete,
        pipeline_halted: onPipelineHalted,
    };

    toggleConsoleBtn.addEventListener("click", () => {
        consoleEl.hidden = !consoleEl.hidden;
    });

    retryBtn.addEventListener("click", async () => {
        if (!lastFailedStepId) return;
        retryBtn.disabled = true;
        haltBanner.hidden = true;
        try {
            const res = await fetch("/api/v1/bootstrap/retry", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ step_id: lastFailedStepId }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            log(`[retry-error] ${err.message}`);
            haltBanner.hidden = false;
        } finally {
            retryBtn.disabled = false;
        }
    });

    const evtSource = new EventSource("/api/v1/bootstrap/events");
    evtSource.onmessage = (e) => {
        let payload;
        try { payload = JSON.parse(e.data); } catch (_) { return; }
        const handler = handlers[payload.type];
        if (handler) handler(payload);
    };
    evtSource.onerror = () => {
        log("[sse] connection lost — browser will retry");
    };
})();
