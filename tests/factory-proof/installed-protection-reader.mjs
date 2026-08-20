// tests/factory-proof/installed-protection-reader.mjs
//
// W0-2 — the installed-protection reader. Discovers the ACTUAL protection
// surface through production PUBLIC DECLARATIONS (the workshop capability
// manifest: check-providers, post-acceptance effects, transition handlers,
// payload contracts). It never reads the obligation contracts and never
// generates expectations — discovery only.
//
// The manifest is pure data (buildWorkshopCapabilityManifest derives it from
// the declared constants), so reading it in-process is safe and side-effect
// free: nothing here opens a DB read-write or writes factory tables.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = process.cwd();

let manifestModule = null;
async function loadManifestModule() {
  if (!manifestModule) {
    manifestModule = await import(pathToFileURL(path.resolve(
      REPO_ROOT, 'dist/process-modules/application/workshop-capability-manifest.js',
    )).href);
  }
  return manifestModule;
}

/**
 * Read the installed protection set.
 *
 * @param {object} [options]
 * @param {object} [options.manifest] Injected manifest (a COPY for
 *        mutation-acceptance tests). Defaults to the real production
 *        declaration.
 * @returns {Promise<Array<{kind, logicalId, version, implementationDigest}>>}
 */
export async function readInstalledProtections(options = {}) {
  const manifest = options.manifest
    ?? (await loadManifestModule()).buildWorkshopCapabilityManifest();

  const installed = [];
  for (const c of manifest.executableCapabilities ?? []) {
    installed.push({
      kind: c.kind,
      logicalId: c.logicalId,
      version: c.version,
      implementationDigest: c.implementationDigest,
    });
  }
  for (const p of manifest.payloadContracts ?? []) {
    installed.push({
      kind: 'payload-contract',
      logicalId: p.schemaId,
      version: p.version,
      implementationDigest: p.contractDigest,
    });
  }
  return installed;
}

/** The comparison key: kind + logicalId (version compared separately). */
export const protectionKey = p => `${p.kind}::${p.logicalId}`;

/**
 * Assert exact set equality between the compiled normative obligations and
 * the installed protections (brief W0-2 §6):
 *   - obligation without protection → fail (protection was removed silently);
 *   - protection without norm → fail (unclassified installation);
 *   - duplicate/ambiguous owner → fail;
 *   - version divergence → fail (deliberate migration must update both).
 */
export function assertProtectionSetEquality(obligations, installed) {
  const norm = new Map();
  for (const c of obligations) {
    const key = protectionKey(c.expectedProtection);
    if (norm.has(key)) {
      throw new Error(
        `PROTECTION_OWNER_AMBIGUOUS: obligation '${key}' is claimed by both `
        + `'${norm.get(key).obligationId}' and '${c.obligationId}'.`,
      );
    }
    norm.set(key, c);
  }
  const inst = new Map(installed.map(p => [protectionKey(p), p]));

  const missingProtection = [...norm.keys()].filter(k => !inst.has(k));
  if (missingProtection.length > 0) {
    throw new Error(
      `OBLIGATION_WITHOUT_PROTECTION: ${missingProtection.sort().join(', ')} — `
      + `the normative registry names protections that are NOT installed. Either `
      + `the protection was removed silently (production defect) or the contract `
      + `set is ahead of the manifest (classify the installation).`,
    );
  }
  const unclassified = [...inst.keys()].filter(k => !norm.has(k));
  if (unclassified.length > 0) {
    throw new Error(
      `PROTECTION_WITHOUT_OBLIGATION: ${unclassified.sort().join(', ')} — a new `
      + `protection is installed without a normative contract. Adding a check/`
      + `effect/handler/payload-contract requires declaring its obligation in `
      + `the SAME commit (tests/factory-proof/obligation-contracts.mjs).`,
    );
  }
  const versionDivergence = [];
  for (const [key, contract] of norm) {
    const p = inst.get(key);
    if (p.version !== contract.expectedProtection.version) {
      versionDivergence.push(`${key}: norm ${contract.expectedProtection.version} vs installed ${p.version}`);
    }
  }
  if (versionDivergence.length > 0) {
    throw new Error(
      `PROTECTION_VERSION_DIVERGENCE:\n  ${versionDivergence.sort().join('\n  ')}`,
    );
  }
  return { size: norm.size };
}
