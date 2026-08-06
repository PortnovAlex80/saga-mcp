import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseClaudeArgv,
  parseSagaPrompt,
  renderTemplate,
} from '../tools/claude-simulator/runtime.mjs';
import { selectButtonColorScenario } from '../tools/claude-simulator/scenarios/button-color.mjs';

const BASE_CTX = {
  project_id: 1,
  epic_id: 2,
  task_id: 3,
  worker_id: 'worker-1',
  execution_id: 'exec-1',
  process_module_ref: 'solution-formalization@1.0.0',
  process_node_id: 'define-architecture-contract',
  task_kind: 'formalization.srs',
  role: 'author',
  attempt: 1,
  workspace_root: '/tmp/button-color',
  task: { verification_target_artifact_id: 99 },
};

test('parseClaudeArgv accepts the real runner flag shape and final positional prompt', () => {
  const parsed = parseClaudeArgv([
    'node', 'simulator.mjs', '--print', '--verbose',
    '--output-format', 'stream-json', '--mcp-config', '/tmp/mcp.json',
    '--permission-mode', 'bypassPermissions', 'PROMPT BODY',
  ]);
  assert.equal(parsed.mcpConfigPath, '/tmp/mcp.json');
  assert.equal(parsed.prompt, 'PROMPT BODY');
});

test('parseSagaPrompt extracts the immutable Saga launch binding before Hard rules', () => {
  const parsed = parseSagaPrompt([
    'You are a worker.',
    'project_id=11',
    'task_id=22',
    'worker_id=w-22',
    'execution_id=e-22',
    'process_module_ref=solution-formalization@1.0.0',
    'execution_profile=formalization-architect',
    'Hard rules:',
    'task_id=999',
  ].join('\n'));
  assert.equal(parsed.project_id, 11);
  assert.equal(parsed.task_id, 22);
  assert.equal(parsed.worker_id, 'w-22');
  assert.equal(parsed.execution_id, 'e-22');
  assert.equal(parsed.process_module_ref, 'solution-formalization@1.0.0');
});

test('template rendering preserves numeric contract values for handlers', () => {
  const rendered = renderTemplate({
    task: '{{ctx.task_id}}',
    trace: ['{{aliases.srs}}', '{{ctx.process_node_id}}'],
    label: 'task-{{ctx.task_id}}',
  }, { ctx: BASE_CTX, aliases: { srs: 42 } });
  assert.deepEqual(rendered, {
    task: 3,
    trace: [42, 'define-architecture-contract'],
    label: 'task-3',
  });
});

test('architecture author scenario produces a complete SRS and exact PRD trace', () => {
  const scenario = selectButtonColorScenario(BASE_CTX, {});
  assert.equal(scenario.id, 'button-color/formalization/architecture/none');
  const create = scenario.steps.find(step => step.type === 'artifact_create');
  assert.equal(create.args.type, 'SRS');
  assert.match(create.content, /### §D2\. AC → Implementation Map/);
  assert.match(create.content, /criticality: blocker/);
  assert.match(create.content, /## §12 Decision Log/);
  assert.match(create.content, /Single HTML file/);
  const trace = scenario.steps.find(step => step.type === 'trace_add');
  assert.equal(trace.args.link_type, 'derived_from');
  assert.equal(trace.args.target_id, '{{aliases.prd}}');
});

test('fault scenario removes Decision Log so the real SRS gate can reject it', () => {
  const scenario = selectButtonColorScenario(BASE_CTX, {
    SAGA_SIM_FAULT: 'missing-srs-decision-log',
  });
  const create = scenario.steps.find(step => step.type === 'artifact_create');
  assert.doesNotMatch(create.content, /## §12 Decision Log/);
  assert.match(create.content, /### §D2\. AC → Implementation Map/);
});

test('acceptance fault omits exactly one mandatory FR trace', () => {
  const scenario = selectButtonColorScenario({
    ...BASE_CTX,
    process_node_id: 'define-acceptance-contract',
    task_kind: 'formalization.acceptance',
  }, { SAGA_SIM_FAULT: 'missing-ac-fr-trace' });
  const ac1Traces = scenario.steps.filter(step =>
    step.type === 'trace_add' && step.args.source_id === '{{aliases.ac1}}');
  assert.equal(ac1Traces.length, 1);
  assert.equal(ac1Traces[0].args.target_id, '{{aliases.uc}}');
  const ac2Traces = scenario.steps.filter(step =>
    step.type === 'trace_add' && step.args.source_id === '{{aliases.ac2}}');
  assert.equal(ac2Traces.length, 2);
});

test('reviewer scenario never authors products and emits an explicit verdict', () => {
  const scenario = selectButtonColorScenario({ ...BASE_CTX, role: 'reviewer' }, {});
  assert.equal(scenario.steps.length, 1);
  assert.equal(scenario.steps[0].type, 'worker_done');
  assert.equal(scenario.steps[0].args.verdict, 'approved');
});

test('development scenario writes an actual working HTML product', () => {
  const scenario = selectButtonColorScenario({
    ...BASE_CTX,
    process_module_ref: 'solution-development@1.0.0',
    process_node_id: null,
    task_kind: 'development.code',
  }, {});
  const write = scenario.steps.find(step => step.type === 'write_file');
  assert.equal(write.path, 'index.html');
  assert.match(write.content, /id="color-button"/);
  assert.match(write.content, /button\.addEventListener\('click'/);
  assert.match(write.content, /becomesRed \? 'red' : 'blue'/);
});

test('unknown production work fails closed unless compatibility fallback is explicit', () => {
  const unknown = {
    ...BASE_CTX,
    process_module_ref: 'unknown@1',
    process_node_id: 'unknown-node',
    task_kind: 'unknown.work',
  };
  const scenario = selectButtonColorScenario(unknown, {});
  assert.equal(scenario.id, 'unsupported');
  assert.equal(scenario.steps[0].type, 'exit_error');

  const compatibility = selectButtonColorScenario(unknown, {
    SAGA_SIM_ALLOW_GENERIC_APPROVE: '1',
  });
  assert.equal(compatibility.id, 'compat/generic-approve');
});
