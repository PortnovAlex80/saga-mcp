/**
 * tools/qualify/lib/series.mjs - the shared scaffolding of every EK-11
 * qualification series (WP-15): kit verification, fresh series roots, per-run
 * evidence capture, the attempt/receipt completeness law (plan EK-11: every
 * ActivityAttempt carries its pinned role-contract digest and an unbroken
 * PromptAssemblyReceipt sequence for every provider request) and the series
 * result manifest writer.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dist = (relative) => import(pathToFileURL(join(REPO_ROOT, 'dist', relative)).href);

import { canonicalJson, sha256Of, seriesEvidenceRoot, sealEvidence, writeEvidence, environmentBlock, freshDir } from './fences.mjs';

/* ------------------------------------------------------------------ */
/* Series context                                                      */
/* ------------------------------------------------------------------ */

export async function openSeries({ kitReference, seriesId, evidenceRootOverride }) {
  const { verifyKit } = await import('../kit.mjs');
  const { kitId, manifest, kitPath } = await verifyKit(kitReference);
  const evidenceRoot = seriesEvidenceRoot(kitId, seriesId, evidenceRootOverride);
  return {
    kitId,
    kit: manifest,
    kitPath,
    seriesId,
    evidenceRoot,
    runEvidence: (runId) => freshDir(join(evidenceRoot, runId), `run evidence dir`),
    async seal(results) {
      const summary = {
        kind: 'ek-qualify.series-result.v1',
        series: seriesId,
        kitId,
        kitPath: kitPath.replaceAll('\\', '/'),
        sourceHead: manifest.source.head,
        distTreeHash: manifest.build.distTreeHash,
        seed: manifest.seed,
        frozenAt: manifest.frozenAt,
        sealedAt: new Date().toISOString(),
        environment: await environmentBlock(),
        results,
        allGreen: results.every((result) => result.status === 'green'),
      };
      writeEvidence(evidenceRoot, 'series-result.json', summary);
      const sealed = sealEvidence(evidenceRoot);
      /* The committed record under docs/.../qualification (small, no raw
         logs) carries the evidence-manifest digest binding. */
      const record = { ...summary, evidenceRoot: evidenceRoot.replaceAll('\\', '/'), evidenceManifestDigest: sealed.treeHash, evidenceFileCount: sealed.fileCount };
      delete record.results;
      record.resultTable = results.map((result) => ({ id: result.id, status: result.status, elapsedMs: result.elapsedMs, checksGreen: result.checksGreen }));
      return { summary, sealed, record };
    },
  };
}

/* ------------------------------------------------------------------ */
/* The attempt/receipt completeness law                                */
/* ------------------------------------------------------------------ */

/**
 * Evaluate the receipt-completeness law over one observed kernel world:
 *  - every WorkIntent (the owner of every ActivityAttempt; the attempt's
 *    activityAttempt.create pins the intent's role contract) carries a
 *    nonempty role-contract digest;
 *  - every attempt reached a serviced state - a completed outcome, a typed
 *    provider refusal, a cancellation, or a CLASSIFIED worker loss (the
 *    loss classification IS the honest terminal of a lost worker; it is
 *    never an unserviced attempt) - and the admitted PromptAssemblyReceipt
 *    count covers the provider-sent attempts;
 *  - the run-terminal law: AT MOST one run terminal proof always, and
 *    EXACTLY one when this project kind terminalizes its run (kinds whose
 *    oracle is an honest early refusal, a pending operator disposition or
 *    a recorded human decision legitimately carry none - the descriptor's
 *    expected world heads declare which world this is).
 * Returns { ok, checks, receipts }.
 */
