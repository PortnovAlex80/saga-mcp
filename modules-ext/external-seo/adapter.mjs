// @ts-check
/**
 * W10-A2 — Real ExternalAdapter implementation for the fetch-ranking node.
 *
 * The W0-A7 fixture declared the adapter as a *reference string* only
 * (`seo-api-adapter@1.0.0`) and shipped no implementation. This file ships the
 * real `ExternalAdapter` the runtime dispatches: it is registered under the
 * versioned id `seo-ranking-adapter@1.0.0` (pinned by the flow node) and
 * resolved through the Wave 1 `ExternalAdapterRegistry`.
 *
 * DETERMINISTIC STUB (no network):
 *   Real SEO providers require an API key, a network call, and rate-limit
 *   handling — none of which belong in an installable package proof. This
 *   adapter is a deterministic in-process implementation that satisfies the
 *   output contract (`ext.external-seo.ranking-snapshot.v1`) from the request
 *   input alone. It proves the adapter SHAPE and the registry wiring without
 *   taking a hard dependency on any external service. A production deployment
 *   would swap this implementation for an HTTP-client-backed adapter registered
 *   under the same versioned id — the manifest, node protocol, and flow do not
 *   change (plan §4.4.7, §7.2).
 *
 * The return shape is the runtime `NodeExecutionResult` (node-executor.ts):
 *   - `runtimeEvent: 'completed'` — physical status the dispatcher reads.
 *   - `production`                — durable typed reference carrying the
 *                                   content-addressed ranking snapshot.
 *   - `outcome`                   — terminal outcome code from the node.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a2.md`.
 *
 * @typedef {import('../../dist/process-modules/application/external-adapter-registry.js').ExternalAdapter} ExternalAdapter
 * @typedef {import('../../dist/process-modules/application/external-adapter-registry.js').ExternalAdapterContext} ExternalAdapterContext
 * @typedef {import('../../dist/process-modules/application/node-executor.js').NodeExecutionResult} NodeExecutionResult
 * @typedef {import('../../dist/process-modules/application/node-executor.js').NodeProduction} NodeProduction
 */

import { sha256Hex } from '../../dist/shared/canonical-json.js';

/**
 * Build a deterministic result URL for a keyword. Stable so the snapshot is
 * reproducible across runs with identical input (a content-addressed package
 * must not introduce non-determinism beyond the fetch timestamp).
 *
 * @param {string} keyword
 * @param {string} searchEngine
 * @returns {string}
 */
function syntheticResultUrl(keyword, searchEngine) {
  // Encode the keyword into the URL so different keywords yield different URLs.
  const slug = encodeURIComponent(keyword.toLowerCase().replace(/\s+/g, '-'));
  return `https://results.${searchEngine}.example/${slug}`;
}

/**
 * Produce the ranking snapshot value from the decoded node input.
 *
 * Pure transformation of the request payload — kept separate from the adapter
 * entry point so the test can exercise it directly without constructing a full
 * NodeExecutionContext.
 *
 * @param {{keywords?: string[]; searchEngine?: string; locale?: string; trackedDomain?: string}} input
 * @returns {{fetchedAt: string; searchEngine: string; locale: string; rankings: any[]}}
 */
export function buildRankingSnapshot(input) {
  const keywords = Array.isArray(input.keywords) ? input.keywords : [];
  const searchEngine = typeof input.searchEngine === 'string' ? input.searchEngine : 'google';
  const locale = typeof input.locale === 'string' ? input.locale : 'us';
  const trackedHost =
    typeof input.trackedDomain === 'string' && input.trackedDomain.length > 0
      ? input.trackedDomain.toLowerCase()
      : null;

  const fetchedAt = new Date().toISOString();

  const rankings = keywords.map((keyword, i) => {
    const url = syntheticResultUrl(keyword, searchEngine);
    /** @type {{keyword:string;position:number;url:string;isTrackedDomain?:boolean}} */
    const entry = {
      keyword,
      // Deterministic position: keywords earlier in the list rank earlier.
      position: i + 1,
      url,
    };
    if (trackedHost) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        entry.isTrackedDomain = host === trackedHost || host.endsWith(`.${trackedHost}`);
      } catch {
        entry.isTrackedDomain = false;
      }
    }
    return entry;
  });

  return { fetchedAt, searchEngine, locale, rankings };
}

/**
 * The deterministic ExternalAdapter for the `fetch-ranking` node.
 *
 * Reads the decoded node input (a `seo-ranking-input.v1` payload) and returns a
 * `NodeExecutionResult` whose `production` carries the content-addressed ranking
 * snapshot. The generic runtime then persists the production envelope; this
 * adapter only owns the provider protocol.
 *
 * @type {ExternalAdapter}
 */
export const seoRankingAdapter = (/** @type {ExternalAdapterContext} */ ctx) => {
  const input = (/** @type {any} */ (ctx.input)) ?? {};
  const snapshot = buildRankingSnapshot(input);

  /** @type {NodeProduction} */
  const production = {
    schema: ctx.node.outputSchema?.id ?? 'ext.external-seo.ranking-snapshot.v1',
    artifactRef: `seo-snapshot:${ctx.node.id}`,
    contentHash: sha256Hex(snapshot),
    bindings: { snapshot },
  };

  /** @type {NodeExecutionResult} */
  const result = {
    runtimeEvent: 'completed',
    production,
    outcome: ctx.node.emitsOutcome ?? 'ranking-fetched',
  };
  return result;
};

export default seoRankingAdapter;
