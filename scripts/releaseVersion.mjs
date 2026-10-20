import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NORMAL_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assertNormalSemver(version, source = "Version") {
  if (typeof version !== "string" || !NORMAL_SEMVER.test(version)) {
    throw new Error(`${source} must use normal SemVer (for example, 0.1.1)`);
  }
  return version;
}

export function compareNormalSemver(left, right) {
  assertNormalSemver(left, "Left version");
  assertNormalSemver(right, "Right version");
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

export function verifyReleaseVersions({ packageVersion, cargoVersion, tauriVersion }) {
  const versions = [
    ["package.json", packageVersion],
    ["src-tauri/Cargo.toml", cargoVersion],
    ["src-tauri/tauri.conf.json", tauriVersion],
  ];
  const [firstSource, firstVersion] = versions[0];
  assertNormalSemver(firstVersion, `${firstSource} version`);

  for (const [source, version] of versions.slice(1)) {
    assertNormalSemver(version, `${source} version`);
    if (version !== firstVersion) {
      throw new Error(
        `Release versions must match: ${firstSource}=${firstVersion}, ${source}=${version}`,
      );
    }
  }
  return firstVersion;
}

export async function readReleaseVersion(root = process.cwd()) {
  const [packageSource, cargoSource, tauriSource] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "src-tauri", "Cargo.toml"), "utf8"),
    readFile(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  ]);

  const packageVersion = JSON.parse(packageSource).version;
  const tauriVersion = JSON.parse(tauriSource).version;
  const cargoVersion = readCargoPackageVersion(cargoSource);
  return verifyReleaseVersions({ packageVersion, cargoVersion, tauriVersion });
}

function readCargoPackageVersion(source) {
  const packageHeader = /^\[package\]\s*$/m.exec(source);
  if (!packageHeader || packageHeader.index === undefined) {
    throw new Error("src-tauri/Cargo.toml is missing its [package] section");
  }

  const afterHeader = source.slice(packageHeader.index + packageHeader[0].length);
  const nextSection = afterHeader.search(/^\[[^\]]+\]\s*$/m);
  const packageSection = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
  const version = /^version\s*=\s*"([^"]+)"\s*$/m.exec(packageSection)?.[1];
  if (!version) throw new Error("src-tauri/Cargo.toml [package] is missing version");
  return version;
}

const executedPath = process.argv[1] && path.resolve(process.argv[1]);
if (executedPath === fileURLToPath(import.meta.url)) {
  readReleaseVersion()
    .then((version) => process.stdout.write(`${version}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
