# Lokidoki Test Runner Page Design

## Goal

Build a single internal web page for the project that can:

- browse discovered pytest tests and suites
- run the `commit` suite, the `push` suite, or any selected individual tests
- stream progress in real time while tests are running
- show pass/fail/skip status and failure details
- show test coverage results
- show whether required pytest-related dependencies are installed and working

This page should be a thin control layer over normal `pytest`, not a replacement for it.

---

## Desired user experience

The page should feel like a lightweight local CI dashboard.

### Main capabilities

- View all suites
- View all tests in a tree
- Search tests by name, file, marker, or node id
- Run:
  - commit suite
  - push suite
  - selected tests
  - a single test
- Watch progress live
- Stop a run
- Review failures, logs, and tracebacks
- See coverage summary and link to HTML coverage report
- See environment checks:
  - pytest installed
  - pytest-cov installed
  - optional plugins installed
  - `pytest --version` works
  - collection works
  - coverage run works

---

## Recommended project dependencies

Current dependencies:

```toml
[project]
name = "lokidoki-core"
version = "0.1.0"
description = "Add your description here"
readme = "README.md"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.135.3",
    "httpx>=0.28.1",
    "pre-commit>=4.5.1",
    "pytest>=9.0.2",
    "pytest-cov>=7.1.0",
    "uvicorn>=0.44.0",
]
```

Recommended additions:

```toml
[project]
name = "lokidoki-core"
version = "0.1.0"
description = "Add your description here"
readme = "README.md"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.135.3",
    "httpx>=0.28.1",
    "pre-commit>=4.5.1",
    "pytest>=9.0.2",
    "pytest-cov>=7.1.0",
    "pytest-sugar>=1.0.0",
    "uvicorn>=0.44.0",
]
```

### Optional later additions

- `pytest-xdist` for parallel runs
- `pytest-testmon` for changed-code-aware test selection
- `allure-pytest` for optional richer post-run reports

These are optional. The core page does not need them to work.

---

## Pytest suite design

Use markers for the main suites.

### Example `pytest.ini`

```ini
[pytest]
markers =
    commit: fast must-pass tests before commit
    push: broader suite that must pass before push
    slow: slower tests
    integration: integration tests
```

### Example usage in tests

```python
import pytest

@pytest.mark.commit
def test_prompt_parser():
    ...

@pytest.mark.push
def test_end_to_end_api():
    ...

@pytest.mark.commit
@pytest.mark.push
def test_settings_schema():
    ...
```

### Core CLI selectors

Run commit suite:

```bash
pytest -m commit -vv
```

Run push suite:

```bash
pytest -m push -vv
```

Run a single test:

```bash
pytest tests/unit/test_memory.py::test_store_fact -vv
```

Run selected tests by keyword:

```bash
pytest -k "memory and not slow" -vv
```

Collect tests only:

```bash
pytest --collect-only -q
```

Coverage run:

```bash
pytest --cov=. --cov-report=term-missing --cov-report=html
```

---

## Main page layout

Use a 3-panel layout.

### Left panel: suites and test browser

Show:

- suites:
  - Commit
  - Push
  - Slow
  - Integration
- file tree
- class grouping where applicable
- tests under each class/file
- search input
- filters:
  - marker
  - last status
  - failed only
  - changed only
  - has coverage data

### Center panel: run controls and live progress

Show:

- buttons:
  - Run Commit Suite
  - Run Push Suite
  - Run Selected
  - Stop Run
  - Refresh Tree
- active run header:
  - status
  - started at
  - elapsed time
- counters:
  - collected
  - running
  - passed
  - failed
  - skipped
  - remaining
- progress bar
- live event feed
- raw stdout/stderr tab

### Right panel: details

When a test is selected, show:

- test name
- full node id
- file path
- markers
- last status
- last duration
- last run time
- latest traceback
- captured stdout/stderr
- buttons:
  - Run This Test
  - Copy Node ID
  - Open File
  - Open Last Coverage Report

---

## Secondary tabs

Add tabs or sections for:

- Runs
- Coverage
- Environment
- Failures

### Runs tab

Shows run history:
- run id
- selection type
- started at
- duration
- passed
- failed
- skipped
- coverage percent

