/**
 * workflow-kernel/roles/fixtures/certifier-operator.ts - the synthetic D4
 * certifier operator contract fixture (WP-17).
 *
 * Frozen decision D4: the terminal-claim verifier is the LifecycleRun-owned
 * command lifecycleRun.verifyTerminalClaims; the verifier is NOT an
 * author/reviewer kernel role and is NOT bound through a Workplace protocol
 * role. The certifier semantic profile therefore has NO CanonicalRoleContract
 * (every schema-valid Workplace manifest row binds planner/implementer/
 * reviewer only, and compileRoleContract cross-checks the referenced
 * SemanticProfileArtifact against the row). Its contract is THIS pinned
 * CertifierOperatorContract, resolved by its owning obligation
 * (obligation:verifyTerminalClaims), not by workplace.admitWorkIntent.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import { certifierOperatorBinding } from '../compiler.js';
import type { CompileCertifierOperatorInput } from '../compiler.js';
import { syntheticProductContractRef } from './support.js';

export const certifierOperatorLaunchKind = 'lifecycle.certification.certifier';

/** Builds the operator compile input: the D4 manifest row + content. */
export function buildCertifierOperatorFixture(): CompileCertifierOperatorInput {
  const binding = certifierOperatorBinding();
  if (binding === undefined) {
    throw new Error('certifier operator fixture: the installed manifest has no lifecycleOperator row');
  }

  const executableVerifierRefs = [
    `sha256:${sha256OfCanonical({ synthetic: 'terminal-claim-verifier.v0' })}`,
  ];
  const inputProductContracts = [
    syntheticProductContractRef('terminal-lifecycle-claim-contract.v0'),
    syntheticProductContractRef('construction-surface-contract.v0'),
  ];
  const outputProductContracts = [
    syntheticProductContractRef('executable-verifier-result-contract.v0'),
  ];

  return {
    binding,
    content: {
      schemaVersion: 'ek.certifier-operator-contract.ek1.v1',
      ownedCommand: 'lifecycleRun.verifyTerminalClaims',
      ownerAggregate: 'LifecycleRun',
      executableVerifierRefs,
      inputProductContracts,
      outputProductContracts,
      evidenceObligations: ['obligation:verifyTerminalClaims'],
    },
  };
}
