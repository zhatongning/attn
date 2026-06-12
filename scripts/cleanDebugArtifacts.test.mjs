import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs = [];
const scriptPath = path.resolve("skills/attn-debug-cleanup/scripts/clean-debug-artifacts.sh");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("clean-debug-artifacts", () => {
  it("removes rebuildable debug artifacts when the debug directory exceeds the threshold", () => {
    const root = tempRepo();
    const debugDir = seedDebugTree(root);

    const output = runCleaner(root, { thresholdBytes: 100 });

    expect(output).toContain("cleaned src-tauri/target/debug");
    expect(fs.existsSync(path.join(debugDir, "deps"))).toBe(false);
    expect(fs.existsSync(path.join(debugDir, "incremental"))).toBe(false);
    expect(fs.existsSync(path.join(debugDir, "build"))).toBe(false);
    expect(fs.existsSync(path.join(debugDir, ".fingerprint"))).toBe(false);
    expect(fs.existsSync(path.join(debugDir, "bundle", "dmg"))).toBe(false);
    expect(fs.existsSync(path.join(debugDir, "agent-session-inbox"))).toBe(false);
    expect(fs.existsSync(path.join(debugDir, "agent-session-inbox.d"))).toBe(false);
    expect(fs.existsSync(path.join(debugDir, "bundle", "macos", "Attn.app", "Contents", "MacOS", "attn"))).toBe(true);
    expect(fs.existsSync(path.join(debugDir, "attn"))).toBe(true);
  });

  it("leaves debug artifacts untouched when the debug directory is below the threshold", () => {
    const root = tempRepo();
    const debugDir = seedDebugTree(root);

    const output = runCleaner(root, { thresholdBytes: 1024 * 1024 });

    expect(output).toContain("nothing to clean");
    expect(fs.existsSync(path.join(debugDir, "deps", "libattn.rlib"))).toBe(true);
    expect(fs.existsSync(path.join(debugDir, "incremental", "cache.bin"))).toBe(true);
    expect(fs.existsSync(path.join(debugDir, "bundle", "dmg", "Attn.dmg"))).toBe(true);
  });

  it("reports cleanup targets without deleting them in dry-run mode", () => {
    const root = tempRepo();
    const debugDir = seedDebugTree(root);

    const output = runCleaner(root, { thresholdBytes: 100, dryRun: true });

    expect(output).toContain("dry run");
    expect(output).toContain("would remove src-tauri/target/debug/deps");
    expect(fs.existsSync(path.join(debugDir, "deps", "libattn.rlib"))).toBe(true);
    expect(fs.existsSync(path.join(debugDir, "bundle", "dmg", "Attn.dmg"))).toBe(true);
  });
});

function runCleaner(root, { thresholdBytes, dryRun = false }) {
  const args = dryRun ? ["--dry-run"] : [];
  return execFileSync("bash", [scriptPath, ...args], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      ATTN_REPO_ROOT: root,
      ATTN_DEBUG_CLEAN_THRESHOLD_BYTES: String(thresholdBytes),
    },
    encoding: "utf8",
  });
}

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attn-clean-debug-"));
  tempDirs.push(dir);
  return dir;
}

function seedDebugTree(root) {
  const debugDir = path.join(root, "src-tauri", "target", "debug");
  writeFile(path.join(debugDir, "deps", "libattn.rlib"), "x".repeat(256));
  writeFile(path.join(debugDir, "incremental", "cache.bin"), "x".repeat(256));
  writeFile(path.join(debugDir, "build", "script-output"), "x".repeat(256));
  writeFile(path.join(debugDir, ".fingerprint", "attn"), "x".repeat(256));
  writeFile(path.join(debugDir, "bundle", "dmg", "Attn.dmg"), "x".repeat(256));
  writeFile(path.join(debugDir, "bundle", "macos", "Attn.app", "Contents", "MacOS", "attn"), "binary");
  writeFile(path.join(debugDir, "agent-session-inbox"), "old-binary");
  writeFile(path.join(debugDir, "agent-session-inbox.d"), "old-deps");
  writeFile(path.join(debugDir, "attn"), "current-binary");
  return debugDir;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
