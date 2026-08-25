/**
 * workflow-kernel/roles/fixtures/index.ts - the WP-17 synthetic fixture
 * corpus: one valid contract per semantic profile (planner, implementer,
 * reviewer as CanonicalRoleContracts; certifier as the D4 operator contract
 * because the certifier has no CanonicalRoleContract) plus one INVALID
 * contract (arbitrary field) for negative testing.
 */

export {
  buildPlannerFixture,
  plannerLaunchKind,
} from './planner.js';
export {
  buildImplementerFixture,
  implementerLaunchKind,
} from './implementer.js';
export {
  buildReviewerFixture,
  reviewerLaunchKind,
} from './reviewer.js';
export {
  buildCertifierOperatorFixture,
  certifierOperatorLaunchKind,
} from './certifier-operator.js';
export {
  buildInvalidArbitraryFieldFixture,
} from './invalid-arbitrary-field.js';
export type {
  InvalidArbitraryFieldContent,
  InvalidArbitraryFieldInput,
} from './invalid-arbitrary-field.js';
