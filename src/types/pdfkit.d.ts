/**
 * Minimal ambient declaration for the optional `pdfkit` render dependency.
 *
 * pdfkit is an OPTIONAL engine of the documentation workshop render provider
 * (lazy dynamic import — see pdfkit-documentation-render-provider.ts). The
 * factory must typecheck and run WITHOUT the package installed: a missing
 * engine surfaces as an honest typed blocked render, never a crash. The
 * provider casts to its own structural PdfKitDocument interface at runtime;
 * this shim only satisfies `await import('pdfkit')` for tsc.
 */
declare module 'pdfkit' {
  const PdfDocument: unknown;
  export default PdfDocument;
}
