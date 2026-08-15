import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CANONICAL_AC_CODE_GRAMMAR = 'AC-[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*';
const LEGACY_NARROW_GRAMMAR = 'AC-[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*';

function source(path) {
  return readFileSync(path, 'utf8');
}

test('Formalization and Development accept the same hyphenated AC code grammar', () => {
  const formalization = source(
    'src/modules/formalization/domain/acceptance-criterion-document.ts',
  );
  const development = source(
    'src/modules/development/infrastructure/sqlite-development-verification-adoption.ts',
  );

  assert.ok(
    formalization.includes(CANONICAL_AC_CODE_GRAMMAR),
    'canonical Formalization parser must accept codes such as AC-NFR-1.1',
  );
  assert.ok(
    development.includes(CANONICAL_AC_CODE_GRAMMAR),
    'Development verification reader must accept the same AC code grammar',
  );
  assert.ok(
    !formalization.includes(LEGACY_NARROW_GRAMMAR),
    'legacy grammar without hyphenated segments must not return in Formalization',
  );
  assert.ok(
    !development.includes(LEGACY_NARROW_GRAMMAR),
    'legacy grammar without hyphenated segments must not return in Development',
  );
});
