// src/process-modules/installation/domain/handler-implementation-digest.ts
//
// K3 (Saga Core Renewal) — the ONE canonical handler-implementation digester.
//
// Every runtime workshop manifest pins its HandlerRefs with the sha256 of the
// compiled installation module that registers those handlers (the exact module
// the composition root imports and executes). Before K3 this formula was
// copy-pasted into all four package manifests; drift between the copies would
// silently change package identity semantics. The digest is:
//
//   - content-addressed: sha256 over the file's RAW bytes
//     (same formula as computeResourceDigest — NOT canonical-json sha256Hex);
//   - checkout-independent: a relative specifier resolved from the CALLING
//     manifest's own directory (HERE), so the value does not depend on where
//     the repository is checked out;
//   - timestamp-independent: only bytes are hashed;
//   - fail-closed: a missing implementation file fails module load — a
//     manifest must never load un-provably.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Compute the implementation digest for one workshop package.
 *
 * @param here           Directory of the CALLING manifest module (the manifest
 *                       passes its own `path.dirname(fileURLToPath(import.meta.url))`).
 * @param relImportSpecifier The same relative `.js` specifier the manifest's own
 *                       handler import uses — the digest covers the EXACT module
 *                       the runtime executes.
 * @param moduleLabel    Workshop name for the fail-closed error message.
 */
export function handlerImplementationDigest(
  here: string,
  relImportSpecifier: string,
  moduleLabel: string,
): string {
  const implPath = path.join(here, relImportSpecifier);
  try {
    return createHash('sha256').update(readFileSync(implPath)).digest('hex');
  } catch (e) {
    throw new Error(
      `cannot content-address ${moduleLabel} handler implementation `
      + `'${relImportSpecifier}' (resolved: ${implPath}): ${(e as Error).message}`,
    );
  }
}
