import { buildDevelopmentTaskGraphSubmitCallFromCase }
  from '../../../dist/modules/development/application/development-workspace-preparation.js';

const BUTTON_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Color Button</title>
  <style>
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; font-family: sans-serif; }
    #color-button { padding: 1rem 2rem; border: 0; border-radius: .5rem; color: white; background: blue; cursor: pointer; }
  </style>
</head>
<body>
  <button id="color-button" type="button" aria-pressed="false">Change color</button>
  <script>
    const button = document.querySelector('#color-button');
    button.addEventListener('click', () => {
      const becomesRed = button.style.backgroundColor !== 'red';
      button.style.backgroundColor = becomesRed ? 'red' : 'blue';
      button.setAttribute('aria-pressed', String(becomesRed));
    });
  </script>
</body>
</html>
`;

const SRS = `# Software Requirements Specification

## 1. Scope
A static one-page website with one button. Each click alternates the button color between blue and red.

## 2. Architecture

### 2.1 Architectural Style
KISS single-file architecture. Complexity is XS, topology is sequence, shared mutation risk is false.

### 2.2 Module Manifest
- single-file-html: index.html

### 2.3 Invariant Registry
- INV-1: button color is always either blue or red. Check: L2 DOM interaction test.

## §D Decomposition

### §D1. File Tree
index.html # AC-1, AC-2

### §D2. AC → Implementation Map

\`\`\`yaml
- ac: AC-1
  title: "Blue button becomes red"
  module: single-file-html
  files: [index.html]
  functions: [click-handler]
  types: []
  public_protocol: null
  conflict_keys:
    - {key_type: file_path, key_value: 'index.html'}
  invariants: [INV-1]
  test_layers: [L2]
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker

- ac: AC-2
  title: "Red button becomes blue"
  module: single-file-html
  files: [index.html]
  functions: [click-handler]
  types: []
  public_protocol: null
  conflict_keys:
    - {key_type: file_path, key_value: 'index.html'}
  invariants: [INV-1]
  test_layers: [L2]
  pattern: A
  depends_on: [AC-1]
  ac_kind: implementation
  criticality: blocker
\`\`\`

### §D3. Priority Rationale
- AC-1: high — establishes the interaction.
- AC-2: medium — completes the toggle invariant.

### §D4. Pattern Selection per Module Cluster
- cluster: single-file-html (AC-1, AC-2)
  pattern: A
  reason: one file and one sequential interaction.

## §7 Ubiquitous Language Glossary
- Color button: the only interactive button in index.html.

## §8 Out-of-scope
- No framework, backend, persistence, authentication or network integration.

## §9 Technology Stack
\`\`\`yaml
language: html-javascript
runtime: modern-browser
frameworks: []
test_framework: node --test
automation: none
property_test_framework: none
linter: none
formatter: none
type_checker: none
build_tool: none
justification: XS static page needs no build system.
adr: ADR-001
\`\`\`

## §11 External Integration Landscape
(none)

## §12 Decision Log
| # | Decision | Source/profile | Alternatives considered | Rationale | Date |
|---|----------|----------------|-------------------------|-----------|------|
| 1 | Single HTML file | local | framework SPA; multi-file site | XS scope and no shared surface | 2026-08-06 |
| 2 | Browser-native JavaScript | local | React; Vue | no framework is required for one click handler | 2026-08-06 |
`;

function done(ctx, result = 'deterministic scenario completed') {
  return {
    type: 'worker_done',
    args: {
      task_id: '{{ctx.task_id}}',
      worker_id: '{{ctx.worker_id}}',
      execution_id: '{{ctx.execution_id}}',
      result,
      verdict: 'approved',
    },
  };
}

function artifactBase(ctx, type, code, title, path) {
  return {
    project_id: '{{ctx.project_id}}',
    epic_id: '{{ctx.epic_id}}',
    type, code, title, path, status: 'draft',
  };
}