### Coverage tab

Shows:

- total coverage percent
- per-file coverage percent
- line counts:
  - covered
  - missed
- link/button to open generated `htmlcov/index.html`
- optional trend of recent runs if stored

### Environment tab

Shows health checks for the pytest stack:

- Python version
- pytest installed
- pytest-cov installed
- pytest-sugar installed
- `pytest --version` success
- collect-only success
- coverage execution success
- path to project root detected
- path to `.pytest_cache`
- path to `htmlcov`
- path to coverage data file

---

## Core backend architecture

Use FastAPI plus a small runner service.

### Components

- FastAPI router for API endpoints
- test discovery service
- test execution service
- run state manager
- websocket broadcaster
- optional SQLite persistence for run history
- optional helper to open coverage report path

### Critical design rule

Do not make the frontend parse terminal text as the source of truth.

Instead:

- stream raw terminal text for display
- also generate structured run events from a custom pytest plugin

The UI should be driven by structured events.

---

## Backend API outline

### `GET /api/tests/suites`

Returns known suites.

Example response:

```json
[
  {
    "id": "commit",
    "label": "Commit",
    "selector_type": "marker",
    "selector_value": "commit",
    "description": "Fast must-pass tests before commit"
  },
  {
    "id": "push",
    "label": "Push",
    "selector_type": "marker",
    "selector_value": "push",
    "description": "Broader suite before push"
  }
]
```

### `GET /api/tests/tree`

Returns discovered tests and tree structure.

Query params:
- `refresh=true|false`

Example response:

```json
{
  "generated_at": "2026-04-06T11:20:00Z",
  "tests": [
    {
      "node_id": "tests/unit/test_memory.py::test_store_fact",
      "name": "test_store_fact",
      "file": "tests/unit/test_memory.py",
      "class_name": null,
      "markers": ["commit"],
      "last_status": "passed",
      "last_duration_ms": 41
    }
  ]
}
```

### `POST /api/tests/run`

Starts a run.

Request modes:

#### Run a suite

```json
{
  "mode": "suite",
  "suite_id": "commit"
}
```

#### Run one test

```json
{
  "mode": "node_ids",
  "node_ids": ["tests/unit/test_memory.py::test_store_fact"]
}
```

#### Run multiple tests

```json
{
  "mode": "node_ids",
  "node_ids": [
    "tests/unit/test_memory.py::test_store_fact",
    "tests/api/test_health.py::test_health"
  ]
}
```

#### Run with coverage

```json
{
  "mode": "suite",
  "suite_id": "push",
  "coverage": true
}
```

Response:

```json
{
  "run_id": "run_20260406_112355_01",
  "status": "started"
}
```

### `POST /api/tests/stop`

Stops the active run.

```json
{
  "run_id": "run_20260406_112355_01"
}
```

### `GET /api/tests/runs`

Returns recent runs.

### `GET /api/tests/runs/{run_id}`

Returns run summary plus per-test results.

### `GET /api/tests/environment`

Returns environment checks.

### `GET /api/tests/coverage/latest`

Returns latest coverage summary.

### `WS /api/tests/stream/{run_id}`

Streams live structured events plus optional console lines.

---

## Suggested data models

### Test case

```json
{
  "node_id": "tests/unit/test_memory.py::test_store_fact",
  "name": "test_store_fact",
  "file": "tests/unit/test_memory.py",
  "class_name": null,
  "markers": ["commit"],
  "last_status": "passed",
  "last_duration_ms": 42,
  "last_run_at": "2026-04-06T11:20:00Z"
}
```

### Test suite

```json
{
  "id": "commit",
  "label": "Commit",
  "selector_type": "marker",
  "selector_value": "commit",
  "description": "Fast must-pass tests before commit"
}
```

### Test run

```json
{
  "run_id": "run_20260406_112355_01",
  "status": "running",
  "started_at": "2026-04-06T11:23:55Z",
  "ended_at": null,
  "selection": {
    "mode": "suite",
    "suite_id": "commit"
  },
  "counts": {
    "total": 54,
    "running": 1,
    "passed": 23,
    "failed": 1,
    "skipped": 0,
    "remaining": 30
  },
  "coverage": {
    "enabled": true,
    "percent": null
  }
}
```

