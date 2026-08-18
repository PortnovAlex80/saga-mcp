/**
 * Golden-corpus loader for scripted workers.
 *
 * A scripted worker replaces model COGNITION, not the material a real run
 * produced. Inlining invented prose into an imitator makes the harness assert
 * against text no gate ever accepted; the corpus instead serves material that
 * was produced by a real model and ACCEPTED by real gates in a captured run
 * (see tools/harvest-golden-corpus.mjs).
 *
 * The loader is deliberately FAIL-CLOSED: asking for material that was never
 * harvested throws, listing what exists for that node. A scripted worker must
 * never silently fall back to invented text — that is exactly how a harness
 * starts proving something the factory never does.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(__dirname, '..', 'fixtures', 'golden-corpus');

const cache = new Map();

/**
 * Load one harvested corpus by name (default: the accessible-counter run).
 *
 * @param {string} name corpus directory under tests/fixtures/golden-corpus
 */
export function loadCorpus(name = 'accessible-counter') {
  const cached = cache.get(name);
  if (cached) return cached;

  const root = path.join(CORPUS_ROOT, name);
  const manifestPath = path.join(root, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `GOLDEN_CORPUS_MISSING: ${manifestPath} — run "node tools/harvest-golden-corpus.mjs" first`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const readRelative = (relative) => readFileSync(path.join(root, relative), 'utf8');

  const describeNode = (nodeId) => {
    const available = manifest.products
      .filter(product => product.nodeId === nodeId)
      .map(product => product.schemaId);
    return available.length
      ? `available for node '${nodeId}': ${[...new Set(available)].join(', ')}`
      : `node '${nodeId}' has no harvested products`;
  };

  const corpus = {
    name,
    root,
    manifest,

    /** Every harvested product descriptor for one flow node, in capture order. */
    productsForNode(nodeId) {
      return manifest.products.filter(product => product.nodeId === nodeId);
    },

    /**
     * The parsed payload a node produced for one schema.
     *
     * @param {string} nodeId flow node id (null for kernel-produced material)
     * @param {string} schemaId exact product schema
     * @param {number} ordinal 1-based, when a node produced several
     */
    product(nodeId, schemaId, ordinal = 1) {
      const found = manifest.products.find(product =>
        product.nodeId === nodeId
        && product.schemaId === schemaId
        && product.ordinal === ordinal);
      if (!found) {
        throw new Error(
          `GOLDEN_CORPUS_PRODUCT_ABSENT: node='${nodeId}' schema='${schemaId}' `
          + `ordinal=${ordinal}; ${describeNode(nodeId)}`,
        );
      }
      return JSON.parse(readRelative(found.file));
    },

    /** All payloads a node produced for one schema, in capture order. */
    products(nodeId, schemaId) {
      return manifest.products
        .filter(product => product.nodeId === nodeId && product.schemaId === schemaId)
        .map(product => JSON.parse(readRelative(product.file)));
    },

    /**
     * A harvested requirement document by its source name
     * (e.g. '01-PRD.md' or 'REQ-001-accessible-counter/01-PRD.md').
     */
    document(nameOrSuffix) {
      const found = manifest.documents.find(doc =>
        doc.source === nameOrSuffix
        || doc.source.endsWith(`/${nameOrSuffix}`)
        || doc.file.endsWith(`_${nameOrSuffix}`)
        || doc.file.endsWith(nameOrSuffix));
      if (!found) {
        throw new Error(
          `GOLDEN_CORPUS_DOCUMENT_ABSENT: '${nameOrSuffix}'; available: `
          + manifest.documents.map(doc => doc.source).join(', '),
        );
      }
      return readRelative(found.file);
    },

    /** Artifact index rows (type/code/title/path/status) as captured. */
    artifacts(type = null) {
      return type === null
        ? manifest.artifacts
        : manifest.artifacts.filter(artifact => artifact.type === type);
    },

    /** Flow nodes that produced at least one harvested product. */
    nodes() {
      return [...new Set(manifest.products.map(product => product.nodeId))]
        .filter(nodeId => nodeId !== null)
        .sort();
    },
  };

  cache.set(name, corpus);
  return corpus;
}
