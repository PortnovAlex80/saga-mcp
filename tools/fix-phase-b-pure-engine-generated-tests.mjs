#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'tests/architecture/saga2-boundaries.test.mjs';
let source = readFileSync(file, 'utf8');
const needle = `    '{"type":"api_retry","error_status":429,"error":"rate_limit"}
',`;
const replacement = `    JSON.stringify({ type: 'api_retry', error_status: 429, error: 'rate_limit' }) + '\\n',`;
if (!source.includes(needle)) throw new Error('generated JSONL fixture anchor missing');
source = source.replace(needle, replacement);
writeFileSync(file, source, 'utf8');
