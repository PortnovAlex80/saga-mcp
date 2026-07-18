---
name: saga-release
description: "Release checklist for saga-mcp. Verifies: tests green, lint clean, skills synced, agents updated, docs current, metadata accurate, CI passing, CHANGELOG updated, version bumped. NOT a worker skill — loaded in main-context for release preparation."
---

# saga-release — Release Checklist

## When to use
Before tagging a new version. Run through every item. If any FAIL — release blocked.

## Pre-release checks

### 1. Build & Tests
- [ ] `npm install` — clean install, no peer dep warnings
- [ ] `npm run build` (tsc) — compiles with zero errors under strict mode
- [ ] `npm test` — ALL tests green (current count: check `node --test` output)
- [ ] `npx tsc --noEmit` — type-check passes (no type errors)
- [ ] `npx eslint src/ --max-warnings 0` — zero ESLint warnings
- [ ] `node tools/cgad-spec-lint.mjs` — runs without crash (self-test)

### 2. Skills consistency
- [ ] `ls skills/` — count skills (must match manifest/README)
- [ ] `diff <(ls skills/) <(ls ~/.zcode/skills/ | grep saga)` — all skills copied to ZCode
- [ ] For each skill: `head -3 skills/<name>/SKILL.md` — frontmatter valid (name + description)
- [ ] `grep -rl "STATUS: DRAFT\|TODO\|FIXME" skills/` — no draft markers left

### 3. Agents consistency
- [ ] `ls agents/` — count agent profiles
- [ ] Each agent `.md` has valid frontmatter (name, description, model, tools)
- [ ] Agent tool lists match actual MCP tool names (cross-check with `grep "name: '" src/tools/*.ts`)
- [ ] No agent references a tool that doesn't exist
- [ ] No agent is missing a tool it needs (e.g., verification.ac agent must have verification_record)

### 4. Metadata accuracy
- [ ] `package.json` version matches intended release version
- [ ] `package.json` description is current (not stale from upstream)
- [ ] `package.json` author/repo URL points to PortnovAlex80
- [ ] `manifest.json` version matches package.json
- [ ] `manifest.json` tool count matches actual `grep -c "name: '" src/tools/*.ts`
- [ ] `manifest.json` all tools listed with accurate descriptions
- [ ] `server.json` version matches
- [ ] `server.json` name/description/repo updated
- [ ] `README.md` tool count, skill count, lint rule count all accurate
- [ ] `README.ru.md` matches README.md (same numbers)

### 5. Documentation
- [ ] `README.md` — current, reflects all features
- [ ] `README.ru.md` — mirrors README.md
- [ ] `GUARDRAILS.md` — Signs count accurate, no broken references
- [ ] `docs/saga-mcp-history.md` — up to date with latest changes
- [ ] `docs/architecture/decisions/` — ADRs numbered correctly, status accurate
- [ ] `docs/requirements/templates/` — SRS, AC, INVARIANCES, PRD templates exist and are current
- [ ] `docs/research/` — charter v1.0 is final (not draft)

### 6. Lint & Enforcement
- [ ] `node tools/cgad-spec-lint.mjs <saga.db>` — runs clean (findings expected on live DB, but no crashes)
- [ ] `grep -c "ruleR" tools/cgad-spec-lint.mjs` — count rules, verify matches README claim
- [ ] `LINTER_VERSION` in cgad-spec-lint.mjs matches README claim
- [ ] All lint rules registered in usage(), emitJson(), main() dispatch

### 7. Schema & Migrations
- [ ] All migrations in db.ts are idempotent (try/catch pattern)
- [ ] Migration tests in tests/migrations/ pass
- [ ] ArtifactTypeSchema z.enum matches SQL CHECK in schema.ts matches ARTIFACT_TYPES in artifacts.ts matches ArtifactType in types.ts — ALL FOUR IN SYNC
- [ ] Trace link types: schema.ts CHECK matches types.ts matches artifacts.ts LINK_TYPES

### 8. CI/CD
- [ ] `.github/workflows/ci.yml` exists and runs on push/PR
- [ ] `.github/workflows/publish.yml` exists and runs on tag
- [ ] CI steps: tsc strict + ESLint + npm test + cgad-lint self-check

### 9. Git hygiene
- [ ] `git status` — working tree clean (no uncommitted changes)
- [ ] `git stash list` — empty
- [ ] `git worktree list` — only main worktree (no leftover worktrees)
- [ ] Feature branches cleaned up (only dev + master + optional active feature branches)
- [ ] `git log --oneline -5` — latest commits are meaningful (no WIP commits)

### 10. Version bump
- [ ] Decide: patch (bug fix) / minor (feature) / major (breaking)
- [ ] Update package.json version
- [ ] Update manifest.json version
- [ ] Update server.json version
- [ ] Tag: `git tag v<version>`
- [ ] Push tag: `git push origin v<version>`

## Post-release
- [ ] npm publish (if applicable)
- [ ] GitHub Release with changelog
- [ ] Copy skills to ~/.zcode/skills/
- [ ] Restart ZCode (or tell user to restart)
- [ ] Verify MCP tools count in ZCode matches manifest

## Release blocked if ANY check fails
Do not proceed with a release if any checklist item fails. Fix the issue, re-run the check, then continue.
