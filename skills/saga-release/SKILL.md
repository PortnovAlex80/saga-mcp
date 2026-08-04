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

<!-- source: EXT-14 https://mcpmarket.com/tools/skills/github-actions-manager -->
**CI-management procedure** (confirm green on the release commit, not just "workflow exists"):
- [ ] `gh run list --workflow ci.yml --branch <release-branch> --limit 1` — find the latest run on the release branch
- [ ] `gh run view <run-id> --json conclusion --jq '.conclusion'` — must be `success`
- [ ] If failed: `gh run view <run-id> --log-failed` — read the failing step before rerunning
- [ ] After a fix: `gh run rerun <run-id> --failed` (rerun only failed jobs) then `gh run watch <run-id>`
- [ ] For `publish.yml` on the tag: `gh run list --workflow publish.yml --limit 1` then `gh run watch <run-id>` until conclusion is `success`

### 9. Git hygiene & pre-publish safety
- [ ] `git status` — working tree clean (no uncommitted changes)
- [ ] `git stash list` — empty
- [ ] `git worktree list` — only main worktree (no leftover worktrees)
- [ ] Feature branches cleaned up (only dev + master + optional active feature branches)
- [ ] `git log --oneline -5` — latest commits are meaningful (no WIP commits)

<!-- source: EXT-16 https://github.com/levnikolaevich/claude-code-skills (ln-62-repository-publisher) -->
**Pre-publish safety** (from safe-repo-publishing — merged, deduped with the items above):
- [ ] `git diff --cached` — scan the staged set for secrets, tokens, credentials, local caches, and temp artifacts. Inspect deletions and generated files as carefully as edits.
- [ ] Confirm no unrelated user changes are staged without explicit whole-worktree authorization (stage explicit paths in a mixed worktree).
- [ ] `git fetch <remote> && git log HEAD..<remote>/<branch>` — confirm local HEAD is in sync with the remote branch before committing.
- [ ] If histories diverge: STOP. Report the commits on both sides; do NOT force-push or rewrite history implicitly.
- [ ] After push: `gh run watch <run-id>` — confirm the remote branch resolves to the pushed commit AND required CI passes. Never treat a successful push as proof that CI / marketplace refresh / deployment succeeded (cross-references the EXT-14 step above).

**Safety gates** (hard prohibitions — return BLOCKED rather than bypass):
- [ ] Never expose authentication tokens or credential values in output.
- [ ] Never create a release, tag, package publication, or PR unless explicitly requested by the operator.
- [ ] Never delete remote branches or alter the default branch as a side effect.
- [ ] Never bypass branch protection, required checks, or authentication to force the release through.

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
