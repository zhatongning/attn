import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishGithubRelease, verifyReleaseAssets } from "./publishGithubRelease.mjs";

const SHA = "a".repeat(40);
const context = {
  repo: { owner: "zhatongning", repo: "attn" },
  sha: SHA,
  ref: "refs/heads/master",
  runId: 123,
};
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("GitHub release publishing", () => {
  it("verifies both architectures and their real file checksums", async () => {
    const directory = await createAssets();
    const assets = await verifyReleaseAssets(directory);

    expect(assets.map((asset) => asset.name).sort()).toEqual(expectedNames());
    expect(assets.every((asset) => asset.data.length > 0)).toBe(true);
  });

  it("rejects corrupt files before making any GitHub request", async () => {
    const directory = await createAssets();
    await writeFile(path.join(directory, "Attn-macOS-x64.dmg"), "corrupted");
    const service = createGithub();

    await expect(publishGithubRelease({
      github: service.github,
      context,
      assetDirectory: directory,
    })).rejects.toThrow(/checksum/i);
    expect(service.operations).toEqual([]);
  });

  it("rejects unexpected files instead of publishing them", async () => {
    const directory = await createAssets();
    await writeFile(path.join(directory, "debug.log"), "not a release asset");
    const service = createGithub();

    await expect(publishGithubRelease({
      github: service.github,
      context,
      assetDirectory: directory,
    })).rejects.toThrow(/exactly both architectures/i);
    expect(service.operations).toEqual([]);
  });

  it("publishes only after all six assets have uploaded", async () => {
    const directory = await createAssets();
    const service = createGithub();

    const result = await publishGithubRelease({
      github: service.github,
      context,
      assetDirectory: directory,
    });

    expect(service.operations.find((operation) => operation.type === "create")?.args)
      .toMatchObject({
        tag_name: `build-${SHA}`,
        target_commitish: SHA,
        draft: true,
        prerelease: false,
        make_latest: "false",
      });
    expect(service.operations.filter((operation) => operation.type === "upload")).toHaveLength(6);
    expect(service.operations.at(-1)).toMatchObject({
      type: "publish",
      args: { draft: false, make_latest: "true" },
    });
    expect(result.latestUrl).toBe("https://github.com/zhatongning/attn/releases/latest");
  });

  it("keeps a newer release as latest when an older build finishes late", async () => {
    const directory = await createAssets();
    const service = createGithub({
      latest: { tag_name: "build-newer" },
      comparison: "behind",
    });

    await publishGithubRelease({ github: service.github, context, assetDirectory: directory });

    expect(service.operations.at(-1)).toMatchObject({
      type: "publish",
      args: { draft: false, make_latest: "false" },
    });
  });

  it("advances latest for a newer successful commit", async () => {
    const directory = await createAssets();
    const service = createGithub({
      latest: { tag_name: "build-older" },
      comparison: "ahead",
    });

    await publishGithubRelease({ github: service.github, context, assetDirectory: directory });

    expect(service.operations.at(-1)).toMatchObject({
      type: "publish",
      args: { make_latest: "true" },
    });
  });

  it("leaves a draft unpublished when uploading fails", async () => {
    const directory = await createAssets();
    const service = createGithub({ failUpload: 3 });

    await expect(publishGithubRelease({
      github: service.github,
      context,
      assetDirectory: directory,
    })).rejects.toThrow("upload unavailable");
    expect(service.operations.some((operation) => operation.type === "publish")).toBe(false);
  });

  it("resumes a partial draft without deleting any published release", async () => {
    const directory = await createAssets();
    const service = createGithub({
      existing: {
        id: 99,
        tag_name: `build-${SHA}`,
        draft: true,
        assets: [{ id: 7, name: "Attn-macOS-arm64.dmg", size: 1 }],
      },
    });

    await publishGithubRelease({ github: service.github, context, assetDirectory: directory });

    expect(service.operations.filter((operation) => operation.type === "delete")).toEqual([
      { type: "delete", args: { owner: "zhatongning", repo: "attn", asset_id: 7 } },
    ]);
    expect(service.operations.filter((operation) => operation.type === "upload")).toHaveLength(6);
    expect(service.operations.find((operation) => operation.type === "updateDraft")?.args.body)
      .toContain("/actions/runs/123");
    expect(service.operations.filter((operation) => operation.type === "create")).toEqual([]);
    expect(service.operations.some((operation) => operation.type === "list")).toBe(true);
    expect(service.operations.at(-1)).toMatchObject({
      type: "publish",
      args: { draft: false },
    });
  });

  it("does not modify an already published complete release on rerun", async () => {
    const directory = await createAssets();
    const service = createGithub({
      existing: {
        id: 99,
        draft: false,
        immutable: true,
        html_url: `https://github.com/zhatongning/attn/releases/tag/build-${SHA}`,
        assets: expectedNames().map((name) => ({ name, size: 1 })),
      },
    });

    await publishGithubRelease({ github: service.github, context, assetDirectory: directory });

    expect(service.operations.map((operation) => operation.type)).toEqual(["getByTag"]);
  });

  it("preserves an incomplete published release instead of rewriting it", async () => {
    const directory = await createAssets();
    const service = createGithub({
      existing: { id: 99, draft: false, assets: [] },
    });

    await expect(publishGithubRelease({
      github: service.github,
      context,
      assetDirectory: directory,
    })).rejects.toThrow(/preserving its existing assets/i);
    expect(service.operations.map((operation) => operation.type)).toEqual(["getByTag"]);
  });

  it("skips a stale workflow commit that GITHUB_TOKEN cannot tag", async () => {
    const directory = await createAssets();
    const service = createGithub({
      masterSha: "b".repeat(40),
      comparisonFiles: [{ filename: ".github/workflows/build.yml" }],
    });

    const result = await publishGithubRelease({
      github: service.github,
      context,
      assetDirectory: directory,
    });

    expect(result.skipped).toBe(true);
    expect(service.operations.find((operation) => operation.type === "compare")?.args.basehead)
      .toBe(`${SHA}...${"b".repeat(40)}`);
    expect(service.operations.some((operation) => operation.type === "create")).toBe(false);
    expect(service.operations.some((operation) => operation.type === "upload")).toBe(false);
  });

  it("refuses to publish a non-master manual run", async () => {
    const directory = await createAssets();
    const service = createGithub();

    await expect(publishGithubRelease({
      github: service.github,
      context: { ...context, ref: "refs/heads/feature/example" },
      assetDirectory: directory,
    })).rejects.toThrow(/master/i);
    expect(service.operations).toEqual([]);
  });
});

