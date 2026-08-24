/**
 * Shared constants still consumed by the live Discovery production-cell flow.
 * Legacy ControlIntent records and persistence ports were retired by ADR-095.
 */
export const DISCOVERY_PROPOSAL_SCHEMA = 'factory.discovery-proposal.v1';

export const DISCOVERY_READINESS_ASSESSMENT_SCHEMA =
  'factory.discovery-readiness-assessment.v2';

export const DISCOVERY_WORK_INTENT_SCHEMA = 'factory.work-intent.discovery.v1';

export const DISCOVERY_INTENT_KIND = 'discovery';

export const DISCOVERY_READINESS_INTENT_KIND = 'discovery.assess';
