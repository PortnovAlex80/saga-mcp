// Node plugin registry — the n8n contract, minimal: a node type is a name and
// a deterministic execute() that turns input items into output items.
// The kernel knows nothing about individual node semantics; workshops are data.
//
// M1 ships scripted (deterministic) node types only: they make the kernel
// provable without LLMs. LLM activity nodes arrive in M2 behind the same
// execute() boundary, with their own timeouts/heartbeats.

export interface Item {
  json: Record<string, unknown>;
}

export interface NodeExecuteContext {
  nodeId: string;
  parameters: Record<string, unknown>;
  /** The accumulated desk of all inbound nodes: every completed material's
   *  items in event order, exact digests (ADR-053: never 'latest'). */
  inputs: Item[];
}

export interface NodeType {
  name: string;
  /** Activities run OUTSIDE kernel transactions in a worker process
   *  (lease + heartbeat + typed timeouts + retry). The kernel never calls
   *  execute() for them; it only schedules and folds their executions. */
  activity?: boolean;
  /** Gates are decided by the kernel itself (deterministic checks over the
   *  sealed desk revision): accepted | repair_required | human_required. */
  gate?: boolean;
  /** Split: kernel reads input items and spawns one child node per item
   *  (nodes.spawned event, atomic) — dynamic fan-out, the conveyor model's
   *  "materialize the complete sealed set before admission". */
  splitter?: boolean;
  /** Join: runnable only after ALL children of the upstream split completed;
   *  its inputs are the union of the children's desks. */
  joiner?: boolean;
  execute(ctx: NodeExecuteContext): Item[];
}

function asItems(parameters: Record<string, unknown>): Item[] {
  const raw = parameters.items;
  if (!Array.isArray(raw)) {
    throw new Error('NODE_PARAMETERS_INVALID: emit requires parameters.items (array)');
  }
  return raw.map((entry) => {
    if (entry && typeof entry === 'object' && 'json' in (entry as Record<string, unknown>)) {
      return { json: (entry as { json: Record<string, unknown> }).json };
    }
    return { json: (entry ?? {}) as Record<string, unknown> };
  });
}

const emit: NodeType = {
  name: 'emit',
  execute: (ctx) => asItems(ctx.parameters),
};

/** Renders `{{field.sub}}` placeholders against one item's json. Shared by the
 *  template node and the LLM activity worker. */
export function renderTemplateString(tmpl: string, json: Record<string, unknown>): string {
  return tmpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = key.split('.').reduce<unknown>(
      (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
      json
    );
    return value === undefined || value === null ? '' : String(value);
  });
}

const template: NodeType = {
  name: 'template',
  execute: (ctx) => {
    const tmpl = ctx.parameters.template;
    if (typeof tmpl !== 'string') {
      throw new Error('NODE_PARAMETERS_INVALID: template requires parameters.template (string)');
    }
    const sourceItems = ctx.inputs;
    const items = sourceItems.length > 0 ? sourceItems : [{ json: {} }];
    return items.map((item) => ({
      json: { text: renderTemplateString(tmpl, item.json) },
    }));
  },
};

const collect: NodeType = {
  name: 'collect',
  execute: (ctx) => [{ json: { items: ctx.inputs.map((item) => item.json) } }],
};

const fail: NodeType = {
  name: 'fail',
  execute: (ctx) => {
    throw new Error(String(ctx.parameters.message ?? 'node failed'));
  },
};

// The LLM activity node. Non-determinism is confined to the worker process;
// the kernel only sees scheduled/started/heartbeat/completed events.
// parameters:
//   prompt       — template rendered against each input item, joined with '\n\n'
//   mode         — 'api' (OpenAI-compatible endpoint) | 'echo' (scripted,
//                  deterministic — same physics, no network; default)
//   model, system?, temperature?              — api mode
//   sleep_ms?, crash_attempt?                 — scripted test knobs
//   timeouts?, retry?                         — activity policy overrides
const llm: NodeType = {
  name: 'llm',
  activity: true,
  execute: () => {
    throw new Error('ACTIVITY_MISUSE: llm nodes are executed by worker processes, not by the kernel');
  },
};

// The quality gate. Decided by the kernel over the sealed desk revision —
// never executed as an ordinary node. parameters:
//   checks: [{op: 'nonempty'|'contains'|'regex', field?, value?, pattern?}]
//   repair_target: node re-executed on repair_required (default: first inbound)
//   max_repairs: repair_required budget before human_required (default 2)
const gate: NodeType = {
  name: 'gate',
  gate: true,
  execute: () => {
    throw new Error('GATE_MISUSE: gates are decided by the kernel, not executed');
  },
};

// The external-effect activity (M4): authorized side effects (git, deploy)
// performed by the worker process with an idempotency key and a typed receipt.
// parameters:
//   mode: 'git'        — commit desk material into a repository
//   repo, branch, message, files: [{path, field}], action?: 'git_revert'
const effect: NodeType = {
  name: 'effect',
  activity: true,
  execute: () => {
    throw new Error('ACTIVITY_MISUSE: effect nodes are executed by worker processes, not by the kernel');
  },
};

// Deterministic JSON extractor: each input item's text must be a JSON array;
// every element becomes one output item. Planner outputs become task items.
const jsonParse: NodeType = {
  name: 'json_parse',
  execute: (ctx) => {
    const out: Item[] = [];
    for (const item of ctx.inputs) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(item.json.text ?? ''));
      } catch (error) {
        throw new Error(`JSON_PARSE_FAILED: ${(error as Error).message}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error('JSON_PARSE_FAILED: expected a JSON array');
      }
      for (const element of parsed) {
        out.push({
          json:
            element && typeof element === 'object' && !Array.isArray(element)
              ? (element as Record<string, unknown>)
              : { value: element },
        });
      }
    }
    return out;
  },
};

// Dynamic fan-out: parameters.child = {type, parameters}. The kernel spawns
// one child per input item (see runner's executeSplit).
const split: NodeType = {
  name: 'split',
  splitter: true,
  execute: () => {
    throw new Error('SPLITTER_MISUSE: split nodes are executed by the kernel');
  },
};

// Fan-in: waits for all spawned siblings; inputs = union of children desks.
const join: NodeType = {
  name: 'join',
  joiner: true,
  execute: (ctx) => [{ json: { items: ctx.inputs.map((item) => item.json) } }],
};

const REGISTRY: Record<string, NodeType> = {
  emit, template, collect, fail, llm, gate, effect,
  json_parse: jsonParse, split, join,
};

export function getNodeType(name: string): NodeType {
  const type = REGISTRY[name];
  if (!type) {
    throw new Error(`NODE_TYPE_UNKNOWN: '${name}'`);
  }
  return type;
}

export function nodeTypeNames(): Set<string> {
  return new Set(Object.keys(REGISTRY));
}
