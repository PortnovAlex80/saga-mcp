/**
 * ExecutionRouteResolver — decides WHICH backend (executor + provider + model)
 * runs ONE worker spawn, by matching the (module, cell, role, executionProfile)
 * key against a routing policy.
 *
 * Resolution is ONCE-AT-CLAIM: the resolver runs inside the claim transaction
 * (findNextClaimable → readRouteForClaim → ExecutionRouteResolver.resolve),
 * and the resulting `WorkerExecutionRoute` is frozen into the
 * `ExecutionContextSnapshot` (v2) so spawn, gateway and provenance all read the
 * same immutable value. Config is NEVER re-read at spawn time — that was the
 * defect that made the journal unable to explain why a WorkIntent ran on a
 * given backend after a config edit.
 *
 * Matching precedence (most specific first):
 *   1. executionProfile        (e.g. `define-architecture-contract.author`)
 *   2. module + cell + role    (e.g. formalization / SRS / reviewer)
 *   3. module + role
 *   4. module
 *   5. factory default
 *
 * If no rule matches, {@link DEFAULT_ROUTE} is returned (real claude-cli, z.ai).
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

/**
 * One routing rule. `match` is a partial {@link RouteMatchKey}: a rule matches
 * a key when every present match field equals the key's field (null/absent
 * match fields are wildcards). `route` is the resolved backend; it may omit
 * provider/model when the executor is not model-backed (the simulator).
 */
export interface RouteRule {
  match: {
    module?: string;
    cell?: string;
    role?: 'author' | 'reviewer';
    executionProfile?: string;
  };
  route: {
    executor: { kind: ExecutorKind };
    provider?: string;
    model?: string;
    effort?: string | null;
  };
}

/** The on-disk policy file shape (factory-execution-routes.json). */
export interface ExecutionRoutesFile {
  /** Optional digest anchor; the resolver recomputes the digest anyway. */
  version?: string;
  /** Default route applied when no rule matches. */
  default?: RouteRule['route'];
  /** Ordered rules; first match wins. */
  routes: RouteRule[];
}

export interface ExecutionRouteResolverOptions {
  /** Parsed policy; when omitted, the resolver loads from `policyPath`. */
  policy?: ExecutionRoutesFile;
  /** Absolute path to factory-execution-routes.json. */
  policyPath?: string;
  /** Env override (SAGA_EXECUTION_ROUTES_JSON) — parsed inline policy. */
  envPolicyJson?: string;
}

/**
 * Build the resolver. Reads the policy ONCE at construction; subsequent
 * `resolve()` calls never touch the filesystem. This is the contract that makes
 * "config edited at 10:03 does not affect a 10:00 reservation" hold: the
 * resolver used for a given factory run is immutable.
 */
export function createExecutionRouteResolver(
  options: ExecutionRouteResolverOptions = {},
): {
  resolve: (key: RouteMatchKey) => WorkerExecutionRoute;
  policyRef: string;
  policyDigest: string;
} {
  const { policy, policyRef, policyDigest } = loadPolicy(options);

  function matchRule(rule: RouteRule, key: RouteMatchKey): boolean {
    const m = rule.match;
    if (m.module !== undefined && m.module !== key.module) return false;
    if (m.cell !== undefined && m.cell !== key.cell) return false;
    if (m.role !== undefined && m.role !== key.role) return false;
    if (m.executionProfile !== undefined && m.executionProfile !== key.executionProfile) return false;
    return true;
  }

  function toRoute(ruleRoute: RouteRule['route']): WorkerExecutionRoute {
    const isSimulator = ruleRoute.executor.kind === 'claude-cli-simulator';
    return {
      executor: { kind: ruleRoute.executor.kind },
      provider: isSimulator || !ruleRoute.provider
        ? null
        : { id: ruleRoute.provider },
      model: isSimulator || !ruleRoute.model ? null : { id: ruleRoute.model },
      inference: { effort: ruleRoute.effort ?? null },
      policyRef: policyRef ?? null,
      policyDigest,
    };
  }

  function resolve(key: RouteMatchKey): WorkerExecutionRoute {
    // Most-specific-first. We sort rules by descending specificity (count of
    // non-wildcard match fields) so the policy author does not need to worry
    // about ordering for correctness, only for tie-breaking among equally
    // specific rules (first wins).
    const ranked = [...policy.routes]
      .map(rule => ({ rule, score: specificity(rule) }))
      .sort((a, b) => b.score - a.score);
    for (const { rule } of ranked) {
      if (matchRule(rule, key)) return toRoute(rule.route);
    }
    if (policy.default) return toRoute(policy.default);
    // Return the immutable default with the same policy citation.
    return {
      ...DEFAULT_ROUTE,
      policyRef: policyRef ?? null,
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
  policyDigest: string;
} {
  if (options.policy) {
    const ref = options.policyPath ?? '<inline>';
    return {
      policy: options.policy,
      policyRef: ref,
      policyDigest: digestPolicy(options.policy),
    };
  }
  const envJson = options.envPolicyJson ?? process.env.SAGA_EXECUTION_ROUTES_JSON;
  if (envJson && envJson.trim()) {
    try {
      const parsed = JSON.parse(envJson) as ExecutionRoutesFile;
      return {
        policy: normalizePolicy(parsed),
        policyRef: '<env:SAGA_EXECUTION_ROUTES_JSON>',
        policyDigest: digestPolicy(parsed),
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
    // No policy file and no env: every route resolves to the default. This is
    // the safe behavior for production runs that target a single backend.
    return {
      policy: { routes: [] },
      policyRef: policyPath,
      policyDigest: digestPolicy({ routes: [] }),
    };
  }
  let parsed: ExecutionRoutesFile;
  try {
    parsed = JSON.parse(readFileSync(policyPath, 'utf8')) as ExecutionRoutesFile;
  } catch (error) {
    throw new Error(
      `EXECUTION_ROUTES_FILE_PARSE_FAILED ${policyPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    policy: normalizePolicy(parsed),
    policyRef: policyPath,
    policyDigest: digestPolicy(parsed),
  };
}

function normalizePolicy(parsed: ExecutionRoutesFile): ExecutionRoutesFile {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.routes)) {
    throw new Error('EXECUTION_ROUTES_INVALID: expected an object with a `routes` array');
  }
  return { ...parsed, routes: parsed.routes };
}

function digestPolicy(policy: ExecutionRoutesFile): string {
  // Canonical JSON over the policy so the digest is stable regardless of key
  // ordering or whitespace. Sorted keys, recursively.
  return createHash('sha256')
    .update(canonicalJson(policy))
    .digest('hex')
    .slice(0, 16);
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
