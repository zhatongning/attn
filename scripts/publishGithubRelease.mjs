import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertNormalSemver, compareNormalSemver } from "./releaseVersion.mjs";

const ARCHITECTURES = ["arm64", "x64"];

export async function verifyReleaseAssets(directory) {
  const names = ARCHITECTURES.flatMap(releaseAssetNames);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())
    || entries.map((entry) => entry.name).sort().join("\n") !== [...names].sort().join("\n")) {
    throw new Error("Release assets must contain exactly both architectures and their checksums");
  }

  const assets = await Promise.all(names.map(async (name) => {
    const data = await readFile(path.join(directory, name));
    if (data.length === 0) throw new Error(`Empty release asset: ${name}`);
    return { name, data };
  }));
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  for (const architecture of ARCHITECTURES) {
    const manifest = byName.get(`Attn-macOS-${architecture}.SHA256SUMS.txt`);
    const required = new Set([
      `Attn-macOS-${architecture}.dmg`,
      `Attn-macOS-${architecture}.app.zip`,
      `Attn-macOS-${architecture}.app.tar.gz`,
      `Attn-macOS-${architecture}.app.tar.gz.sig`,
    ]);
    for (const line of manifest.data.toString("utf8").trim().split(/\r?\n/)) {
      const match = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line);
      if (!match || !required.delete(match[2])) {
        throw new Error(`Invalid checksum entry for ${architecture}: ${line}`);
      }
      const actual = createHash("sha256").update(byName.get(match[2]).data).digest("hex");
      if (actual !== match[1].toLowerCase()) {
        throw new Error(`Checksum mismatch: ${match[2]}`);
      }
    }
    if (required.size > 0) throw new Error(`Missing checksum entries for ${architecture}`);
  }
  return assets;
}

export function createUpdaterManifestAsset({ owner, repo, tag, version, assets, publishedAt }) {
  assertNormalSemver(version, "Updater manifest version");
  if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) {
    throw new Error("Updater manifest requires a valid publication date");
  }

  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  const base = `https://github.com/${owner}/${repo}/releases/download/${tag}`;
  const platforms = Object.fromEntries(ARCHITECTURES.map((architecture) => {
    const name = `Attn-macOS-${architecture}.app.tar.gz`;
    const signature = byName.get(`${name}.sig`)?.data.toString("utf8").trim();
    if (!signature) throw new Error(`Missing updater signature for ${architecture}`);
    return [
      architecture === "arm64" ? "darwin-aarch64" : "darwin-x86_64",
      { signature, url: `${base}/${name}` },
    ];
  }));
  const manifest = {
    version,
    notes: `Attn ${version} (${tag.slice("build-".length, "build-".length + 7)})`,
    pub_date: publishedAt.toISOString(),
    platforms,
  };
  return {
    name: "latest.json",
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  };
}

export async function publishGithubRelease({
  github,
  context,
  assetDirectory,
  version,
  now = () => new Date(),
}) {
  if (context.ref !== "refs/heads/master") {
    throw new Error("Release publishing is restricted to master");
  }
  if (!/^[a-f0-9]{40}$/.test(context.sha)) {
    throw new Error("Release publishing requires a full commit SHA");
  }
  assertNormalSemver(version, "Updater release version");

  const assets = await verifyReleaseAssets(assetDirectory);
  const { owner, repo } = context.repo;
  const repository = { owner, repo };
  const api = github.rest.repos;
  const tag = `build-${context.sha}`;
  const releaseAssets = [
    ...assets,
    createUpdaterManifestAsset({
      owner,
      repo,
      tag,
      version,
      assets,
      publishedAt: now(),
    }),
  ];
  const latestUrl = `https://github.com/${owner}/${repo}/releases/latest`;
  let release = await optionalRelease(() => api.getReleaseByTag({
    ...repository,
    tag,
  }));
  if (!release) {
    for (let page = 1; ; page += 1) {
      const { data: releases } = await api.listReleases({
        ...repository,
        per_page: 100,
        page,
      });
      release = releases.find((candidate) => candidate.tag_name === tag && candidate.draft);
      if (release || releases.length < 100) break;
    }
  }

  // Published releases may be immutable. A rerun preserves the original packages.
  if (release && !release.draft) {
    if (!releaseAssets.every((asset) => release.assets.some(
      (published) => published.name === asset.name && published.size > 0,
    ))) {
      throw new Error(`Published release ${tag} is incomplete; preserving its existing assets`);
    }
    return { url: release.html_url, latestUrl, reused: true };
  }

  const { data: master } = await api.getBranch({ ...repository, branch: "master" });
  if (master.commit.sha !== context.sha) {
    const { data: comparison } = await api.compareCommitsWithBasehead({
      ...repository,
      basehead: `${context.sha}...${master.commit.sha}`,
    });
    // GITHUB_TOKEN cannot tag a stale commit whose workflow differs from the default branch.
    if (comparison.files?.some((file) => file.filename.startsWith(".github/workflows/"))) {
      return { latestUrl, skipped: true, reason: "A newer master workflow supersedes this build" };
    }
  }

  if (!release) {
    const result = await api.createRelease({
      ...repository,
      tag_name: tag,
      target_commitish: context.sha,
      name: `Attn master build ${context.sha.slice(0, 7)}`,
      body: releaseNotes(owner, repo, context.sha, context.runId, version),
      draft: true,
      prerelease: false,
      make_latest: "false",
    });
    release = result.data;
  } else {
    await api.updateRelease({
      ...repository,
      release_id: release.id,
      name: `Attn master build ${context.sha.slice(0, 7)}`,
      body: releaseNotes(owner, repo, context.sha, context.runId, version),
    });
  }

  for (const asset of releaseAssets) {
    const previous = release.assets.find((published) => published.name === asset.name);
    if (previous) {
      await api.deleteReleaseAsset({ ...repository, asset_id: previous.id });
    }
    await api.uploadReleaseAsset({
      ...repository,
      release_id: release.id,
      name: asset.name,
      data: asset.data,
      headers: {
        "content-type": contentTypeFor(asset.name),
        "content-length": asset.data.length,
      },
    });
  }

  const latest = await optionalRelease(() => api.getLatestRelease(repository));
  let makeLatest = true;
  const latestVersion = latest && releaseVersionFromMetadata(latest.body);
  if (latestVersion) {
    makeLatest = compareNormalSemver(version, latestVersion) > 0;
  } else if (latest) {
    makeLatest = await newerThanLatestCommit({ api, repository, latest, context, master });
  }

  // Only expose a new download page after the complete asset set is uploaded.
  const result = await api.updateRelease({
    ...repository,
    release_id: release.id,
    draft: false,
    make_latest: makeLatest ? "true" : "false",
  });
  return { url: result.data.html_url, latestUrl, makeLatest };
}