### Test result

```json
{
  "node_id": "tests/unit/test_memory.py::test_store_fact",
  "status": "passed",
  "duration_ms": 38,
  "stdout": "",
  "stderr": "",
  "traceback": null
}
```

### Environment check

```json
{
  "name": "pytest-cov import",
  "status": "pass",
  "detail": "pytest-cov is installed"
}
```

### Coverage summary

```json
{
  "overall_percent": 82.4,
  "html_report_path": "htmlcov/index.html",
  "files": [
    {
      "path": "app/tests_runner/service.py",
      "covered_lines": 120,
      "missed_lines": 14,
      "percent": 89.6
    }
  ]
}
```

---

## Test discovery design

### How discovery works

The test page should gather the tree using pytest collection.

Recommended command:

```bash
pytest --collect-only -q
```

The backend should parse collected node ids into:

- file
- class
- function

### Better approach

Add a custom collector plugin so the backend receives structured collection data instead of relying purely on parsing text.

Structured collection data should include:

- node id
- file
- class
- function
- markers if available

### Caching

Cache the last collected tree in memory and optionally on disk. Refresh when:

- user clicks Refresh Tree
- a run starts
- watched test files change
- the current cache is older than a configured threshold

---

## Run execution design

### Process model

Use a subprocess to run pytest. The runner service should:

1. build the exact pytest command
2. launch subprocess from project root
3. stream output
4. process structured events
5. update run state
6. persist final summary
7. store coverage summary if enabled

### Example command building

#### Commit suite

```bash
pytest -m commit -vv
```

#### Push suite with coverage

```bash
pytest -m push -vv --cov=. --cov-report=term-missing --cov-report=html
```

#### Selected tests

```bash
pytest tests/unit/test_memory.py::test_store_fact tests/api/test_health.py::test_health -vv
```

### Important process rules

- only allow one active run at a time at first
- provide a stop button that terminates the subprocess
- set project root explicitly as the working directory
- keep command construction strict and safe; do not accept arbitrary shell text from the UI

---

## Structured event plugin

This is the key piece.

Create a small internal pytest plugin used only by the runner page.

### Plugin responsibilities

Emit structured events for:

- session start
- collection complete
- test start
- test passed
- test failed
- test skipped
- captured stdout
- captured stderr
- warning
- session finish
- coverage summary available

### How to emit events

Good options:

- write JSON lines to stdout with a recognizable prefix
- write JSON lines to a temp file being tailed by backend
- use an IPC pipe or socket

### Recommended simple approach

Write JSON lines to stdout prefixed with something like:

```text
__LOKITEST_EVENT__{"type":"test_started","node_id":"tests/unit/test_memory.py::test_store_fact"}
```

The backend reads stdout and:
- displays plain output in raw log view
- extracts prefixed JSON events into structured state updates

### Example event payloads

#### Session started

```json
{
  "type": "session_started",
  "run_id": "run_20260406_112355_01",
  "timestamp": "2026-04-06T11:23:55Z"
}
```

#### Collection complete

```json
{
  "type": "collection_complete",
  "total": 54
}
```

#### Test started

```json
{
  "type": "test_started",
  "node_id": "tests/unit/test_memory.py::test_store_fact"
}
```

#### Test finished

```json
{
  "type": "test_finished",
  "node_id": "tests/unit/test_memory.py::test_store_fact",
  "status": "passed",
  "duration_ms": 38
}
```

#### Test failed

```json
{
  "type": "test_failed",
  "node_id": "tests/unit/test_memory.py::test_store_fact",
  "duration_ms": 41,
  "traceback": "AssertionError: ..."
}
```

#### Session finished

```json
{
  "type": "session_finished",
  "status": "completed",
  "counts": {
    "passed": 52,
    "failed": 2,
    "skipped": 0
  }
}
```

---

## Real-time transport

Use WebSockets.

### Why WebSockets

You want:

- progress updates
- test-by-test status
- logs
- completion signal
- stop notification

That fits WebSockets well.

### Message types to stream

