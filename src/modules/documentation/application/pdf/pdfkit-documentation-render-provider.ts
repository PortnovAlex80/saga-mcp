/**
 * Documentation workshop — PdfKit render provider.
 *
 * pdfkit and the Cyrillic-capable font are OPTIONAL runtime dependencies:
 * both are imported lazily so an engine without them never crashes the
 * factory — the provider probes availability and the renderer kernel turns
 * an unavailable probe into an honest typed `blocked` outcome.
 *
 * `pdfkit` is declared in package.json; `dejavu-fonts-ttf` supplies fonts
 * (Bitstream Vera / public domain style licence permits redistribution).
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type {
  DocumentationRenderProvider,
  RenderDocumentInput,
  RenderDocumentResult,
} from '../../domain/documentation-kernel-ports.js';
import type {
  DocumentationBlock,
  DocumentationDocument,
} from '../../domain/documentation-schemas.js';

const RENDER_PROVIDER_ID = 'factory.documentation.render.pdfkit';
// 1.0.1 (2026-08-24): probe() now gates on engine AND fonts (the happy-spine
// fix — see probe()). Receipts stamped by earlier versions carry 1.0.0.
const RENDER_PROVIDER_VERSION = '1.0.1';

// Minimal structural type for the lazily imported pdfkit module. Declaring it
// here (plus src/types/pdfkit.d.ts) keeps tsc green even before `npm install`
// materializes the optional engine.
interface PdfKitDocument {
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  font(src: string, size?: number): this;
  fontSize(size: number): this;
  fill(color: string): this;
  moveDown(lines?: number): this;
  text(value: string, options?: {
    width?: number;
    align?: 'left' | 'center' | 'right' | 'justify';
    continued?: boolean;
    lineGap?: number;
    indent?: number;
  }): this;
  text(value: string, x?: number, y?: number, options?: {
    width?: number;
    align?: 'left' | 'center' | 'right' | 'justify';
    lineGap?: number;
    indent?: number;
  }): this;
  end(): void;
}
type PdfKitConstructor = new (options: {
  size: 'A4';
  margins: { top: number; bottom: number; left: number; right: number };
  info?: Record<string, unknown>;
}) => PdfKitDocument;

const requireCjs = createRequire(import.meta.url);

/** Synchronous engine resolution — the probe gate must see the SAME module
 *  identity the lazy render import will load, never a guess. */
function resolvePdfKitEngine(): PdfKitConstructor | null {
  try {
    const resolved = requireCjs.resolve('pdfkit');
    const mod = requireCjs(resolved) as { default?: unknown } & Record<string, unknown>;
    const ctor = (mod.default ?? mod) as PdfKitConstructor;
    return typeof ctor === 'function' ? ctor : null;
  } catch {
    return null;
  }
}

