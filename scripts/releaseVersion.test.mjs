import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNormalSemver,
  compareNormalSemver,
  readReleaseVersion,
  verifyReleaseVersions,
} from "./releaseVersion.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("release version validation", () => {
  it("reads one normal SemVer value from all application manifests", async () => {
    const directory = await createProject({
      packageVersion: "0.1.1",
      cargoVersion: "0.1.1",
      tauriVersion: "0.1.1",
    });

    await expect(readReleaseVersion(directory)).resolves.toBe("0.1.1");
  });

  it("rejects mismatched source manifests", () => {
    expect(() => verifyReleaseVersions({
      packageVersion: "0.1.1",
      cargoVersion: "0.1.0",
      tauriVersion: "0.1.1",
    })).toThrow(/must match/i);
  });

  it("rejects prerelease and build metadata versions", () => {
    for (const version of ["0.1", "v0.1.1", "0.1.1-beta.1", "0.1.1+build.7"]) {
      expect(() => assertNormalSemver(version)).toThrow(/normal SemVer/i);
    }
  });

  it("compares normal SemVer versions numerically", () => {
    expect(compareNormalSemver("0.1.10", "0.1.2")).toBe(1);
    expect(compareNormalSemver("0.1.1", "0.1.1")).toBe(0);
    expect(compareNormalSemver("0.1.0", "0.1.1")).toBe(-1);
  });
});

async function createProject({ packageVersion, cargoVersion, tauriVersion }) {
  const directory = await mkdtemp(path.join(tmpdir(), "attn-version-test-"));
  directories.push(directory);
  await mkdir(path.join(directory, "src-tauri"));
  await Promise.all([
    writeFile(path.join(directory, "package.json"), JSON.stringify({ version: packageVersion })),
    writeFile(path.join(directory, "src-tauri", "Cargo.toml"), [
      "[package]",
      'name = "attn"',
      `version = "${cargoVersion}"`,
      "",
      "[dependencies]",
      'tauri = "2"',
    ].join("\n")),
    writeFile(
      path.join(directory, "src-tauri", "tauri.conf.json"),
      JSON.stringify({ version: tauriVersion }),
    ),
  ]);
  return directory;
}
