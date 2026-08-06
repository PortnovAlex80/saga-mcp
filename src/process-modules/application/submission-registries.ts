/**
 * Module-level singleton for the submission validation registries.
 *
 * Mirrors the `getDb()` pattern: the composition root initializes the
 * registries once (via {@link initSubmissionRegistries}), and tool handlers
 * read them via {@link getSubmissionPolicyRegistry} /
 * {@link getSubmissionValidatorRegistry}. Before initialization, both return
 * null — worker_done treats null as "no validation infrastructure wired"
 * and proceeds in legacy mode (the registries are optional for tests that
 * don't exercise submission validation).
 */

import type Database from 'better-sqlite3';
import {
  InMemoryNodeSubmissionPolicyRegistry,
  InMemoryNodeSubmissionValidatorRegistry,
} from './node-submission-policy.js';
import type {
  NodeSubmissionPolicyRegistry,
  NodeSubmissionValidatorRegistry,
} from './node-submission-policy.js';
import { wireSubmissionValidation } from './wire-submission-validation.js';

let policyRegistry: NodeSubmissionPolicyRegistry | null = null;
let validatorRegistry: NodeSubmissionValidatorRegistry | null = null;

export function initSubmissionRegistries(db: Database.Database): void {
  if (policyRegistry && validatorRegistry) return;
  policyRegistry = new InMemoryNodeSubmissionPolicyRegistry();
  validatorRegistry = new InMemoryNodeSubmissionValidatorRegistry();
  wireSubmissionValidation(policyRegistry, validatorRegistry, db);
}

export function getSubmissionPolicyRegistry(): NodeSubmissionPolicyRegistry | null {
  return policyRegistry;
}

export function getSubmissionValidatorRegistry(): NodeSubmissionValidatorRegistry | null {
  return validatorRegistry;
}