export function selectButtonColorScenario(ctx, env = process.env) {
  const fault = env.SAGA_SIM_FAULT || 'none';
  if (fault === 'process-exit') {
    return { id: 'button-color/fault/process-exit', steps: [
      { type: 'emit', text: 'simulator: injected process failure' },
      { type: 'exit_error', message: 'SIMULATOR_INJECTED_PROCESS_FAILURE' },
    ] };
  }

  // Check process_node_id FIRST — the author/reviewer distinction is
  // node-specific. A reviewer for define-architecture-contract should NOT
  // match the generic reviewer path before checking if there's a
  // node-specific scenario.
  switch (ctx.process_node_id) {
    case 'produce-proposal':
      return {
        id: 'button-color/discovery/proposal',
        steps: [
          {
            type: 'proposal_submit',
            as: 'proposal',
            args: {
              intent_id: '{{ctx.metadata.work_intent_id}}',
              task_id: '{{ctx.task_id}}',
              execution_id: '{{ctx.execution_id}}',
              kind: 'discovery',
              schema_version: 'factory.discovery-proposal.v1',
              payload: {
                problem_statement: 'A static one-page website needs a button that toggles between blue and red on each click.',
                observed_context: 'No existing product; greenfield static page with a single interactive element.',
                stakeholders_or_actors: ['end-user'],
                assumptions: ['Modern browser with JavaScript enabled', 'No backend or persistence required'],
                unknowns: [],
                risks: [],
                candidate_scope: 'Single index.html file with inline CSS and JavaScript. One button element. Click handler alternates background color.',
                evidence_refs: ['initiative.subject'],
                recommended_outcome: 'go',
                rationale: 'Minimal XS scope. One file, one interaction, no dependencies. Deterministic implementation.',
              },
            },
          },
          done(ctx, 'Submitted discovery proposal with recommended_outcome=go.'),
        ],
      };

    case 'assess-readiness':
      return {
        id: 'button-color/discovery/readiness',
        steps: [
          {
            type: 'readiness_get',
            args: {
              control_intent_id: '{{ctx.metadata.control_intent_id}}',
              execution_id: '{{ctx.execution_id}}',
            },
          },
          {
            type: 'readiness_submit',
            args: {
              control_intent_id: '{{ctx.metadata.control_intent_id}}',
              execution_id: '{{ctx.execution_id}}',
              schema_version: 'factory.discovery-readiness-assessment.v1',
              payload: {
                proposal_id: '{{aliases.readiness_proposal_id}}',
                proposal_content_hash: '{{aliases.readiness_proposal_hash}}',
                overall_readiness: 'ready',
                dimension_assessments: {
                  problem_clarity: { status: 'sufficient', rationale: 'Single button toggle is unambiguous.', source_refs: ['$.problem_statement'] },
                  scope_boundedness: { status: 'sufficient', rationale: 'One file, one interaction, XS.', source_refs: ['$.candidate_scope'] },
                  stakeholder_coverage: { status: 'sufficient', rationale: 'End user is the only stakeholder.', source_refs: ['$.stakeholders_or_actors'] },
                  assumption_visibility: { status: 'sufficient', rationale: 'Modern browser with JS is standard.', source_refs: ['$.assumptions'] },
                  unknowns_manageability: { status: 'sufficient', rationale: 'No unknowns.', source_refs: ['$.unknowns'] },
                  risk_visibility: { status: 'sufficient', rationale: 'No risks for a static page.', source_refs: ['$.risks'] },
                  evidence_grounding: { status: 'sufficient', rationale: 'Initiative subject provides clear grounding.', source_refs: ['$.evidence_refs'] },
                },
                blocking_gaps: [],
                non_blocking_gaps: [],
                recommended_next_action: 'proceed_to_settlement',
                confidence: 0.95,
                rationale: 'XS static page with deterministic implementation path. All dimensions sufficient.',
              },
            },
          },
          done(ctx, 'Submitted readiness assessment: ready, proceed to settlement.'),
        ],
      };

    case 'define-product-contract': {
      // Idempotent: on recovery retry, if artifacts already exist, skip
      // creation and just worker_done. Re-creating would pollute the
      // managed-production ledger with a new producer execution.
      if (ctx.isRetry) {
        return {
          id: 'button-color/formalization/product-contract/idempotent',
          steps: [
            { type: 'emit', text: 'simulator: recovery retry — artifacts already created, worker_done only' },
            done(ctx, 'Idempotent retry: artifacts exist from previous run.'),
          ],
        };
      }
      return {
        id: 'button-color/formalization/product-contract',
        steps: [
          { type: 'artifact_find', artifactType: 'brief', as: 'brief' },
          {
            type: 'artifact_create', as: 'prd',
            args: artifactBase(ctx, 'PRD', 'PRD-1', 'Color Button PRD', 'docs/01-PRD.md'),
            content: '# PRD\n\nA static page with one button that alternates blue and red on every click.\n',
          },
          {
            type: 'trace_add',
            args: { source_id: '{{aliases.prd}}', target_type: 'artifact', target_id: '{{aliases.brief}}', link_type: 'derived_from' },
          },
          {
            type: 'artifact_create', as: 'fr',
            args: artifactBase(ctx, 'FR', 'FR-1', 'Toggle button color', 'docs/02-FR-1.md'),
            content: '# FR-1\n\nThe system shall alternate the button color between blue and red after each click.\n',
          },
          {
            type: 'trace_add',
            args: { source_id: '{{aliases.fr}}', target_type: 'artifact', target_id: '{{aliases.prd}}', link_type: 'derived_from' },
          },
          {
            type: 'artifact_create', as: 'rule',
            args: artifactBase(ctx, 'RULE', 'RULE-1', 'Allowed button colors', 'docs/03-RULE-1.md'),
            content: '# RULE-1\n\nThe button color is always blue or red.\n',
          },
          {
            type: 'trace_add',
            args: { source_id: '{{aliases.rule}}', target_type: 'artifact', target_id: '{{aliases.prd}}', link_type: 'derived_from' },
          },
          done(ctx, 'Created PRD, FR and RULE for the color-button product.'),
        ],
      };
    }

    case 'model-use-cases': {
      if (ctx.isRetry) return { id: 'button-color/formalization/use-case/idempotent', steps: [done(ctx, 'Idempotent retry.')] };
      return {
        id: 'button-color/formalization/use-case',
        steps: [
          { type: 'artifact_find', artifactType: 'PRD', code: 'PRD-1', as: 'prd' },
          { type: 'artifact_find', artifactType: 'FR', code: 'FR-1', as: 'fr' },
          {
            type: 'artifact_create', as: 'uc',
            args: artifactBase(ctx, 'UC', 'UC-1', 'Change button color', 'docs/04-UC-1.md'),
            content: '# UC-1 Change button color\n\nActor clicks the button. The system changes blue to red or red to blue.\n',
          },
          { type: 'trace_add', args: { source_id: '{{aliases.uc}}', target_type: 'artifact', target_id: '{{aliases.prd}}', link_type: 'derived_from' } },
          { type: 'trace_add', args: { source_id: '{{aliases.uc}}', target_type: 'artifact', target_id: '{{aliases.fr}}', link_type: 'covers' } },
          done(ctx, 'Created UC-1 covering FR-1.'),
        ],
      };
    }

    case 'define-acceptance-contract': {
      if (ctx.isRetry) return { id: 'button-color/formalization/acceptance/idempotent', steps: [done(ctx, 'Idempotent retry.')] };
      const omitFr = fault === 'missing-ac-fr-trace';
      const steps = [
        { type: 'artifact_find', artifactType: 'UC', code: 'UC-1', as: 'uc' },
        { type: 'artifact_find', artifactType: 'FR', code: 'FR-1', as: 'fr' },
        {
          type: 'artifact_create', as: 'ac1',
          args: artifactBase(ctx, 'AC', 'AC-1', 'Blue becomes red', 'docs/05-AC-1.md'),
          content: '# AC-1\n\nGiven the button is blue, when it is clicked, then it becomes red.\n',
        },
        { type: 'trace_add', args: { source_id: '{{aliases.ac1}}', target_type: 'artifact', target_id: '{{aliases.uc}}', link_type: 'derived_from' } },
      ];
      if (!omitFr) steps.push({ type: 'trace_add', args: { source_id: '{{aliases.ac1}}', target_type: 'artifact', target_id: '{{aliases.fr}}', link_type: 'derived_from' } });
      steps.push(
        {
          type: 'artifact_create', as: 'ac2',
          args: artifactBase(ctx, 'AC', 'AC-2', 'Red becomes blue', 'docs/06-AC-2.md'),
          content: '# AC-2\n\nGiven the button is red, when it is clicked, then it becomes blue.\n',
        },
        { type: 'trace_add', args: { source_id: '{{aliases.ac2}}', target_type: 'artifact', target_id: '{{aliases.uc}}', link_type: 'derived_from' } },
        { type: 'trace_add', args: { source_id: '{{aliases.ac2}}', target_type: 'artifact', target_id: '{{aliases.fr}}', link_type: 'derived_from' } },
        done(ctx, omitFr ? 'Injected AC trace gap.' : 'Created two fully traced acceptance criteria.'),
      );
      return { id: `button-color/formalization/acceptance/${fault}`, steps };
    }

    case 'reconcile-what': {
      if (ctx.isRetry) return { id: 'button-color/formalization/reconcile/idempotent', steps: [done(ctx, 'Idempotent retry.')] };
      return { id: 'button-color/formalization/reconcile', steps: [done(ctx, 'WHAT graph inspected; no repair required.')] };
    }

    case 'define-architecture-contract': {
      if (ctx.isRetry) return { id: 'button-color/formalization/architecture/idempotent', steps: [done(ctx, 'Idempotent retry.')] };
      // Reviewer for this node: emit verdict only, do NOT author products.
      if (ctx.role === 'reviewer') {
        const verdict = fault === 'review-changes-requested' ? 'changes_requested' : 'approved';
        return {
          id: `button-color/reviewer/architecture/${verdict}`,
          steps: [{
            type: 'worker_done',
            args: {
              task_id: '{{ctx.task_id}}', worker_id: '{{ctx.worker_id}}',
              execution_id: '{{ctx.execution_id}}',
              result: verdict === 'approved'
                ? 'Reviewer: SRS matches the pinned contract.'
                : 'Reviewer: injected correction request.',
              verdict,
            },
          }],
        };
      }
      const content = fault === 'missing-srs-decision-log'
        ? SRS.replace(/## §12 Decision Log[\s\S]*$/, '')
        : SRS;
      return {
        id: `button-color/formalization/architecture/${fault}`,
        steps: [
          { type: 'artifact_find', artifactType: 'PRD', code: 'PRD-1', as: 'prd' },
          {
            type: 'artifact_create', as: 'srs',
            args: artifactBase(ctx, 'SRS', 'SRS-1', 'Color Button SRS', 'docs/07-SRS.md'),
            content,
          },
          { type: 'trace_add', args: { source_id: '{{aliases.srs}}', target_type: 'artifact', target_id: '{{aliases.prd}}', link_type: 'derived_from' } },
          done(ctx, 'Created XS single-file SRS for the color-button product.'),
        ],
      };
    }

    case 'plan-task-graph': {
      if (ctx.role === 'reviewer') {
        return {
          id: 'button-color/development/plan-task-graph/review',
          steps: [done(ctx, 'Reviewed the exact submitted task graph.')],
        };
      }
      // Development planner node. The lifecycle has frozen a DevelopmentCase
      // in task.metadata.process_node_input (with resolved projectRepositoryId).
      // Build the deterministic task-graph proposal and submit it through the
      // universal process_node_submit tool. Idempotent: on recovery retry the
      // same payload reproduces the same submission_ref.
      const nodeInput = ctx.metadata?.process_node_input
        ?? JSON.parse(ctx.task?.metadata || '{}').process_node_input;
      if (!nodeInput || nodeInput.schemaVersion !== 'factory.development-case.v1') {
        return {
          id: 'button-color/development/plan-task-graph/error',
          steps: [{
            type: 'exit_error',
            message: `SIMULATOR_DEVELOPMENT_CASE_MISSING: nodeInput=${JSON.stringify(nodeInput)?.slice(0, 120)}`,
          }],
        };
      }
      const call = buildDevelopmentTaskGraphSubmitCallFromCase(nodeInput);
      return {
        id: `button-color/development/plan-task-graph${ctx.isRetry ? '/retry' : ''}`,
        steps: [
          {
            type: 'process_node_submit',
            args: {
              schema: call.arguments.schema,
              payload: call.arguments.payload,
            },
          },
          done(ctx, `Submitted development task-graph proposal: ${call.arguments.payload.implementationItems.length} impl + ${call.arguments.payload.verificationItems.length} verify items.`),
        ],
      };
    }
    default:
      break;
  }

  // Reviewer path — only reached when no process_node_id matched (legacy
  // tasks, or review nodes without a node-specific scenario).
  if (ctx.role === 'reviewer') {
    const verdict = fault === 'review-changes-requested' ? 'changes_requested' : 'approved';
    return {
      id: `button-color/reviewer/${verdict}`,
      steps: [
        ...(ctx.process_node_id === 'implement-work-items' ? [{
          type: 'process_node_submit',
          args: {
            schema: 'factory.development-review-verdict.v1',
            payload: {
              schemaVersion: 'factory.development-review-verdict.v1',
              verdict,
              rationale: verdict === 'approved'
                ? 'Deterministic review accepted the pinned author product.'
                : 'Injected deterministic correction request.',
            },
          },
        }] : []),
        {
          type: 'worker_done',
          args: {
          task_id: '{{ctx.task_id}}', worker_id: '{{ctx.worker_id}}',
          execution_id: '{{ctx.execution_id}}',
          result: verdict === 'approved'
            ? 'Deterministic reviewer: candidate matches the pinned contract.'
            : 'Deterministic reviewer: injected correction request.',
          verdict,
          },
        },
      ],
    };
  }

  if (ctx.task_kind === 'discovery.kickstart') {
    const decision = env.SAGA_SIM_DECISION || 'go';
    return {
      id: `button-color/discovery/${decision}`,
      steps: [
        {
          type: 'artifact_create', as: 'brief',
          args: {
            project_id: '{{ctx.project_id}}', epic_id: '{{ctx.epic_id}}',
            type: 'brief', code: 'BRIEF-1', title: 'Color Button Brief',
            path: 'docs/00-BRIEF.md', status: 'accepted',
            metadata: {
              brief_payload: {
                classification: 'product-feature',
                complexity: { tshirt: 'XS', risk_triggers: [] },
                decision,
                reasoning: 'A deterministic minimal product for conveyor conformance.',
                affected_projects: ['{{ctx.project_id}}'],
                topology_hint: 'sequence', scaffold_artifacts: [],
                shared_mutation_risk: false, completeness: 'high', degraded: false,
              },
            },
          },
          content: '# Brief\n\nCreate a page with one button. Each click alternates its color between blue and red.\n',
        },
        done(ctx, `Created accepted discovery brief with decision ${decision}.`),
      ],
    };
  }

  if (ctx.task_kind === 'development.code') {
    return {
      id: 'button-color/development/code',
      steps: [
        { type: 'write_file', path: 'index.html', content: BUTTON_HTML, as: 'index_html' },
        { type: 'development_implementation_submit', content: BUTTON_HTML },
        done(ctx, 'Implemented index.html with a deterministic blue/red toggle.'),
      ],
    };
  }

  if (ctx.task_kind === 'verification.ac') {
    return {
      id: 'button-color/development/verification',
      steps: [
        { type: 'development_verification_submit' },
        done(ctx, 'Recorded deterministic passing evidence.'),
      ],
    };
  }

  if (env.SAGA_SIM_ALLOW_GENERIC_APPROVE === '1') {
    return { id: 'compat/generic-approve', steps: [done(ctx, 'Compatibility generic approval.')] };
  }

  return {
    id: 'unsupported',
    steps: [{
      type: 'exit_error',
      message: `SIMULATOR_SCENARIO_NOT_FOUND: module=${ctx.process_module_ref} node=${ctx.process_node_id} task_kind=${ctx.task_kind} role=${ctx.role}`,
    }],
  };
}
