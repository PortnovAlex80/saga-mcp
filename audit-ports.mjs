import fs from 'node:fs';
import path from 'node:path';

function walk(d, acc) {
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (e.name.endsWith('.ts')) acc.push(p);
    }
  } catch {}
}

const dirs = [
  'src/saga3/domain',
  'src/process-modules/domain',
  'src/lifecycle/domain',
];

console.log('=== WHO DEFINES THE PORTS THE DOMAIN DEPENDS ON? ===\n');

// 1. Find every port/interface declared INSIDE domain dirs
console.log('--- Interfaces/Ports DECLARED inside domain ---');
let declaredInDomain = 0;
for (const dir of dirs) {
  const files = []; walk(dir, files);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/export\s+(?:interface|type)\s+([A-Z][A-Za-z0-9]*(?:Port|Repository|Provider|Gateway|Service|Adapter|SPI|Spi))/g)) {
      declaredInDomain++;
      const rel = f.replace(/\\/g, '/');
      console.log(`  ${m[1]}  <- ${rel}`);
    }
  }
}
console.log(declaredInDomain === 0 ? '  (NONE — domain declares no ports)' : `  TOTAL: ${declaredInDomain}`);

// 2. Find every interface the domain IMPORTS from outside its own dir
console.log('\n--- Interfaces IMPORTED by domain from OUTSIDE (port ownership test) ---');
let importedFromOutside = 0;
const seen = new Set();
for (const dir of dirs) {
  const files = []; walk(dir, files);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    // imports from ../application/ports or any ../ that escapes domain
    for (const m of s.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const imp = m[1];
      if (imp.startsWith('node:')) continue;
      // resolve relative to file
      let resolved = imp;
      if (imp.startsWith('.')) {
        resolved = path.resolve(path.dirname(f), imp).replace(/\\/g, '/');
      }
      // does it escape the domain dir?
      const inDomain = resolved.includes('/domain/') || resolved.includes('/domain/spi/');
      const key = f.replace(/\\/g,'/') + ' -> ' + resolved;
      if (!inDomain && !imp.startsWith('.')) {
        // external package import - skip
      }
      if (!inDomain && imp.startsWith('.')) {
        // imports something outside domain dir via relative path
        // check if it is a port/interface file
        if (/port|repository|provider|gateway|spi/i.test(imp) && !seen.has(key)) {
          seen.add(key);
          importedFromOutside++;
          const rel = f.replace(/\\/g,'/');
          console.log(`  ${rel}  imports  ${imp}`);
        }
      }
    }
  }
}
console.log(importedFromOutside === 0 ? '  (NONE — domain imports no ports from outside)' : `  TOTAL: ${importedFromOutside}`);

console.log('\n=== PORT OWNERSHIP IN THE CODEBASE ===');
console.log('Where are interfaces with Port/Repository/Provider suffix declared?');
const portHomes = {};
const allFiles = [];
walk('src', allFiles);
for (const f of allFiles) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/export\s+(?:interface)\s+([A-Z][A-Za-z0-9]*(?:Port|Repository))\b/g)) {
    const home = f.replace(/\\/g,'/').split('/').slice(0,4).join('/');
    portHomes[home] = (portHomes[home] || 0) + 1;
  }
}
for (const [k,v] of Object.entries(portHomes).sort((a,b)=>b[1]-a[1])) console.log(`  ${v}x  ${k}`);

console.log('\n=== DO ADAPTERS IMPLEMENT PORTS (dependency inversion proof)? ===');
let infraImpls = 0;
const infraExamples = [];
let moduleImpls = 0;
const moduleExamples = [];
for (const f of allFiles) {
  const s = fs.readFileSync(f, 'utf8');
  const norm = f.replace(/\\/g, '/');
  const isInfra = /\/infrastructure\//.test(norm);
  for (const m of s.matchAll(/implements\s+([A-Z][A-Za-z0-9]*(?:Port|Repository|Provider|Spi|SPI))/g)) {
    if (isInfra) { infraImpls++; if (infraExamples.length < 12) infraExamples.push(`${norm.replace(/.*src\//,'src/')}  implements ${m[1]}`); }
    else { moduleImpls++; if (moduleExamples.length < 6) moduleExamples.push(`${norm.replace(/.*src\//,'src/')}  implements ${m[1]}`); }
  }
}
console.log(`infrastructure/ adapters implementing ports: ${infraImpls}`);
infraExamples.forEach(x => console.log('  ' + x));
console.log(`module code implementing ports: ${moduleImpls}`);
moduleExamples.forEach(x => console.log('  ' + x));
