/**
 * Wire the mandatory node submission validation registries.
 *
 * Called once at composition time. Registers:
 *   - the formalization acceptance-contract validator (the priority shift-left
 *     gate that closes the AC repair-loop root cause)
 *   - policy declarations for every LM-node across all modules
 *
 * Formalization nodes use domain validators. Discovery and Development
 * publish typed Production Cell products that are checked by their cell gate
 * and deterministic settlement.
 */

import type Database from 'better-sqlite3';
import type {
  NodeSubmissionPolicyRegistry,
  NodeSubmissionValidatorRegistry,
} from './node-submission-policy.js';
import { createAcceptanceContractValidator } from '../../modules/formalization/application/acceptance-contract-validator.js';
import { createSrsContractValidator } from '../../modules/formalization/application/srs-contract-validator.js';
import { createFormalizationContractValidator } from '../../modules/formalization/application/formalization-contract-validator.js';
import { SRS_CONTRACT_REF } from '../../modules/formalization/domain/srs-contract.js';
import {
  DISCOVERY_PROCESS_MODULE_REF,
  DOCUMENTATION_PROCESS_MODULE_REF,
} from '../lifecycles/product-delivery-module-contracts.js';

const FORMALIZATION_MODULE_REF = 'solution-formalization@1.0.0';
// ADR-095 Phase-6 repair (2026-08-24; independently found by the snapshot
// corpus port with the counterexample "every fresh Factory start failed its
// first discovery worker_done with SUBMISSION_VALIDATION_POLICY_MISSING:
// product-discovery@4.0.0/produce-proposal"): the Phase-4 atomic module bump
// (3.0.2 -> 4.0.0) left this wiring keyed at the legacy identity. The live
// key is now DERIVED from the canonical contracts constant so the next bump
// cannot leave this file stale again (verified to keep the dependency
// direction clean — dependency-direction 4/4 with zero new allowlist
// entries). The legacy 3.0.2 key stays: a nonterminal run pinned to the
// retired six-handler installation rehydrates that exact package (ADR-034 /
// ADR-095 retained-old-installations), and its worker_done boundary resolves
// policies under the pinned module identity — the same multi-version
// enumeration DEVELOPMENT_MODULE_REFS uses.
const DISCOVERY_MODULE_REFS = [
  'product-discovery@3.0.2',
  `${DISCOVERY_PROCESS_MODULE_REF.name}@${DISCOVERY_PROCESS_MODULE_REF.version}`,
] as const;
const DEVELOPMENT_MODULE_REFS = [
  'solution-development@1.1.0',
  'solution-development@1.2.0',
  'solution-development@1.4.0',
  'solution-development@1.4.1',
  'solution-development@1.4.2',
  'solution-development@1.4.3',
  'solution-development@1.4.4',
] as const;
const DEVELOPMENT_CONTINUATION_MODULE_REF = 'solution-development-managed@1.1.0';
const DEVELOPMENT_VERIFICATION_CONTINUATION_MODULE_REF =
  'solution-development-verification-continuation@1.0.0';

