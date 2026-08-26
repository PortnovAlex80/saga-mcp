/**
 * cli-linter/src/lint.mjs - the configuration linter with machine-readable
 * output (plan EK-11 P17): checks a JSON config against declared rules and
 * emits ONE JSON verdict document on stdout; the exit code carries the
 * verdict (0 clean, 1 violations, 2 usage/parse errors).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The linter rule table (the product's own contract). */
export const RULES = [
  { id: 'required-keys', check: (config) => {
    const required = ['name', 'version'];
    const missing = required.filter((key) => config[key] === undefined);
    return missing.map((key) => ({ rule: 'required-keys', path: `$.${key}`, message: `required key "${key}" is absent` }));
  } },
  { id: 'name-shape', check: (config) => {
    if (config.name !== undefined && !/^[a-z][a-z0-9-]*$/.test(String(config.name))) {
      return [{ rule: 'name-shape', path: '$.name', message: 'name must match /^[a-z][a-z0-9-]*$/' }];
    }
    return [];
  } },
  { id: 'version-semver', check: (config) => {
    if (config.version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(config.version))) {
      return [{ rule: 'version-semver', path: '$.version', message: 'version must be semver x.y.z' }];
    }
    return [];
  } },
  { id: 'unknown-keys', check: (config) => {
    const allowed = new Set(['name', 'version', 'settings']);
    return Object.keys(config).filter((key) => !allowed.has(key))
      .map((key) => ({ rule: 'unknown-keys', path: `$.${key}`, message: `key "${key}" is not in the closed config vocabulary` }));
  } },
  { id: 'settings-shape', check: (config) => {
    if (config.settings === undefined) return [];
    if (typeof config.settings !== 'object' || config.settings === null || Array.isArray(config.settings)) {
      return [{ rule: 'settings-shape', path: '$.settings', message: 'settings must be an object' }];
    }
    return Object.entries(config.settings)
      .filter(([, value]) => !['string', 'number', 'boolean'].includes(typeof value))
      .map(([key]) => ({ rule: 'settings-shape', path: `$.settings.${key}`, message: 'setting values must be scalar' }));
  } },
];

/** Lint one parsed config; returns the machine-readable verdict document. */
export function lintConfig(config) {
  const violations = RULES.flatMap((rule) => rule.check(config));
  return {
    kind: 'cli-linter.verdict.v1',
    verdict: violations.length === 0 ? 'clean' : 'violations',
    violationCount: violations.length,
    violations,
  };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = process.argv[2];
  if (input === undefined) {
    process.stderr.write('usage: lint.mjs <config.json>\n');
    process.exit(2);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(input, 'utf8'));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ kind: 'cli-linter.verdict.v1', verdict: 'unparseable', violationCount: 1, violations: [{ rule: 'parse', path: '$', message: String(error?.message ?? error) }] })}\n`);
    process.exit(2);
  }
  const verdict = lintConfig(config);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exit(verdict.verdict === 'clean' ? 0 : 1);
}
