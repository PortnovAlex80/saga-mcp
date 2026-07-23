# Saga 3 live LM Studio acceptance protocol for an operator agent

## Purpose

This suite verifies the real Saga 3 production path with a real LM Studio model. It deliberately separates two verdicts:

1. **Mechanical verdict** — durable orchestration facts, task/assignment/execution state, artifacts, oracle evidence, condition transition, and logs.
2. **Semantic verdict** — an agent reads the actual artifacts and logs and judges whether the work is correct, grounded, complete, and non-generic.

A stage is accepted only when both verdicts pass.

## Prerequisites

- LM Studio is running with its local server enabled.
- The selected model is loaded and appears in `GET /v1/models`.
- `claude` CLI is installed and can use an Anthropic-compatible base URL.
- Dependencies are installed with `npm ci` or `npm install`.

## First checkpoint

```bash
SAGA3_LIVE_LMSTUDIO=1 \
SAGA3_LIVE_MODEL="<exact-lm-studio-model-id>" \
SAGA_LMSTUDIO_URL="http://localhost:1234/v1" \
npm run test:saga3:live -- \
  --stage ConstitutionReady \
  --run-dir .saga3-live/calculator
```

The runner creates a real project, repository binding, checkout, epic, episode workflow, Saga 3 episode spec, WorkIntent, assignment, board task, and worker execution. Engine and worker output are streamed to the invoking agent and retained in the stage bundle.

## Agent responsibilities after every checkpoint

The command prints these paths:

- `MECHANICAL_REPORT`
- `SEMANTIC_REVIEW_REQUEST`
- `AGENT_REVIEW_GUIDE`

The agent must:

1. Read the complete mechanical report.
2. Read the complete engine log and worker JSONL log, not only their final lines.
3. Read every original artifact and every snapshot in `artifact-snapshots/`.
4. Compare the content with the original mandate, upstream accepted artifacts, and the stage-specific semantic checks.
5. Detect generic filler, invented requirements, contradictions, false claims of verification, missing traceability, hidden retries, scope expansion, and incomplete work.
6. Fill a copy of `semantic-review.template.json` with evidence-backed findings.
7. Validate and install the review:

```bash
npm run test:saga3:live:review -- \
  --bundle ".saga3-live/calculator/checkpoints/01-ConstitutionReady" \
  --review "<agent-review.json>"
```

The next stage is blocked unless the previous checkpoint has a canonical `semantic-review.json` with verdict `pass`.

## Continue through the pipeline

Use the same `--run-dir` so Saga resumes the same board project, database, repository, and episode:

```bash
npm run test:saga3:live -- --stage ContractConsistent --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage BaselineFrozen --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage ArchitectureReady --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage PlanReady --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage ImplementationComplete --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage VerificationCurrent --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage IntegrationComplete --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage ReleaseReady --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage ReleaseCompleted --run-dir .saga3-live/calculator
npm run test:saga3:live -- --stage ObservationHealthy --run-dir .saga3-live/calculator
```

The environment variables used for the first command must remain set for subsequent commands. Use `npm run test:saga3:live -- --list-stages` to print the canonical condition/task/skill/oracle matrix.

## Mechanical assertions

For each checkpoint the runner requires:

- project and epic exist on the board;
- project description equals the supplied mandate;
- episode spec is sealed;
- expected task kind, workflow stage, and execution skill exist;
- board task is `done` after worker completion;
- worker execution exited with code 0;
- WorkIntent is `completed`;
- WorkerAssignment is `verified`;
- expected Oracle ID produced passed evidence with controller provenance;
- target condition is `True`;
- expected artifact kinds exist and disk digests match the artifact manifest;
- engine logs show the target condition and LM Studio routing;
- worker JSONL contains a non-error result event;
- no fatal, spawn, or recovery-exhaustion marker is present.

A mechanical failure still produces a semantic review bundle so the agent can diagnose the cause. It must not be reclassified as semantic success.

## Review JSON contract

The review must contain:

- `stage`
- `verdict`: `pass`, `needs_changes`, or `fail`
- `summary`
- `confidence`: 0..1
- `inspectedArtifacts`: every artifact path with assessment and findings
- `inspectedLogs`: every required log path with assessment
- `requirementsCoverage`: one item for every stage semantic check
- `defects`: severity, description, and concrete evidence

A `pass` verdict is rejected if a semantic check is missing or if a critical/high defect is recorded.