function resolveFontPaths(): { regular: string; bold: string } | null {
  const envFont = process.env.SAGA_DOCS_FONT;
  const candidates = envFont
    ? [{ regular: envFont, bold: envFont }]
    : [{
      regular: 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf',
      bold: 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf',
    }, {
      regular: 'dejavu-fonts-ttf/ttf/DejaVuSerif.ttf',
      bold: 'dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf',
    }];
  for (const candidate of candidates) {
    try {
      const regular = requireCjs.resolve(candidate.regular);
      const bold = requireCjs.resolve(candidate.bold);
      if (existsSync(regular) && existsSync(bold)) {
        return { regular, bold };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function loadPdfKit(): Promise<PdfKitConstructor | null> {
  try {
    const mod = await import('pdfkit') as { default?: unknown } & Record<string, unknown>;
    const ctor = (mod.default ?? mod) as PdfKitConstructor;
    return typeof ctor === 'function' ? ctor : null;
  } catch {
    return null;
  }
}

interface RenderEngine {
  PdfDocument: PdfKitConstructor;
  fonts: { regular: string; bold: string };
}

let cachedEngine: RenderEngine | { error: string } | null = null;

async function resolveEngine(): Promise<RenderEngine | { error: string }> {
  if (cachedEngine) return cachedEngine;
  const PdfDocument = await loadPdfKit();
  if (!PdfDocument) {
    cachedEngine = {
      error: 'PDF_RENDERER_ENGINE_UNAVAILABLE: run npm install (pdfkit is an optional render dependency)',
    };
    return cachedEngine;
  }
  const fonts = resolveFontPaths();
  if (!fonts) {
    cachedEngine = {
      error: 'PDF_RENDERER_FONT_UNAVAILABLE: Cyrillic font not found (dejavu-fonts-ttf or SAGA_DOCS_FONT)',
    };
    return cachedEngine;
  }
  cachedEngine = { PdfDocument, fonts };
  return cachedEngine;
}

/** Test seam: drop the cached engine probe. */
export function resetDocumentationRenderEngineCache(): void {
  cachedEngine = null;
}

export const pdfKitDocumentationRenderProvider: DocumentationRenderProvider = {
  id: RENDER_PROVIDER_ID,
  version: RENDER_PROVIDER_VERSION,
  probe() {
    // The capability gate reflects the WHOLE render capability: engine AND
    // fonts (2026-08-24 happy-spine fix, closing the WORKSHOP.md §18
    // residual). Before this, probe() checked fonts only — an
    // engine-absent/fonts-present environment probed `available` and the
    // later dynamic import threw, downgrading an honest `blocked` to
    // `failed`. probe and render must agree on availability by
    // construction: both resolve the same engine through require, and
    // probe's reasons name exactly which half is missing.
    const engine = resolvePdfKitEngine();
    if (!engine) {
      return {
        available: false,
        reason: 'PDF_RENDERER_ENGINE_UNAVAILABLE: run npm install (pdfkit is an optional render dependency)',
      };
    }
    const fonts = resolveFontPaths();
    if (!fonts) {
      return {
        available: false,
        reason: 'PDF_RENDERER_FONT_UNAVAILABLE: Cyrillic font not found (dejavu-fonts-ttf or SAGA_DOCS_FONT)',
      };
    }
    return { available: true };
  },
  async render(input: RenderDocumentInput): Promise<RenderDocumentResult> {
    const engine = await resolveEngine();
    if ('error' in engine) throw new Error(engine.error);
    const bytes = await renderDocumentToPdfBytes(engine, input.document);
    await writeFile(input.outputPath, bytes);
    return {
      pdfFileName: path.basename(input.outputPath),
      pdfByteHash: createHash('sha256').update(bytes).digest('hex'),
      pdfByteSize: bytes.byteLength,
    };
  },
};

export async function renderDocumentToPdfBytes(
  engine: RenderEngine,
  document: DocumentationDocument,
): Promise<Buffer> {
  const { PdfDocument, fonts } = engine;
  // Fixed CreationDate keeps byte output as stable as the engine allows; the
  // authoritative identity remains the INPUT document digest, never pdf bytes.
  const pdf = new PdfDocument({
    size: 'A4',
    margins: { top: 64, bottom: 56, left: 56, right: 56 },
    info: {
      Title: document.title,
      Author: 'saga documentation workshop',
      CreationDate: new Date(0),
    },
  });
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  pdf.font(fonts.bold, 20).fill('#111111')
    .text(document.title, { align: 'center' });
  pdf.font(fonts.regular, 10).fill('#444444')
    .text(document.documentKind, { align: 'center' });
  pdf.text(`candidate ${document.generatedFor.candidateHash.slice(0, 16)}`, {
    align: 'center',
  }).moveDown(2);

  for (const section of document.sections) {
    pdf.font(fonts.bold, 14).fill('#111111').text(section.heading).moveDown(0.5);
    pdf.font(fonts.regular, 10).fill('#1a1a1a');
    for (const block of section.blocks) renderBlock(pdf, block, fonts);
    pdf.moveDown(1);
  }
  pdf.end();
  return collected;
}

function renderBlock(
  pdf: PdfKitDocument,
  block: DocumentationBlock,
  fonts: { regular: string; bold: string },
): void {
  switch (block.type) {
    case 'paragraph':
      pdf.font(fonts.regular, 10).text(block.text, { width: 483, align: 'justify', lineGap: 3 });
      pdf.moveDown(0.5);
      return;
    case 'list':
      for (const item of block.items) {
        pdf.font(fonts.regular, 10)
          .text(`${block.ordered ? '•' : '–'} ${item}`, { indent: 12, lineGap: 2 });
      }
      pdf.moveDown(0.5);
      return;
    case 'code':
      pdf.font(fonts.regular, 9).fill('#333333')
        .text(block.text, { indent: 12, lineGap: 1 }).fill('#1a1a1a');
      pdf.moveDown(0.5);
      return;
    case 'table': {
      // Simple deterministic table: bold header row, then rows rendered as
      // aligned column text. Full column layout is renderer v2 territory.
      pdf.font(fonts.bold, 9).text(block.columns.join('   |   '), { width: 483 });
      pdf.font(fonts.regular, 9);
      for (const row of block.rows) {
        pdf.text(row.join('   |   '), { width: 483, lineGap: 2 });
      }
      pdf.moveDown(0.5);
      return;
    }
  }
}