function expectedNames() {
  return ["arm64", "x64"].flatMap((architecture) => [
    `Attn-macOS-${architecture}.dmg`,
    `Attn-macOS-${architecture}.app.zip`,
    `Attn-macOS-${architecture}.SHA256SUMS.txt`,
  ]).sort();
}

async function createAssets() {
  const directory = await mkdtemp(path.join(tmpdir(), "attn-release-test-"));
  directories.push(directory);
  for (const architecture of ["arm64", "x64"]) {
    const checksums = [];
    for (const suffix of ["dmg", "app.zip"]) {
      const name = `Attn-macOS-${architecture}.${suffix}`;
      const data = Buffer.from(`${architecture} ${suffix}`);
      await writeFile(path.join(directory, name), data);
      checksums.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
    }
    await writeFile(
      path.join(directory, `Attn-macOS-${architecture}.SHA256SUMS.txt`),
      `${checksums.join("\n")}\n`,
    );
  }
  return directory;
}

function createGithub({
  existing,
  latest,
  comparison = "ahead",
  comparisonFiles = [],
  masterSha = SHA,
  failUpload,
} = {}) {
  const operations = [];
  let uploads = 0;
  function missing() {
    throw Object.assign(new Error("not found"), { status: 404 });
  }
  const github = { rest: { repos: {
    async getReleaseByTag(args) {
      operations.push({ type: "getByTag", args });
      return existing && !existing.draft ? { data: existing } : missing();
    },
    async listReleases(args) {
      operations.push({ type: "list", args });
      return { data: existing?.draft ? [existing] : [] };
    },
    async createRelease(args) {
      operations.push({ type: "create", args });
      return { data: { id: 99, draft: true, assets: [] } };
    },
    async deleteReleaseAsset(args) {
      operations.push({ type: "delete", args });
      return { data: null };
    },
    async uploadReleaseAsset(args) {
      operations.push({ type: "upload", args });
      uploads += 1;
      if (uploads === failUpload) throw new Error("upload unavailable");
      return { data: { name: args.name, size: args.data.length } };
    },
    async getLatestRelease(args) {
      operations.push({ type: "getLatest", args });
      return latest ? { data: latest } : missing();
    },
    async compareCommitsWithBasehead(args) {
      operations.push({ type: "compare", args });
      return { data: { status: comparison, files: comparisonFiles } };
    },
    async getBranch(args) {
      operations.push({ type: "getBranch", args });
      return { data: { commit: { sha: masterSha } } };
    },
    async updateRelease(args) {
      operations.push({ type: args.draft === false ? "publish" : "updateDraft", args });
      return { data: {
        html_url: `https://github.com/zhatongning/attn/releases/tag/build-${SHA}`,
      } };
    },
  } } };
  return { github, operations };
}