async function newerThanLatestCommit({ api, repository, latest, context, master }) {
  let makeLatest = true;
  if (latest) {
    const { data: comparison } = await api.compareCommitsWithBasehead({
      ...repository,
      basehead: `${latest.tag_name}...${context.sha}`,
    });
    switch (comparison.status) {
      case "ahead":
      case "identical":
        makeLatest = true;
        break;
      case "behind":
        makeLatest = false;
        break;
      case "diverged":
        makeLatest = master.commit.sha === context.sha;
        break;
      default:
        throw new Error(`Unknown release commit comparison: ${comparison.status}`);
    }
  }
  return makeLatest;
}

async function optionalRelease(request) {
  try {
    return (await request()).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function releaseAssetNames(architecture) {
  return [
    `Attn-macOS-${architecture}.dmg`,
    `Attn-macOS-${architecture}.app.zip`,
    `Attn-macOS-${architecture}.app.tar.gz`,
    `Attn-macOS-${architecture}.app.tar.gz.sig`,
    `Attn-macOS-${architecture}.SHA256SUMS.txt`,
  ];
}

function contentTypeFor(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".txt") || name.endsWith(".sig")) return "text/plain";
  return "application/octet-stream";
}

function releaseNotes(owner, repo, sha, runId, version) {
  const base = `https://github.com/${owner}/${repo}`;
  return [
    `Automatically built from [master commit ${sha.slice(0, 7)}](${base}/commit/${sha}).`,
    "",
    `Application version: \`${version}\`. Automatic updates are offered only when this version increases.`,
    "Attn 0.1.0 does not include the updater and must install 0.1.1 manually once.",
    `<!-- attn-app-version: ${version} -->`,
    "",
    "| Mac | Installer | App archive | Updater archive | Checksums |",
    "| --- | --- | --- | --- | --- |",
    ...ARCHITECTURES.map((architecture) => {
      const download = `${base}/releases/download/build-${sha}/Attn-macOS-${architecture}`;
      const label = architecture === "arm64" ? "Apple Silicon" : "Intel";
      return `| ${label} | [DMG](${download}.dmg) | [ZIP](${download}.app.zip) | [Updater](${download}.app.tar.gz) | [SHA-256](${download}.SHA256SUMS.txt) |`;
    }),
    "",
    `[Updater manifest](${base}/releases/latest/download/latest.json)`,
    "",
    "Packages are ad-hoc signed and are not notarized by Apple. macOS may require approval in Privacy & Security.",
    "",
    `[Build details](${base}/actions/runs/${runId})`,
  ].join("\n");
}

function releaseVersionFromMetadata(body) {
  const version = /<!--\s*attn-app-version:\s*([^\s]+)\s*-->/.exec(body ?? "")?.[1];
  return version ? assertNormalSemver(version, "Latest release version metadata") : null;
}
