# Automatic Updates Design

Date: 2026-10-20

## Goal

Let Attn check for a newer signed release when the desktop panel starts. A
person must explicitly approve the download; the app then downloads, replaces
the installed application, and relaunches.

## Confirmed behavior

- Attn checks for updates automatically only in a packaged Tauri desktop app.
- It does not download, install, or restart before the person confirms.
- An available update is shown in a compact panel prompt with an install action
  and a Later action. Later applies only to the current app session.
- The install action downloads the signed updater archive, installs it, and
  relaunches Attn. A user-triggered failure stays visible; a background check
  failure remains quiet.
- The first updater-capable release is `0.1.1`. Existing `0.1.0` applications
  lack the updater plugin and must be upgraded manually once.

## Architecture

The frontend uses Tauri updater and process guest bindings through a small
adapter that can be mocked in Vitest. Rust registers the matching pinned
plugins and grants the main window updater/process capabilities. The signed
macOS bundle creates per-architecture updater archives; CI publishes them with
the existing DMG/ZIP downloads and a `latest.json` manifest containing
immutable build-tag URLs and signatures.

The updater public key and HTTPS manifest endpoint are part of the committed
Tauri configuration, so the installed application has an auditable, immutable
trust root. Only `master` CI runs merge the release-only updater-artifact
option and read the matching private key from a repository secret; other
manual branches build ordinary installer artifacts without that credential.
Before upload, CI verifies each generated archive signature against that
committed public key.

The updater compares normal SemVer versions. `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` must have the same
normal SemVer. A release built without a version bump may remain downloadable
but must not be represented as a newer application update.

## Security and release constraints

- Pin Tauri plugins to `2.0.0`, matching the repository's Tauri runtime.
- Commit only the updater public key. Keep `TAURI_SIGNING_PRIVATE_KEY` outside
  the repository and inject it into GitHub Actions as a repository secret for
  `master` release builds only.
- `latest.json` must include both `darwin-aarch64` and `darwin-x86_64`, each
  with a real signature and an immutable `build-<full-sha>` asset URL.
- Validate every release asset, manifest field, checksum, and source version
  before exposing a draft release.
- Tauri update signatures authenticate update contents but do not replace
  Apple Developer ID signing or notarization. The existing ad-hoc signing
  remains a separate distribution limitation.
- The updater replaces the application in place. A non-writable installed app
  must surface an install failure and leave the manual DMG path available.

## Scope boundary

This change does not silently install updates, add background downloads,
change session behavior, add an update settings page, or replace the existing
DMG/ZIP release downloads. It does not configure a GitHub secret or notarize
the app; those are external release operations requiring separate credential
handling.

## Verification

Cover adapter behavior, automatic checks, prompt actions, download progress or
install error handling, no-download-on-check, release asset validation,
complete cross-architecture manifests, version consistency, frontend/Rust
tests, and a signed local updater-artifact build using the corresponding
protected signing key. Do not replace `/Applications/Attn.app` during
verification.