export function wireSubmissionValidation(
  policyRegistry: NodeSubmissionPolicyRegistry,
  validatorRegistry: NodeSubmissionValidatorRegistry,
  db: Database.Database,
): void {
  // --- Validators ---
  // AC: dedicated validator (structured gaps for AC-specific edges).
  validatorRegistry.register(createAcceptanceContractValidator(db));
  // SRS: dedicated validator (checks §12 section + criticality validity).
  validatorRegistry.register(createSrsContractValidator(db));
  // Product, UC, Reconciliation: generic formalization contract validator.
  // The product node additionally enforces the AC-drift reaction gate
  // (constraint-register dispositions in the brief metadata).
  validatorRegistry.register(createFormalizationContractValidator(
    db, 'formalization.product-contract.v1', 'define-product-contract',
    { product: true, constraintDispositions: true },
  ));
  validatorRegistry.register(createFormalizationContractValidator(
    db, 'formalization.use-cases.v1', 'model-use-cases',
    { product: true, useCases: true },
  ));
  validatorRegistry.register(createFormalizationContractValidator(
    db, 'formalization.reconciliation.v1', 'reconcile-what',
    { product: true, useCases: true, acceptance: true, coverage: true },
  ));

  // --- Formalization policies ---
  // ALL five formalization LM-nodes now have required validators. The SRS
  // node additionally pins its contract version — the validator compares the
  // pinned ref against its own canonical SRS_CONTRACT_REF and rejects with
  // SRS_CONTRACT_VERSION_MISMATCH if they differ. This detects the case where
  // the author produced an SRS under one contract version and the validator
  // is checking under another.
  const formalizationPolicies: Array<[string, string]> = [
    ['define-product-contract', 'formalization.product-contract.v1'],
    ['model-use-cases', 'formalization.use-cases.v1'],
    ['define-acceptance-contract', 'formalization.acceptance-contract.v1'],
    ['reconcile-what', 'formalization.reconciliation.v1'],
  ];
  for (const [nodeId, validatorId] of formalizationPolicies) {
    policyRegistry.register(FORMALIZATION_MODULE_REF, nodeId, {
      mode: 'required',
      validatorId,
      requireManagedProduction: nodeId !== 'reconcile-what',
    });
  }
  // SRS policy: version-pinned.
  policyRegistry.register(FORMALIZATION_MODULE_REF, 'define-architecture-contract', {
    mode: 'required',
    validatorId: 'formalization.srs-contract.v1',
    contractRef: SRS_CONTRACT_REF,
    requireManagedProduction: true,
  });

  // --- Discovery policies ---
  for (const nodeId of ['produce-proposal', 'assess-readiness']) {
    for (const moduleRef of DISCOVERY_MODULE_REFS) {
      policyRegistry.register(
        moduleRef,
        nodeId,
        {
          mode: 'none',
          rationale: 'typed Production Cell product; validated by cell gate and Discovery settlement',
        },
      );
    }
  }

  // Development workers publish typed JSON products. Their schema/cardinality
  // is checked by the Production Cell gate and their domain lineage is checked
  // again by deterministic settlement, so the artifact-graph validator is not
  // applicable to these nodes.
  for (const nodeId of [
    'plan-task-graph',
    'implement-work-items',
    'certify-product-readiness',
    'verify-acceptance',
  ]) {
    for (const moduleRef of DEVELOPMENT_MODULE_REFS) {
      policyRegistry.register(moduleRef, nodeId, {
        mode: 'none',
        rationale: 'typed Production Cell product; validated by cell gate and Development settlement',
      });
    }
  }
  for (const nodeId of ['implement-work-items', 'verify-acceptance']) {
    policyRegistry.register(DEVELOPMENT_CONTINUATION_MODULE_REF, nodeId, {
      mode: 'none',
      rationale: 'managed textual Product Cell product; validated by Factory materialization, cell gates and Development settlement',
    });
  }
  policyRegistry.register(DEVELOPMENT_VERIFICATION_CONTINUATION_MODULE_REF, 'verify-acceptance', {
    mode: 'none',
    rationale: 'provider-led evidence over an immutable adopted candidate; validated by current cell gates and deterministic settlement',
  });

  // Documentation workers publish typed JSON products (structured document +
  // review verdict). Their shape is pinned by the payload contracts installed
  // in EVERY process, their completeness/sections by the deterministic author
  // gate, and their workset lineage by Documentation settlement — the
  // artifact-graph validator is not applicable to these nodes. Keyed at the
  // canonical contracts constant (same ADR-095 Phase-6 repair rule as
  // Discovery: derive the live key, never hand-pin a literal).
  policyRegistry.register(
    `${DOCUMENTATION_PROCESS_MODULE_REF.name}@${DOCUMENTATION_PROCESS_MODULE_REF.version}`,
    'author-documents',
    {
      mode: 'none',
      rationale: 'typed Production Cell products (documentation document + review verdict); validated by cell payload contracts, author/final gates and Documentation settlement',
    },
  );
}
