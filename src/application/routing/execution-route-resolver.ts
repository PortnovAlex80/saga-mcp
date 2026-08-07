/**
 * ExecutionRouteResolver — decides WHICH backend runs one worker execution.
 *
 * The policy is loaded once when factory composition is created. It selects an
 * executor and may optionally override provider/model/effort. Missing inference
 * fields are intentionally left null here and inherit the already-read
 * lifecycle execution controls inside the atomic claim transaction.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_ROUTE,
  type ExecutorKind,
  type RouteMatchKey,
  type WorkerExecutionRoute,
} from './worker-execution-route.js';

export interface RouteRule {
  match: {
    module?: string;
    cell?: string;
    role?: 'author' | 'reviewer';
    executionProfile?: string;
  };
  route: {
    executor: { kind: ExecutorKind };
    /** Optional inference overrides for a real executor. */
    provider?: string;
    model?: string;
    effort?: string | null;
  };
}

export interface ExecutionRoutesFile {
  version?: string;
  default?: RouteRule['route'];
  routes: RouteRule[];
}

export interface ExecutionRouteResolverOptions {
  policy?: ExecutionRoutesFile;
  policyPath?: string;
  envPolicyJson?: string;
}

export function createExecutionRouteResolver(
  options: ExecutionRouteResolverOptions = {},
): {
  resolve: (key: RouteMatchKey) => WorkerExecutionRoute;
  policyRef: string;
  policyDigest: string;
} {
  const loaded = loadPolicy(options);
  const policy = validateAndNormalizePolicy(loaded.policy);
  const policyDigest = digestPolicy(policy);
  const policyRef = loaded.policyRef;

  const ranked = policy.routes
    .map((rule, index) => ({ rule, index, score: specificity(rule) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  function matchRule(rule: RouteRule, key: RouteMatchKey): boolean {
    const m = rule.match;
    if (m.module !== undefined && m.module !== key.module) return false;
    if (m.cell !== undefined && m.cell !== key.cell) return false;
    if (m.role !== undefined && m.role !== key.role) return false;
    if (m.executionProfile !== undefined && m.executionProfile !== key.executionProfile) return false;
    return true;
  }

  function toRoute(ruleRoute: RouteRule['route']): WorkerExecutionRoute {
    if (ruleRoute.executor.kind === 'claude-cli-simulator') {
      return {
        executor: { kind: 'claude-cli-simulator' },
        provider: null,
        model: null,
        inference: { effort: null },
        policyRef,
        policyDigest,
      };
    }
    return {
      executor: { kind: 'claude-cli' },
      provider: ruleRoute.provider ? { id: ruleRoute.provider } : null,
      model: ruleRoute.model ? { id: ruleRoute.model } : null,
      inference: { effort: ruleRoute.effort ?? null },
      policyRef,
      policyDigest,
    };
  }

  function resolve(key: RouteMatchKey): WorkerExecutionRoute {
    for (const { rule } of ranked) {
      if (matchRule(rule, key)) return toRoute(rule.route);
    }
    if (policy.default) return toRoute(policy.default);
    return {
      ...DEFAULT_ROUTE,
      policyRef,
      policyDigest,
    };
  }

  return { resolve, policyRef, policyDigest };
}

function specificity(rule: RouteRule): number {
  const m = rule.match;
  let n = 0;
  if (m.module !== undefined) n += 1;
  if (m.cell !== undefined) n += 2;
  if (m.role !== undefined) n += 1;
  if (m.executionProfile !== undefined) n += 4;
  return n;
}

function loadPolicy(options: ExecutionRouteResolverOptions): {
  policy: ExecutionRoutesFile;
  policyRef: string;
} {
  if (options.policy) {
    return {
      policy: options.policy,
      policyRef: options.policyPath ?? '<inline>',
    };
  }

  const envJson = options.envPolicyJson ?? process.env.SAGA_EXECUTION_ROUTES_JSON;
  if (envJson && envJson.trim()) {
    try {
      return {
        policy: JSON.parse(envJson) as ExecutionRoutesFile,
        policyRef: '<env:SAGA_EXECUTION_ROUTES_JSON>',
      };
    } catch (error) {
      throw new Error(
        `EXECUTION_ROUTES_ENV_PARSE_FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const policyPath = options.policyPath
    ?? process.env.SAGA_EXECUTION_ROUTES_PATH
    ?? path.join(
      process.env.SAGA_REPO_ROOT ?? process.cwd(),
      'factory-execution-routes.json',
    );
  if (!existsSync(policyPath)) {
    return {
      policy: { routes: [] },
      policyRef: policyPath,
    };
  }
  try {
    return {
      policy: JSON.parse(readFileSync(policyPath, 'utf8')) as ExecutionRoutesFile,
      policyRef: policyPath,
    };
  } catch (error) {
    throw new Error(
      `EXECUTION_ROUTES_FILE_PARSE_FAILED ${policyPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function validateAndNormalizePolicy(raw: ExecutionRoutesFile): ExecutionRoutesFile {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.routes)) {
    throw new Error('EXECUTION_ROUTES_INVALID: expected an object with a `routes` array');
  }

  const normalized: ExecutionRoutesFile = {
    ...(typeof raw.version === 'string' && raw.version.trim()
      ? { version: raw.version.trim() }
      : {}),
    ...(raw.default ? { default: validateRoute(raw.default, 'default') } : {}),
    routes: raw.routes.map((rule, index) => validateRule(rule, index)),
  };

  const seen = new Set<string>();
  normalized.routes.forEach((rule, index) => {
    const key = canonicalJson(rule.match);
    if (seen.has(key)) {
      throw new Error(
        `EXECUTION_ROUTES_AMBIGUOUS: duplicate match at routes[${index}] ${key}`,
      );
    }
    seen.add(key);
  });
  return normalized;
}

function validateRule(rule: RouteRule, index: number): RouteRule {
  if (!rule || typeof rule !== 'object' || !rule.match || typeof rule.match !== 'object') {
    throw new Error(`EXECUTION_ROUTES_INVALID: routes[${index}].match is required`);
  }
  const match: RouteRule['match'] = {};
  for (const field of ['module', 'cell', 'executionProfile'] as const) {
    const value = rule.match[field];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`EXECUTION_ROUTES_INVALID: routes[${index}].match.${field} must be a non-empty string`);
      }
      match[field] = value.trim();
    }
  }
  if (rule.match.role !== undefined) {
    if (rule.match.role !== 'author' && rule.match.role !== 'reviewer') {
      throw new Error(`EXECUTION_ROUTES_INVALID: routes[${index}].match.role must be author|reviewer`);
    }
    match.role = rule.match.role;
  }
  if (Object.keys(match).length === 0) {
    throw new Error(
      `EXECUTION_ROUTES_INVALID: routes[${index}] has an empty match; use top-level default instead`,
    );
  }
  return {
    match,
    route: validateRoute(rule.route, `routes[${index}].route`),
  };
}

function validateRoute(route: RouteRule['route'], location: string): RouteRule['route'] {
  if (!route || typeof route !== 'object' || !route.executor || typeof route.executor !== 'object') {
    throw new Error(`EXECUTION_ROUTES_INVALID: ${location}.executor is required`);
  }
  const kind = route.executor.kind;
  if (kind !== 'claude-cli' && kind !== 'claude-cli-simulator') {
    throw new Error(`EXECUTION_ROUTES_INVALID: ${location}.executor.kind is unsupported`);
  }

  if (kind === 'claude-cli-simulator') {
    if (route.provider !== undefined || route.model !== undefined || route.effort != null) {
      throw new Error(
        `EXECUTION_ROUTES_INVALID: ${location} simulator route must not declare provider/model/effort`,
      );
    }
    return { executor: { kind } };
  }

  if (route.provider !== undefined
      && (typeof route.provider !== 'string' || route.provider.trim() === '')) {
    throw new Error(`EXECUTION_ROUTES_INVALID: ${location}.provider must be a non-empty string`);
  }
  if (route.model !== undefined && (typeof route.model !== 'string' || route.model.trim() === '')) {
    throw new Error(`EXECUTION_ROUTES_INVALID: ${location}.model must be a non-empty string`);
  }
  if (route.effort !== undefined && route.effort !== null
      && (typeof route.effort !== 'string' || route.effort.trim() === '')) {
    throw new Error(`EXECUTION_ROUTES_INVALID: ${location}.effort must be null or a non-empty string`);
  }
  return {
    executor: { kind },
    ...(route.provider ? { provider: route.provider.trim() } : {}),
    ...(route.model ? { model: route.model.trim() } : {}),
    ...(route.effort !== undefined
      ? { effort: typeof route.effort === 'string' ? route.effort.trim() : null }
      : {}),
  };
}

function digestPolicy(policy: ExecutionRoutesFile): string {
  return createHash('sha256')
    .update(canonicalJson(policy))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