- `run_started`
- `collection_complete`
- `test_started`
- `test_finished`
- `console_line`
- `warning`
- `coverage_ready`
- `run_finished`
- `run_stopped`
- `run_error`

### Frontend state handling

The client should maintain:

- active run metadata
- per-test status map
- counters
- log lines
- selected test detail
- final coverage summary

---

## Coverage design

Coverage should be first-class in the page, not an afterthought.

### Coverage modes

- run without coverage
- run with coverage enabled
- default coverage on for push suite
- optional coverage on for commit suite

### Coverage commands

Recommended run form:

```bash
pytest -m push -vv --cov=. --cov-report=term-missing --cov-report=html
```

### Coverage data to capture

- total percent
- file-by-file percent
- missed lines
- generated report path

### UI display

On the Coverage tab show:

- overall coverage percent
- simple bar visualization
- files sorted by lowest percent first
- missed line counts
- link/button to open `htmlcov/index.html`

### How to get structured coverage data

Options:

1. parse coverage terminal output
2. read generated coverage data via coverage APIs
3. parse generated XML or JSON reports

Recommended:

Generate one machine-readable report in addition to HTML, such as JSON or XML.

For example:

```bash
pytest --cov=. --cov-report=html --cov-report=json:coverage.json
```

Then the backend reads `coverage.json` and serves structured data.

This is cleaner than parsing terminal text.

---

## Dependency and environment checks

The page should explicitly show whether pytest dependencies are installed and working.

### Checks to run

#### Basic Python/runtime checks

- Python version
- project root found
- virtual environment info if applicable

#### Package import checks

- `pytest`
- `pytest_cov`
- `pytest_sugar` if expected

#### Command checks

- `pytest --version`
- `pytest --help`
- `pytest --collect-only -q`
- `pytest --cov=. --cov-report=term --maxfail=1 -q` on a minimal smoke target, or equivalent safer check

#### File/path checks

- `pytest.ini` exists
- tests directory exists
- `htmlcov` writable
- temporary runner output location writable

### Environment status categories

Use:
- pass
- warning
- fail

### Example output

```json
[
  {
    "name": "pytest import",
    "status": "pass",
    "detail": "pytest 9.0.2 is installed"
  },
  {
    "name": "pytest-cov import",
    "status": "pass",
    "detail": "pytest-cov is installed"
  },
  {
    "name": "pytest-sugar import",
    "status": "warning",
    "detail": "pytest-sugar not installed; live output will still work"
  },
  {
    "name": "collect-only run",
    "status": "pass",
    "detail": "Discovered 154 tests"
  }
]
```

---

## Frontend component outline

### Top-level page

`TestRunnerPage`

Contains:

- suite sidebar
- run control header
- center content area
- details sidebar
- tabs for coverage/environment/history

### Suggested components

- `TestSuiteList`
- `TestTree`
- `TestSearchBar`
- `RunControls`
- `RunSummary`
- `ProgressBar`
- `LiveLogPanel`
- `SelectedTestPanel`
- `CoverageSummaryCard`
- `CoverageFilesTable`
- `EnvironmentChecksPanel`
- `RunHistoryTable`
- `FailuresList`

### Useful UI behavior

- failed tests stay red in tree after run
- currently-running test highlights
- auto-scroll log with pause toggle
- click a failed test to jump to traceback
- allow multi-select for running a small batch

---

## Persistence design

At minimum, persist recent runs.

### Storage options

Start with:
- SQLite
or
- JSON files in a local dev data folder

### Persist:

- test tree cache
- recent runs
- per-test latest status
- latest coverage summary
- environment check history

### Benefits

This allows:
- last run status in the tree
- sort by recently failed
- coverage trend later
- run history panel

---

## Safety and scope rules

### Do not allow arbitrary shell commands from the page

The UI should only request safe modes such as:

- suite id
- list of node ids
- coverage true/false

The backend alone constructs the actual pytest command.

### Limit active execution

Initially allow only one active run. This avoids:
- overlapping subprocesses
- conflicting temp files
- confusing UI state

### Handle stop cleanly

Stopping a run should:
- terminate the subprocess
- mark run as stopped
- preserve partial logs and partial results

### Keep it local/dev focused

