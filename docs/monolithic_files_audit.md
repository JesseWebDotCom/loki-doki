# LokiDoki — Monolithic Files Audit (April 2026)

This document lists the largest files in the codebase that should be broken up for maintainability, clarity, and testability. Files exceeding 700–1000 lines or mixing multiple responsibilities are flagged for refactor.

## Python Backend

### 1. `app/main.py` (3364 lines)
- **Why:** Contains API routes, models, DB logic, and business logic in one file. Hard to maintain, test, and reason about. Should be split by route/subsystem (e.g., auth, chat, memory, admin).

### 2. `app/subsystems/character/service.py` (2270 lines)
- **Why:** Implements all character logic (catalog, policy, prompt, CRUD, etc.) in one file. Should be split by responsibility (catalog, policy, prompt, user settings, etc.).

### 3. `app/bootstrap/installer.py` (1609 lines)
- **Why:** Handles all installer logic in one file. Should be split by phase or function (e.g., dependency checks, UI, health, install steps).

### 4. `app/runtime_metrics.py` (386 lines)
- **Why:** Mixes system/process/storage metrics, process tracking, and platform-specific helpers. Should be split into focused modules (system metrics, process metrics, storage metrics, platform helpers).

## Frontend (React/TypeScript)

### 5. `app/ui/src/character-editor/components/EditorSidebar.tsx` (1180 lines)
- **Why:** Implements the entire sidebar UI and logic in one file. Should be split into smaller, focused components.

### 6. `app/ui/src/character-editor/integration/MigrationWorkbench.tsx` (710 lines)
- **Why:** Implements the main character editor workbench, mixing UI, state, and export logic. Should be split by tab/feature (general, controls, presets, save, etc.).

---

**Root Cause:**
- These files are too large and/or mix unrelated responsibilities, making them hard to maintain, test, and extend. Breaking them up will improve code quality, enable focused testing, and reduce onboarding time for new contributors.

**How to Verify:**
- Each file should be split into modules/components with a single responsibility and <300–400 lines each. All imports, exports, and registrations must be updated accordingly.
