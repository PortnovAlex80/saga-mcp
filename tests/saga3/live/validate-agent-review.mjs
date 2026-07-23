#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadReviewRequest, validateSemanticReview } from './semantic-review.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--bundle' || key === '--review') result[key.slice(2)] = argv[++index];
  }
  return result;
}

const args = parseArgs(process.argv);
if (!args.bundle || !args.review) {
  console.error('Usage: node validate-agent-review.mjs --bundle <stage-bundle> --review <review.json>');
  process.exit(2);
}

const bundleDir = path.resolve(args.bundle);
const reviewPath = path.resolve(args.review);
if (!existsSync(reviewPath)) {
  console.error(`Review file not found: ${reviewPath}`);
  process.exit(2);
}

const request = loadReviewRequest(bundleDir);
const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
const errors = validateSemanticReview(review, request);
if (errors.length > 0) {
  console.error('Semantic review is invalid:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const canonicalPath = path.join(bundleDir, 'semantic-review.json');
if (reviewPath !== canonicalPath) copyFileSync(reviewPath, canonicalPath);
writeFileSync(
  path.join(bundleDir, 'semantic-review.status.json'),
  JSON.stringify({ stage: review.stage, verdict: review.verdict, validatedAt: new Date().toISOString() }, null, 2),
  'utf8',
);
console.log(`SEMANTIC_REVIEW_VALID stage=${review.stage} verdict=${review.verdict}`);
console.log(`CANONICAL_REVIEW=${canonicalPath}`);
process.exit(review.verdict === 'pass' ? 0 : 1);
