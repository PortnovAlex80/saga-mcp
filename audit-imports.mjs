import fs from 'node:fs';
import path from 'node:path';

function walk(d, acc) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
}

function importsIn(dir) {
  const files = [];
  try { walk(dir, files); } catch { return null; }
  const external = {};
  const relative = {};
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const imp = m[1];
      if (imp.startsWith('node:')) continue;
      if (imp.startsWith('.') || imp.startsWith('/')) {
        relative[imp] = (relative[imp] || 0) + 1;
      } else {
        external[imp] = (external[imp] || 0) + 1;
      }
    }
  }
  return { files: files.length, external, relative };
}

const dirs = [
  'src/saga3/domain',
  'src/process-modules/domain',
  'src/process-modules/domain/spi',
  'src/lifecycle/domain',
];

console.log('=== DOMAIN IMPORT ANALYSIS ===\n');
for (const dir of dirs) {
  const r = importsIn(dir);
  if (!r) { console.log(`(missing) ${dir}`); continue; }
  console.log(`### ${dir}  (${r.files} files)`);
  console.log('EXTERNAL (non-relative, non-stdlib):');
  const ext = Object.entries(r.external).sort((a, b) => b[1] - a[1]);
  console.log(ext.length === 0 ? '  (none)' : ext.map(([k, v]) => `  ${v}x  ${k}`).join('\n'));
  console.log('RELATIVE (internal domain / sibling):');
  const rel = Object.entries(r.relative).sort((a, b) => b[1] - a[1]);
  console.log(rel.length === 0 ? '  (none)' : rel.map(([k, v]) => `  ${v}x  ${k}`).slice(0, 10).join('\n'));
  console.log('');
}
