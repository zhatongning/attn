# Automatic Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add signed, confirmation-gated automatic updates for packaged Attn desktop applications.

**Architecture:** A frontend adapter detects an available update and keeps its resource until the user either installs or dismisses it. The desktop Tauri plugins validate, download, install, and relaunch. CI builds signed updater archives for both macOS architectures and publishes a complete signed manifest with the current download assets.

**Tech Stack:** React 19, TypeScript, Vitest, Tauri 2.0, Rust, GitHub Actions, GitHub Releases.

**Spec:** `docs/superpowers/specs/2026-10-20-automatic-updates-design.md`

## Global Constraints

- Use exactly `@tauri-apps/plugin-updater@2.0.0`, `@tauri-apps/plugin-process@2.0.0`, `tauri-plugin-updater = "=2.0.0"`, and `tauri-plugin-process = "=2.0.0"`.
- Use standard SemVer `0.1.1` consistently in all three source version files.
- Only a signed packaged desktop app checks for updates; preview/browser runs remain no-ops.
- Check automatically, but require one explicit affirmative interaction before download, installation, and relaunch.
- Never commit, log, or retain a production updater private key in the repository.
- Retain existing DMG, ZIP, and checksum downloads alongside updater artifacts.

## Review Focus

- A check result must not start a download before an explicit confirmation; test the adapter and panel action boundary.
- A stale/dismissed update resource must not be installed; test Later and unmount cleanup paths.
- Update/archive data must remain architecture-correct; test both target keys and immutable URL construction.
- A version mismatch or non-SemVer source version must fail publication before GitHub mutation.
- Missing signing credentials must fail CI without printing secret material; test static workflow assertions and local signed-build setup.

---

## File Map

- Create `src/features/updater/` modules and tests for a testable updater adapter and production-runtime gate.
- Modify `src/features/statusPanel/StatusPanelView.tsx` and tests for the prompt, confirmation, install lifecycle, and errors.
- Modify `src/App.css` for the compact update prompt.
- Modify package/Cargo manifests, locks, `src-tauri/src/lib.rs`, Tauri configuration, and capabilities for updater/process registration.
- Create or modify release helper scripts/tests and `.github/workflows/build.yml` for signing, archive validation, and manifest publication.
- Modify `README.md` and `README.zh-CN.md` for updater behavior and release-key setup without disclosing secret values.

### Task 1: Add the testable frontend update boundary

**Files:**
- Create: `src/features/updater/updateService.ts`
- Create: `src/features/updater/tauriUpdateService.ts`
- Create: `src/features/updater/updateRuntime.ts` and focused tests
- Modify: `src/features/statusPanel/StatusPanelView.tsx`
- Modify: `src/features/statusPanel/StatusPanelView.test.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Produces an adapter that returns either `null` or an update with `version`, `downloadAndInstall`, and `close` behavior.
- Produces panel state that distinguishes available, installing, dismissed, and user-visible install failure.

- [x] **Step 1: Write focused adapter and panel tests**
  Test a no-update result, background check rejection without an error prompt, an update prompt without download, Later dismissal, user-confirmed download/install/relaunch, and a visible install failure.
- [x] **Step 2: Implement the adapter and panel integration**
  Import the Tauri updater/process bindings in the adapter, feature-detect Tauri before checking, retain the update resource until disposal, and only invoke `downloadAndInstall` from the affirmative button.
- [x] **Step 3: Run focused frontend tests**
  Run: `rtk npm test -- --run src/features/updater/updateService.test.ts src/features/updater/updateRuntime.test.ts src/features/statusPanel/StatusPanelView.test.tsx`
  Expected: passing tests with no browser-only Tauri calls.

### Task 2: Enable desktop plugins and versioning

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Registers updater and process plugins before the app starts.
- Grants only check/download-and-install/restart permissions to the main desktop window.
- Commits the updater public key and endpoint; CI alone enables updater artifact generation.

- [x] **Step 1: Add exact pinned dependencies and update locks**
  Keep all existing Tauri packages pinned at `2.0.0`; update only intended lock entries.
- [x] **Step 2: Wire plugins/configuration/capabilities**
  Register both plugins, commit the immutable latest-manifest endpoint and public key, and use least-privilege capabilities. Do not add a private key or secret file; CI merges only `bundle.createUpdaterArtifacts` for release builds.
- [x] **Step 3: Run type and Rust tests**
  Run: `rtk npm run build && rtk npm run test:rust -- --locked`
  Expected: frontend type check and Rust tests pass.

### Task 3: Publish complete signed updater releases

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `scripts/publishGithubRelease.mjs`
- Modify: `scripts/publishGithubRelease.test.mjs`
- Create: `scripts/releaseVersion.mjs` and focused tests if useful

**Interfaces:**
- Consumes two architecture build artifact sets, source versions, and CI signing secret.
- Produces existing DMG/ZIP/checksum assets plus `.app.tar.gz`, `.sig`, and `latest.json`.

- [x] **Step 1: Write or update failing release tests**
  Assert exact asset inventory, cross-architecture manifest content, literal signatures, immutable build URLs, and rejection of empty/corrupt/version-mismatched assets before API mutation.
- [x] **Step 2: Build signed artifacts and generate a manifest**
  Fail the build early when signing credentials are absent, copy updater archives/signatures, verify them against the committed public key, validate source SemVer equality, upload every file to a draft release, then publish only after all uploads complete.
- [x] **Step 3: Run release helper tests**
  Run: `rtk npm test -- --run scripts/publishGithubRelease.test.mjs`
  Expected: release helper tests pass and exercise manifest failure paths.

### Task 4: Document and verify the release boundary

**Files:**
- Modify: `README.md`, `README.zh-CN.md`

- [x] **Step 1: Document user flow and maintainer setup**
  Explain automatic checks, confirmation before action, `0.1.0` manual migration, `TAURI_SIGNING_PRIVATE_KEY` configuration, public-key configuration, and the still-unnotarized macOS limitation.
- [x] **Step 2: Run integration verification**
  Run focused tests, full `rtk npm test`, `rtk npm run test:rust -- --locked`, `rtk npm run build`, `rtk git diff --check`, and a local Tauri updater-artifact build signed with the corresponding protected key. Do not install the generated application.
- [x] **Step 3: Review the complete diff**
  Check no secrets, unrelated untracked files, or unapproved `/Applications` changes appear in the patch.