This page is a dev tool, not a multi-user production feature.

---

## Suggested implementation phases

## Phase 1: basic runner

Build:

- `GET /api/tests/suites`
- `GET /api/tests/tree`
- `POST /api/tests/run`
- `POST /api/tests/stop`
- websocket stream
- simple page with:
  - suite buttons
  - test tree
  - live log
  - progress counters

Use raw stdout first if necessary, but keep architecture ready for structured events.

## Phase 2: structured events

Add custom pytest plugin that emits machine-readable events.

Then update UI to rely on event types for:
- per-test status
- progress counts
- failure details

## Phase 3: coverage

Add:
- coverage toggle
- HTML coverage generation
- JSON coverage generation
- coverage summary tab
- latest coverage in run history

## Phase 4: environment checks

Add:
- environment tab
- install/working checks
- basic troubleshooting hints

## Phase 5: history and polish

Add:
- recent runs
- re-run failed tests
- re-run last selection
- filter by failed/changed/marker
- optional parallel run support later

---

## Suggested file structure

Example layout inside the app:

```text
app/
  api/
    test_runner.py
  services/
    test_runner/
      discovery.py
      runner.py
      state.py
      environment.py
      coverage.py
      models.py
      plugin.py
frontend/
  src/
    pages/
      TestRunnerPage.tsx
    components/
      test-runner/
        TestSuiteList.tsx
        TestTree.tsx
        RunControls.tsx
        RunSummary.tsx
        LiveLogPanel.tsx
        SelectedTestPanel.tsx
        CoverageSummaryCard.tsx
        CoverageFilesTable.tsx
        EnvironmentChecksPanel.tsx
        RunHistoryTable.tsx
```

---

## Minimal backend responsibilities by module

### `models.py`

Defines:
- TestCase
- TestSuite
- TestRun
- TestResult
- CoverageSummary
- EnvironmentCheck

### `discovery.py`

Handles:
- collect-only execution
- parsing collection output
- refreshing cached test tree

### `runner.py`

Handles:
- building pytest commands
- launching subprocess
- reading stdout/stderr
- interpreting structured plugin events
- stopping active run

### `state.py`

Handles:
- in-memory active run state
- recent run cache
- websocket subscriptions

### `coverage.py`

Handles:
- reading `coverage.json`
- summarizing per-file coverage
- exposing latest report path

### `environment.py`

Handles:
- import checks
- command checks
- file/path checks

### `plugin.py`

Pytest plugin for structured event emission.

---

## Example user workflows

### Workflow 1: pre-commit confidence

1. Open test page
2. Click Run Commit Suite
3. Watch live progress
4. Fix any failures
5. Confirm pass and optionally quick coverage snapshot

### Workflow 2: pre-push validation

1. Click Run Push Suite
2. Coverage enabled by default
3. Watch progress
4. Review failures if any
5. Open coverage tab
6. Open HTML coverage report for deeper inspection

### Workflow 3: targeted debug

1. Search for a test
2. Click it
3. Review last failure
4. Click Run This Test
5. Watch live output
6. Repeat until pass

### Workflow 4: run selected batch

1. Search and multi-select 3 to 10 tests
2. Click Run Selected
3. Watch targeted progress without running the whole suite

---

## What success looks like

The finished page should let you:

- browse tests comfortably
- run commit and push suites with one click
- run a single test without leaving the app
- see live progress and not just wait for final output
- know whether pytest tooling is installed and functioning
- see coverage results in the same place
- avoid relying on an external heavy test dashboard for core workflow

---

## Practical recommendation

Build this as a simple, local internal tool with these priorities:

1. suites and single-test execution
2. live progress
3. structured events
4. coverage summary
5. dependency/install health checks

Do not overcomplicate it at first with:
- multi-user support
- remote agents
- distributed execution
- deep CI integration
- heavy third-party dashboards

The best version of this for Lokidoki is a focused local developer tool that feels fast, clear, and trustworthy.

---

## Nice-to-have later

- re-run failed tests only
- changed-files test selection
- open source file in editor via custom URL scheme or local helper
- timing history
- flaky test detection
- parallel run option
- optional Allure export button
- snapshot of last successful commit/push suite results
