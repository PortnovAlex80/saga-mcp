/**
 * workflow-kernel/workshops/formalization/contracts/identity.ts - the
 * pinned identity table of the FRF-WP03 semantic contracts at their
 * FRF-WP11 canonical home (src/workflow-kernel/workshops/formalization/
 * contracts/).
 *
 * FRF-WP11 CUTOVER LAW (plan FRF-WP11; the seams' documented flip):
 *   - The canonical home of the WP03 validators/schemas is THIS package;
 *     the docs-tree copies
 *     (docs/refactoring/formalization-frf/contracts/**) are FROZEN
 *     SNAPSHOTS that must stay byte-equal (the FRF removal guard asserts
 *     equality per file; a drifted snapshot is a red build).
 *   - Each seam pins its validator by sha256 over the validator FILE
 *     BYTES (the same basis the test-time wiring used over the docs
 *     tree; the bytes are identical). The pins below are CONSTANTS -
 *     they never recompute at runtime (no filesystem read exists in this
 *     package) - and the blocking guard re-hashes BOTH trees against
 *     them, so a silent edit of either copy is a red build.
 *
 * PURITY: pure constants only. No I/O, no clock, no session.
 */

/** sha256 over the validator file bytes, per contract (the seam pins). */
export const FORMALIZATION_CONTRACT_DIGESTS = Object.freeze({
  'ac-binding': '74bbe6c257b878d6fd2f295925b62298c789327fb108f409d3851a3669f9a412',
  common: '79ccf65795d4e83f3d3bb7cd5eba4fa5a43176d886d99a3fef03addb13acc236',
  'prd-intent-member': 'a5e36483f1965c411040d6a4e9c3d4f2779d2dc8ec645f8508c13983ef44d145',
  'requirements-bundle': 'cd1cdc02243852857a617bfb0e309f9c27f2243d642e564a883e1384ff99f2a9',
  'uc-scenario-member': '835d6bfe4b86f1c7d79c8ad533a5b335113b04dc46a55666459cce03c7a4b159',
  'what-baseline': '6af7dfaa4e3a85300cb246ec5ee076f6fa2ac5907be72fc8d1430a62ac51b732',
} as const);

export type FormalizationContractName = keyof typeof FORMALIZATION_CONTRACT_DIGESTS;

/** The contract kinds the frozen WP03 schema set declares (closed list). */
export const FORMALIZATION_CONTRACT_KINDS = Object.freeze({
  prdIntentMember: 'frf-contracts.prd-intent-member.v1',
  ucScenarioMember: 'frf-contracts.uc-scenario-member.v1',
  requirementsBundle: 'frf-contracts.requirements-bundle.v1',
  acBinding: 'frf-contracts.ac-binding.v1',
  whatBaseline: 'frf-contracts.what-baseline.v1',
} as const);

/** The pinned digest of one contract (fail-closed on an unknown name). */
export function contractDigestOf(name: FormalizationContractName): string {
  const digest = FORMALIZATION_CONTRACT_DIGESTS[name];
  if (digest === undefined) {
    throw new Error(`FORMALIZATION_CONTRACTS: no pinned digest for ${String(name)} (the identity table is closed)`);
  }
  return digest;
}
