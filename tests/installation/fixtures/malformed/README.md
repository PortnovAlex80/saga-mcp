# W2-A7 Malformed / Security Fixtures

Wave 2, Lane A7 — `refactor/w2-a7`. Plan ref: §5.5.7, §5.5.8, §9.2.

These fixtures are **DATA ONLY**. They carry no executable code and no real
bytes (where bytes are needed, they are declared as base64 strings inside the
JSON so the consuming test materializes them via `Uint8Array`).

They exist so W2-A1 (FilesystemModulePackageStore), W2-A3 (PackageInstaller +
dependency lock), W2-A2 (installation repository) and W2-A8 (conformance) can
each consume a shared, frozen negative-case fixture without owning it.

## Files

| File | Consumed by | Expected behavior |
|---|---|---|
| `path-traversal-resource.json` | W2-A1 store + W2-A3 installer | Reject with `MODULE_PACKAGE_PATH_TRAVERSAL` (or equivalent code the store/installer chooses) — `logicalId: '../escape'` MUST NOT escape the package root. The bytes are placeholder UTF-8; the digest is a marker string. |
| `hash-mismatch.json` | W2-A1 store + W2-A3 installer | Detect during verify-after-store that a resource's declared digest does NOT hash to its bytes → reject with `MODULE_INSTALLATION_CORRUPT` (or flip status to `'corrupt'`). The `bytes` decode to `{"hello":"world"}`; the declared digest deliberately does NOT match. |
| `version-collision/a.json` + `version-collision/b.json` | W2-A2 repo + W2-A3 installer | Same `(name, version)` = `synthetic-compliance-check@0.2.0-collision`, DIFFERENT content (different handler refs + outcome codes). Installing B after A (or vice versa) under `status='active'` MUST throw `MODULE_INSTALLATION_VERSION_COLLISION` (plan §3.11, §5.5.8). |

## Anti-scope

- No real bytes are checked into this repo. Each fixture documents the bytes
  it needs (as base64 or as a description) so the consuming test materializes
  them on the fly.
- No fixture is imported by production source. They live under
  `tests/installation/fixtures/` and are consumed only by tests.
- These fixtures do NOT overlap with W0-A7's `tests/fixtures/synthetic-modules/`
  — those are positive fixtures for module-kind-agnostic SPI validation; these
  are negative fixtures for the immutable-package + collision/corruption gates.
