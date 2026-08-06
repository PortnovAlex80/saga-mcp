# Deterministic Claude CLI Simulator

`tools/claude-cli-simulator.mjs` is a subprocess-compatible replacement for the
Claude CLI on Saga conveyor tests. It receives the same argv, prompt, cwd,
environment and MCP configuration that `tracker-view/claude-runner.mjs` sends
to the real executable. It emits Claude-style `stream-json` envelopes and uses
the real Saga handlers and execution fence.

The simulator is not an alternate conveyor implementation. It replaces only
the nondeterministic model process. Task assignment, artifact provenance,
submission validation, review, recovery, CandidateSet/GateRun processing and
integration remain owned by the normal runtime.

## Run the button-color scenario

```bash
npm run build
npm run simulator:button -- --project <project-id>
```

Equivalent explicit configuration:

```bash
SAGA_SIM_SCENARIO=button-color \
SAGA_CLAUDE_PATH="node tools/claude-cli-simulator.mjs" \
node dist/orchestrate-cli.js --project <project-id>
```

The golden product is intentionally minimal: a static `index.html` with one
button. The initial color is blue; every click alternates blue and red.

The scripted workers currently cover:

- Discovery kickstart brief.
- Formalization PRD/FR/RULE.
- Use case and exact traces.
- Two acceptance criteria and exact UC/FR traces.
- WHAT reconciliation completion.
- XS SRS with §D1-§D4 and §12 Decision Log.
- Author/reviewer task completion.
- `development.code` creation of the real HTML file.
- Acceptance verification evidence.
- Approved git review integration through the real merge lock handlers.

Unknown production work fails closed. The isolated `tests/mock-claude.mjs`
entrypoint enables generic approval explicitly only to keep historical tests
running while they migrate to named scenarios.

## Fault injection

Set `SAGA_SIM_FAULT`:

```bash
SAGA_SIM_FAULT=missing-ac-fr-trace
SAGA_SIM_FAULT=missing-srs-decision-log
SAGA_SIM_FAULT=review-changes-requested
SAGA_SIM_FAULT=process-exit
```

These faults are submitted through the same worker-facing surface as correct
products. They do not mutate the database behind the conveyor.

`SAGA_SIM_EXIT_ZERO_ON_FAILURE=1` is compatibility-only. The canonical simulator
returns a non-zero process status on an unsupported scenario or injected
process failure.

## Architectural rules

1. A scenario must call the real Saga handlers or write through the real worker
   workspace. It must not seed acceptance, GateDecision or ProcessRun terminal
   state directly.
2. Scenario matching uses the durable task binding: process module, process
   node, role, task kind and attempt. Prompt fields are only the launch input;
   the task row is re-read before execution.
3. Every scenario is deterministic and fails when required input is absent.
4. Reviewer scenarios do not author or mutate author products.
5. A successful simulator run proves conveyor mechanics for the fixture. It
   does not prove that a real LLM will follow the same contract.

## Adding a scenario

Add a selector under `tools/claude-simulator/scenarios/`. Return a stable
scenario id and a list of typed steps. Existing step types include:

- `artifact_find`
- `artifact_create`
- `trace_add`
- `write_file`
- `verification_record`
- `worker_done`
- `git_integrate`
- `assert`
- `sleep`
- `exit_error`

A placeholder occupying the entire value preserves its type:

```js
{ task_id: '{{ctx.task_id}}' } // integer
```

A placeholder embedded in text is string-rendered:

```js
{ title: 'Task {{ctx.task_id}}' }
```
