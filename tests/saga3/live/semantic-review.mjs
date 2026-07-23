import { readFileSync } from 'node:fs';
import path from 'node:path';

const VERDICTS = new Set(['pass', 'needs_changes', 'fail']);
const STATUSES = new Set(['covered', 'partial', 'missing', 'not_applicable']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

export function validateSemanticReview(review, request) {
  const errors = [];
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    return ['review must be a JSON object'];
  }
  if (review.stage !== request.stage.condition) {
    errors.push(`stage must equal ${request.stage.condition}`);
  }
  if (!VERDICTS.has(review.verdict)) {
    errors.push('verdict must be pass, needs_changes, or fail');
  }
  if (typeof review.summary !== 'string' || review.summary.trim().length < 20) {
    errors.push('summary must contain at least 20 characters');
  }
  if (typeof review.confidence !== 'number' || review.confidence < 0 || review.confidence > 1) {
    errors.push('confidence must be a number from 0 to 1');
  }

  const artifactPaths = new Set(request.artifacts.map((artifact) => artifact.path));
  const inspectedArtifacts = Array.isArray(review.inspectedArtifacts) ? review.inspectedArtifacts : [];
  for (const artifactPath of artifactPaths) {
    if (!inspectedArtifacts.some((item) => item?.path === artifactPath)) {
      errors.push(`artifact was not reviewed: ${artifactPath}`);
    }
  }
  for (const item of inspectedArtifacts) {
    if (!artifactPaths.has(item?.path)) errors.push(`unknown inspected artifact: ${item?.path}`);
    if (typeof item?.assessment !== 'string' || item.assessment.trim().length < 10) {
      errors.push(`artifact assessment is too short: ${item?.path ?? 'unknown'}`);
    }
    if (!Array.isArray(item?.findings)) errors.push(`artifact findings must be an array: ${item?.path ?? 'unknown'}`);
  }

  const requiredLogs = new Set(request.logs.filter(Boolean));
  const inspectedLogs = Array.isArray(review.inspectedLogs) ? review.inspectedLogs : [];
  for (const logPath of requiredLogs) {
    if (!inspectedLogs.some((item) => item?.path === logPath)) {
      errors.push(`log was not reviewed: ${logPath}`);
    }
  }
  for (const item of inspectedLogs) {
    if (!requiredLogs.has(item?.path)) errors.push(`unknown inspected log: ${item?.path}`);
    if (typeof item?.assessment !== 'string' || item.assessment.trim().length < 10) {
      errors.push(`log assessment is too short: ${item?.path ?? 'unknown'}`);
    }
  }

  const coverage = Array.isArray(review.requirementsCoverage) ? review.requirementsCoverage : [];
  for (const check of request.stage.semanticChecks) {
    const item = coverage.find((candidate) => candidate?.requirement === check);
    if (!item) {
      errors.push(`semantic check was not assessed: ${check}`);
      continue;
    }
    if (!STATUSES.has(item.status)) errors.push(`invalid coverage status for: ${check}`);
    if (typeof item.evidence !== 'string' || item.evidence.trim().length < 5) {
      errors.push(`coverage evidence is missing for: ${check}`);
    }
  }

  const defects = Array.isArray(review.defects) ? review.defects : [];
  for (const defect of defects) {
    if (!SEVERITIES.has(defect?.severity)) errors.push('defect severity is invalid');
    if (typeof defect?.description !== 'string' || defect.description.trim().length < 10) {
      errors.push('defect description is too short');
    }
    if (typeof defect?.evidence !== 'string' || defect.evidence.trim().length < 5) {
      errors.push('defect evidence is missing');
    }
  }

  if (review.verdict === 'pass') {
    if (coverage.some((item) => item.status === 'missing')) {
      errors.push('pass verdict is incompatible with missing semantic checks');
    }
    if (defects.some((defect) => defect.severity === 'critical' || defect.severity === 'high')) {
      errors.push('pass verdict is incompatible with critical/high defects');
    }
  }
  return errors;
}

export function loadReviewRequest(bundleDir) {
  const requestPath = path.join(bundleDir, 'semantic-review-request.json');
  return JSON.parse(readFileSync(requestPath, 'utf8'));
}
