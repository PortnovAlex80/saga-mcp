// One-off WP-15 wiring utility (not part of any runtime path): inserts the
// EK-11 qualification alignment block (`ek11: {...}`) into the twenty corpus
// descriptors. Idempotent; run once during wiring.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'project-corpus', 'projects');

/** planId -> [descriptorFile, kind label, fixture ref, evidence profile]. */
export const EK11_MAP = {
  P01: ['p01-served-happy.mjs', 'served-hello-frontend-api', 'repo:simple-server', ['build', 'test', 'api-smoke', 'browser-smoke', 'package-receipt', 'determinism']],
  P02: ['p02-static-product.mjs', 'static-browser-counter', 'repo:static-site', ['build', 'browser-smoke', 'package-receipt', 'determinism']],
  P03: ['p03-served-repair.mjs', 'cli-text-statistics', 'qual:cli-stats', ['build', 'cli-smoke', 'package-receipt', 'determinism']],
  P04: ['p04-batch-pipeline.mjs', 'reusable-validation-library', 'qual:lib-validate', ['build', 'test', 'cli-smoke', 'package-receipt']],
  P05: ['p05-scheduled-independent.mjs', 'todo-crud-web-app', 'qual:served-crud', ['build', 'test', 'api-smoke', 'browser-smoke', 'package-receipt', 'persistence']],
  P06: ['p06-autonomous-ladder.mjs', 'cli-csv-to-json-transformer', 'qual:cli-transform', ['build', 'cli-smoke', 'package-receipt', 'determinism']],
  P07: ['p07-autonomous-worker-loss.mjs', 'webhook-receiver-with-validation', 'qual:webhook-receiver', ['build', 'api-smoke', 'package-receipt', 'persistence']],
  P08: ['p08-cross-module-seams.mjs', 'markdown-doc-site-generator', 'qual:md-site', ['build', 'browser-smoke', 'package-receipt', 'determinism']],
  P09: ['p09-chain-topology.mjs', 'file-backed-notes-http-service', 'qual:served-crud', ['build', 'test', 'api-smoke', 'browser-smoke', 'package-receipt', 'persistence']],
  P10: ['p10-diamond-topology.mjs', 'in-memory-job-queue-simulator', 'qual:job-queue-sim', ['build', 'cli-smoke', 'package-receipt', 'determinism']],
  P11: ['p11-fan-in-topology.mjs', 'read-only-metrics-dashboard', 'qual:metrics-dashboard', ['build', 'api-smoke', 'browser-smoke', 'package-receipt']],
  P12: ['p12-fan-out-topology.mjs', 'json-schema-validator-package', 'qual:lib-validate', ['build', 'test', 'cli-smoke', 'package-receipt']],
  P13: ['p13-independent-topology.mjs', 'sqlite-inventory-application', 'qual:sqlite-inventory', ['build', 'test', 'api-smoke', 'package-receipt', 'persistence']],
  P14: ['p14-honest-refusal.mjs', 'multi-module-event-processor', 'qual:event-processor', ['build', 'test', 'cli-smoke', 'package-receipt', 'determinism']],
  P15: ['p15-failed-predecessor.mjs', 'rest-service-with-operator-frontend', 'qual:served-crud', ['build', 'api-smoke', 'browser-smoke', 'package-receipt']],
  P16: ['p16-human-wait-operator.mjs', 'local-release-packager-idempotent-receipt', 'qual:cli-packager', ['build', 'cli-smoke', 'package-receipt']],
  P17: ['p17-effect-uncertainty.mjs', 'config-linter-machine-readable', 'qual:cli-linter', ['build', 'cli-smoke', 'package-receipt']],
  P18: ['p18-restart-matrix.mjs', 'import-export-with-recovery', 'qual:import-export', ['build', 'api-smoke', 'package-receipt', 'persistence', 'recovery']],
  P19: ['p19-projection-faults.mjs', 'canvas-game-keyboard-browser-smoke', 'qual:canvas-game', ['build', 'test', 'browser-smoke', 'package-receipt']],
  P20: ['p20-idempotent-replay.mjs', 'full-stack-expense-tracker-persistence-tests', 'qual:served-crud', ['build', 'test', 'api-smoke', 'browser-smoke', 'package-receipt', 'persistence']],
};

const isMain = process.argv[1] !== undefined
  && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url);
if (isMain) {
  const known = new Set(readdirSync(PROJECTS));
  for (const [planId, [file, kind, fixture, profile]] of Object.entries(EK11_MAP)) {
    if (!known.has(file)) throw new Error(`descriptor ${file} not found`);
    const path = join(PROJECTS, file);
    let text = readFileSync(path, 'utf8');
    if (text.includes(`ek11: { planId: '${planId}'`)) { console.log(`skip ${file} (already wired)`); continue; }
    const block = `  ek11: { planId: '${planId}', kind: '${kind}', fixture: '${fixture}', profile: ${JSON.stringify(profile)} },`;
    /* Insert immediately before the descriptor's closing `});`. */
    const close = text.lastIndexOf('});');
    if (close === -1) throw new Error(`no closing brace found in ${file}`);
    text = `${text.slice(0, close)}${block}\n${text.slice(close)}`;
    writeFileSync(path, text, 'utf8');
    console.log(`wired ${planId} -> ${file}`);
  }
}