export function receiptCompleteness(world, { requireRunTerminal = true } = {}) {
  const checks = [];
  const receipts = {
    attempts: [],
    promptAssemblyReceipts: { admitted: [], refused: [] },
    terminalProofs: [],
    effectReceipts: [],
    workIntents: [],
  };
  for (const fact of world.evidence) {
    if (fact.kind === 'PromptAssemblyReceipt:admitted') receipts.promptAssemblyReceipts.admitted.push(fact.ref);
    if (fact.kind === 'PromptAssemblyReceipt:refused') receipts.promptAssemblyReceipts.refused.push(fact.ref);
    if (fact.kind === 'EffectReceipt:success' || fact.kind === 'EffectReceipt:failure' || fact.kind === 'EffectReceipt:uncertain') receipts.effectReceipts.push(fact.ref);
  }
  receipts.terminalProofs = [...new Set((world.proofs ?? []).map((proof) => (typeof proof === 'string' ? proof : proof.id)))].sort();

  const intents = [...(world.workIntents?.values?.() ?? world.workIntents ?? [])];
  /** The pin arrives as { roleContractRef, roleContractDigest } (the
   *  InstalledWorkshopManifest binding); a pinned intent carries a nonempty
   *  roleContractDigest. */
  const isPinned = (roleContract) => typeof roleContract === 'string'
    ? roleContract.length > 0
    : typeof roleContract?.roleContractDigest === 'string' && roleContract.roleContractDigest.length > 0;
  for (const intent of intents) {
    receipts.workIntents.push({
      intentRef: intent.intentRef,
      workplace: intent.workplaceInstanceId,
      role: intent.protocolRole,
      roleContractPinned: isPinned(intent.roleContract),
      roleContractDigest: typeof intent.roleContract === 'object' ? intent.roleContract?.roleContractDigest : intent.roleContract,
    });
  }
  const unpinnedIntents = receipts.workIntents.filter((intent) => !intent.roleContractPinned);
  checks.push({ id: 'attempts-carry-role-contract-pin', ok: unpinnedIntents.length === 0, detail: unpinnedIntents.length === 0 ? `${receipts.workIntents.length} WorkIntent(s) (every ActivityAttempt's owner) carry a pinned role-contract digest` : `WorkIntents without a pinned role contract: ${unpinnedIntents.map((intent) => intent.intentRef).join(', ')}` });

  const headEntries = world.heads instanceof Map ? [...world.heads.entries()] : (world.heads ?? []).map((head) => [head.instanceId, head]);
  const attempts = headEntries.filter(([instanceId]) => instanceId.startsWith('activity-attempt:'));
  for (const [instanceId, head] of attempts) {
    receipts.attempts.push({ attempt: instanceId, status: head.status });
  }
  const SERVICED_ATTEMPT_STATES = ['outcome-recorded', 'provider-refusal-recorded', 'cancelled', 'worker-loss-classified'];
  const unserviced = receipts.attempts.filter((attempt) => !SERVICED_ATTEMPT_STATES.includes(attempt.status));
  checks.push({ id: 'attempts-serviced', ok: unserviced.length === 0, detail: unserviced.length === 0 ? `${receipts.attempts.length} attempt(s) all reached a serviced terminal state (outcome / typed refusal / cancellation / classified worker loss)` : `attempts left unserviced: ${unserviced.map((attempt) => `${attempt.attempt}:${attempt.status}`).join(', ')}` });

  const providerAttempts = receipts.attempts.filter((attempt) => attempt.status === 'outcome-recorded' || attempt.status === 'provider-refusal-recorded');
  checks.push({
    id: 'prompt-assembly-receipt-sequence',
    ok: receipts.promptAssemblyReceipts.admitted.length >= providerAttempts.length,
    detail: `${receipts.promptAssemblyReceipts.admitted.length} admitted PromptAssemblyReceipt(s) over ${providerAttempts.length} provider-sent attempt(s)${receipts.promptAssemblyReceipts.refused.length > 0 ? ` (+${receipts.promptAssemblyReceipts.refused.length} refused)` : ''}`,
  });
  const runTerminals = receipts.terminalProofs.filter((proof) => proof.startsWith('TerminalProof:run.'));
  const terminalLawOk = runTerminals.length <= 1 && (!requireRunTerminal || runTerminals.length === 1);
  checks.push({
    id: requireRunTerminal ? 'exactly-one-run-terminal' : 'no-duplicate-run-terminal',
    ok: terminalLawOk,
    detail: requireRunTerminal
      ? `${runTerminals.length} run terminal proof(s): ${runTerminals.join(', ') || 'none'}`
      : `${runTerminals.length} run terminal proof(s) - this kind's oracle is the honest non-terminal family (a ${runTerminals.length === 0 ? 'refusal/disposition' : 'terminal'} world), duplication is still forbidden`,
  });
  return { ok: checks.every((check) => check.ok), checks, receipts };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export const okCheck = (id, detail) => ({ id, status: 'green', detail });
export const redCheck = (id, detail) => ({ id, status: 'red', detail });

export function traceFingerprint(normalizedTrace) {
  return sha256Of(canonicalJson(normalizedTrace));
}

export function writeSeriesRecord(record, kitsRecordsDir) {
  mkdirSync(kitsRecordsDir, { recursive: true });
  const path = join(kitsRecordsDir, `${record.series.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}
