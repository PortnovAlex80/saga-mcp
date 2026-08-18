#!/usr/bin/env node
/**
 * Harvest a scripted-worker corpus from a captured golden run.
 *
 * Stage 2 of the conveyor-completeness plan needs LLM imitators that cover every
 * lifecycle outcome edge. The expensive part of such a harness is not the
 * plumbing — that already exists (tests/mock-claude/scripted-executor.mjs
 * replaces only the inference spawn seam) — it is the MATERIAL: someone has to
 * author a plausible PRD, SRS, acceptance criteria and implementation for every
 * scripted node. Hand-writing that produces synthetic text that no gate ever
 * accepted.
 *
 * A captured golden run already contains exactly that material, produced by a
 * real model and ACCEPTED by real gates. This script lifts it out into a
 * content-addressed corpus the scripted workers can serve, so imitators replay
 * material that provably passed production QC instead of inventing it.
 *
 * It reads:
 *   - <run>/golden.sqlite               canonical product payloads per node
 *   - <run>/artifacts/requirements/**   the produced requirement documents
 *
 * It writes a deterministic, reviewable tree:
 *   <out>/manifest.json                 index: node -> schema -> product file
 *   <out>/products/<node>.<schema>.<i>.json
 *   <out>/documents/<name>.md
 *
 * Usage:
 *   node tools/harvest-golden-corpus.mjs \
 *     [--run tests/golden-runs/production-run-001-20260812] \
 *     [--out tests/fixtures/golden-corpus/accessible-counter]
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const DEFAULT_RUN = 'tests/golden-runs/production-run-001-20260812';
const DEFAULT_OUT = 'tests/fixtures/golden-corpus/accessible-counter';

function parseArgs(argv) {
  const args = { run: DEFAULT_RUN, out: DEFAULT_OUT };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--run' && argv[i + 1]) { args.run = argv[i + 1]; i += 1; }
    else if (argv[i] === '--out' && argv[i + 1]) { args.out = argv[i + 1]; i += 1; }
  }
  return args;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Safe, stable file-name fragment for a node/schema id. */
const slug = (value) => String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');

/**
 * A live golden database may carry a stale -shm/-wal pair. Copy the main file
 * alone into the repo working dir and open THAT: SQLite then rebuilds its own
 * side files and the harvest never mutates the captured run.
 */
function openGolden(runDir) {
  const source = path.join(runDir, 'golden.sqlite');
  if (!existsSync(source)) throw new Error(`golden.sqlite not found under ${runDir}`);
  const scratch = path.join(process.cwd(), `.harvest-${process.pid}.sqlite`);
  copyFileSync(source, scratch);
  const db = new Database(scratch, { readonly: true });
  return {
    db,
    dispose() {
      db.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try { unlinkSync(scratch + suffix); } catch { /* already gone */ }
      }
    },
  };
}

function harvestProducts(db, outDir) {
  const rows = db.prepare(
    `SELECT node_id, schema_id, product_kind, product_key, payload_snapshot, payload_hash
       FROM factory_process_products
      WHERE payload_snapshot IS NOT NULL AND payload_snapshot <> ''
      ORDER BY node_id, schema_id, id`,
  ).all();

  const productsDir = path.join(outDir, 'products');
  mkdirSync(productsDir, { recursive: true });

  const seen = new Map();
  const entries = [];
  for (const row of rows) {
    const key = `${slug(row.node_id)}.${slug(row.schema_id)}`;
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    const fileName = `${key}.${ordinal}.json`;

    // Re-serialize through JSON so the corpus is reviewable in a diff rather
    // than a single canonical line. The ORIGINAL bytes stay authoritative via
    // sourcePayloadHash, so a reviewer can always prove what was captured.
    let pretty = row.payload_snapshot;
    try { pretty = `${JSON.stringify(JSON.parse(row.payload_snapshot), null, 2)}\n`; }
    catch { /* not JSON — keep the raw snapshot */ }
    writeFileSync(path.join(productsDir, fileName), pretty);

    entries.push({
      nodeId: row.node_id,
      schemaId: row.schema_id,
      productKind: row.product_kind,
      productKey: row.product_key,
      ordinal,
      file: `products/${fileName}`,
      sourcePayloadHash: row.payload_hash ?? sha256(row.payload_snapshot),
      bytes: Buffer.byteLength(row.payload_snapshot),
    });
  }
  return entries;
}

function harvestDocuments(runDir, outDir) {
  const sourceRoot = path.join(runDir, 'artifacts', 'requirements');
  if (!existsSync(sourceRoot)) return [];
  const documentsDir = path.join(outDir, 'documents');
  mkdirSync(documentsDir, { recursive: true });

  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) { walk(abs, `${prefix}${name}/`); continue; }
      if (!name.endsWith('.md')) continue;
      const text = readFileSync(abs, 'utf8');
      const flat = slug(`${prefix}${name}`.replace(/\//g, '_'));
      writeFileSync(path.join(documentsDir, flat), text);
      entries.push({
        source: `artifacts/requirements/${prefix}${name}`,
        file: `documents/${flat}`,
        contentHash: sha256(text),
        lines: text.split('\n').length,
        bytes: Buffer.byteLength(text),
      });
    }
  };
  walk(sourceRoot, '');
  return entries;
}

function harvestArtifactIndex(db) {
  return db.prepare(
    `SELECT type, code, title, path, status
       FROM artifacts
      ORDER BY id`,
  ).all().map(row => ({
    type: row.type,
    code: row.code,
    title: row.title,
    path: row.path,
    status: row.status,
  }));
}

function main() {
  const args = parseArgs(process.argv);
  const runDir = path.resolve(args.run);
  const outDir = path.resolve(args.out);

  const golden = openGolden(runDir);
  try {
    // A rebuild must not leave orphans from a previous harvest.
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const products = harvestProducts(golden.db, outDir);
    const documents = harvestDocuments(runDir, outDir);
    const artifacts = harvestArtifactIndex(golden.db);

    const manifest = {
      schema: 'saga.golden-corpus.v1',
      source: {
        run: path.relative(process.cwd(), runDir).split(path.sep).join('/'),
        harvestedBy: 'tools/harvest-golden-corpus.mjs',
      },
      // Deliberately NOT a timestamp: the corpus must be byte-stable so a
      // re-harvest of the same run produces an empty diff.
      counts: {
        products: products.length,
        documents: documents.length,
        artifacts: artifacts.length,
      },
      products,
      documents,
      artifacts,
    };
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const byNode = new Map();
    for (const product of products) {
      byNode.set(product.nodeId, (byNode.get(product.nodeId) ?? 0) + 1);
    }
    process.stdout.write(
      `harvested ${products.length} products, ${documents.length} documents, `
      + `${artifacts.length} artifact rows\n`
      + `  → ${path.relative(process.cwd(), outDir).split(path.sep).join('/')}\n`
      + [...byNode.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([node, count]) => `    ${node}: ${count}`)
        .join('\n') + '\n',
    );
  } finally {
    golden.dispose();
  }
}

main();
