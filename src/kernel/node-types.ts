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
  /** Input items per inbound edge, in connection order. */
  inputs: Item[][];
}

export interface NodeType {
  name: string;
  /** Activities run OUTSIDE kernel transactions in a worker process
   *  (lease + heartbeat + typed timeouts + retry). The kernel never calls
   *  execute() for them; it only schedules and folds their executions. */
  activity?: boolean;
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
    const sourceItems = ctx.inputs.flat();
    const items = sourceItems.length > 0 ? sourceItems : [{ json: {} }];
    return items.map((item) => ({
      json: { text: renderTemplateString(tmpl, item.json) },
    }));
  },
};

const collect: NodeType = {
  name: 'collect',
  execute: (ctx) => [{ json: { items: ctx.inputs.flat().map((item) => item.json) } }],
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

const REGISTRY: Record<string, NodeType> = { emit, template, collect, fail, llm };

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
