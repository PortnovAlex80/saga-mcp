// src/application/index.ts
//
// Application-layer barrel. Exposes the platform application services so the
// integrator can wire them at the Wave 11 gateway cutover without editing
// individual module paths. Per Wave 6 anti-scope (WAVE6-MCP-GUARDS-SPEC §3),
// this barrel does NOT rewrite src/index.ts — it only surfaces the new
// contracts for checkpoint wiring.
//
// W6-A6 owns the call-correlation surface (plan §0.9.8, §11.9-11.10).

export * from './call-correlation.js';
