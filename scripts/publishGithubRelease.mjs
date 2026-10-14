import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ARCHITECTURES = ["arm64", "x64"];

export async function verifyReleaseAssets(directory) {
  const names = ARCHITECTURES.flatMap((architecture) => [
    `Attn-macOS-${architecture}.dmg`,
    `Attn-macOS-${architecture}.app.zip`,
    `Attn-macOS-${architecture}.SHA256SUMS.txt`,
  ]);
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

export async function publishGithubRelease({ github, context, assetDirectory }) {
  if (context.ref !== "refs/heads/master") {
    throw new Error("Release publishing is restricted to master");
  }
  if (!/^[a-f0-9]{40}$/.test(context.sha)) {
    throw new Error("Release publishing requires a full commit SHA");
  }

  const assets = await verifyReleaseAssets(assetDirectory);
  const { owner, repo } = context.repo;
  const repository = { owner, repo };
  const api = github.rest.repos;
  const tag = `build-${context.sha}`;
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
    if (!assets.every((asset) => release.assets.some(
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
      body: releaseNotes(owner, repo, context.sha, context.runId),
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
      body: releaseNotes(owner, repo, context.sha, context.runId),
    });
  }

  for (const asset of assets) {
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
        "content-type": asset.name.endsWith(".txt") ? "text/plain" : "application/octet-stream",
        "content-length": asset.data.length,
      },
    });
  }

  const latest = await optionalRelease(() => api.getLatestRelease(repository));
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

  // Only expose a new download page after the complete asset set is uploaded.
  const result = await api.updateRelease({
    ...repository,
    release_id: release.id,
    draft: false,
    make_latest: makeLatest ? "true" : "false",
  });
  return { url: result.data.html_url, latestUrl, makeLatest };
}

async function optionalRelease(request) {
  try {
    return (await request()).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function releaseNotes(owner, repo, sha, runId) {
  const base = `https://github.com/${owner}/${repo}`;
  return [
    `Automatically built from [master commit ${sha.slice(0, 7)}](${base}/commit/${sha}).`,
    "",
    "This is a continuous master build; the application version is independent of the build tag.",
    "",
    "| Mac | Installer | App archive | Checksums |",
    "| --- | --- | --- | --- |",
    ...ARCHITECTURES.map((architecture) => {
      const download = `${base}/releases/download/build-${sha}/Attn-macOS-${architecture}`;
      const label = architecture === "arm64" ? "Apple Silicon" : "Intel";
      return `| ${label} | [DMG](${download}.dmg) | [ZIP](${download}.app.zip) | [SHA-256](${download}.SHA256SUMS.txt) |`;
    }),
    "",
    "Packages are ad-hoc signed and are not notarized by Apple. macOS may require approval in Privacy & Security.",
    "",
    `[Build details](${base}/actions/runs/${runId})`,
  ].join("\n");
}
