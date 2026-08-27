/**
 * FRF-WP06 define-acceptance-contract cell - the public surface of the
 * acceptance cell package (protocol, WP03 seam, closure validators,
 * report-only reconciliation, skill, template, CheckPlan, reviewer,
 * role binding, gate).
 *
 * INSTALLED since the FRF-WP11 cutover (the cells package is the
 * package. Purity: re-exports pure modules only.
 */

export {
  ACCEPTANCE_CELL_NODE_ID,
  ACCEPTANCE_CELL_PRODUCT_KIND,
  ACCEPTANCE_BUNDLE_SCHEMA_VERSION,
  ACCEPTANCE_CELL_FLOW,
  ACCEPTANCE_CELL_INPUT_CONTRACT,
  ACCEPTANCE_CELL_OUTPUT_CONTRACT,
  EVIDENCE_KINDS,
  DEFERRAL_DISPOSITIONS,
  acceptanceUniverseFrom,
} from './protocol.mjs';

export { WP03_SEAM, WP03_AC_BINDING_KIND, validateAcBinding } from './wp03-seam.mjs';

export {
  REFUSAL_REASONS,
  closureIssue,
  checkRequirementsCoverageClosure,
  checkAcToSourceClosure,
  checkTerminalResultCoverage,
  validateAcceptanceBundle,
} from './closure.mjs';

export {
  RECONCILIATION_REPORT_KIND,
  reconcileWhat,
} from './reconciliation.mjs';

export {
  ACCEPTANCE_SKILL_ID,
  ACCEPTANCE_SKILL_CHECKLIST,
  ACCEPTANCE_SKILL,
  acceptanceSkillDeclaration,
} from './skill.mjs';

export {
  AC_BINDING_TEMPLATE,
  DEFERRAL_TEMPLATE,
  EVIDENCE_BINDING_TEMPLATE,
  ACCEPTANCE_BUNDLE_TEMPLATE,
  TEMPLATE_FORBIDDEN_KEYS,
  renderTemplateGuide,
} from './template.mjs';

export {
  ACCEPTANCE_CHECK_PROVIDER,
  acceptanceProviderDigest,
  acceptanceCheckPlanEvidence,
  ACCEPTANCE_CHECK_PLAN,
} from './check-plan.mjs';

export {
  ACCEPTANCE_REVIEWER_ROUTE,
  ACCEPTANCE_REVIEWER_CHECKLIST,
  reviewerRouteOf,
} from './reviewer.mjs';

export {
  KERNEL_PROTOCOL_ROLE_UNIVERSE,
  ACCEPTANCE_ROLE_BINDINGS,
  roleBindingOf,
} from './desk-roles.mjs';

export {
  GATE_VERDICTS,
  VERDICT_OF_REASON,
  evaluateAcceptanceGate,
} from './gate.mjs';
