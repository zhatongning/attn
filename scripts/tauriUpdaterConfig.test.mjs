import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tauriConfigPath = path.join(process.cwd(), "src-tauri", "tauri.conf.json");
const workflowPath = path.join(process.cwd(), ".github", "workflows", "build.yml");

describe("Tauri updater configuration", () => {
  it("pins a valid public key and HTTPS latest-manifest endpoint in the application", async () => {
    const config = JSON.parse(await readFile(tauriConfigPath, "utf8"));

    expect(config.plugins.updater.endpoints).toEqual([
      "https://github.com/zhatongning/attn/releases/latest/download/latest.json",
    ]);
    expect(Buffer.from(config.plugins.updater.pubkey, "base64").toString("utf8"))
      .toMatch(/^untrusted comment: minisign public key: [0-9A-F]+\nRW/);
    expect(config.bundle.createUpdaterArtifacts).toBeUndefined();
  });

  it("lets CI add updater artifacts through the bundler without replacing the application trust root", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("--config '{\"bundle\":{\"createUpdaterArtifacts\":true}}'");
    expect(workflow).not.toContain("TAURI_UPDATER_PUBLIC_KEY");
  });

  it("only exposes the signing key and updater artifacts on master", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const masterCondition = "if: github.ref == 'refs/heads/master'";
    const nonMasterCondition = "if: github.ref != 'refs/heads/master'";

    expect(step(workflow, "Configure signed updater build")).toContain(masterCondition);

    const signingSteps = workflow
      .split("\n      - name: ")
      .filter((workflowStep) => workflowStep.includes("TAURI_SIGNING_PRIVATE_KEY"));
    expect(signingSteps).toHaveLength(2);
    for (const signingStep of signingSteps) {
      expect(signingStep).toContain(masterCondition);
    }

    const signedBuild = step(workflow, "Build signed application and updater");
    expect(signedBuild).toContain(masterCondition);
    expect(signedBuild).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(signedBuild).toContain("--bundles app,dmg,updater");

    const updaterArtifacts = step(workflow, "Prepare signed updater artifacts");
    expect(updaterArtifacts).toContain(masterCondition);
    expect(updaterArtifacts).toContain(".app.tar.gz.sig");

    const verification = step(workflow, "Verify updater signature");
    expect(verification).toContain(masterCondition);

    const regularBuild = step(workflow, "Build application and installer");
    expect(regularBuild).toContain(nonMasterCondition);
    expect(regularBuild).toContain("--bundles app,dmg");
    expect(regularBuild).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(regularBuild).not.toContain("updater");

    const regularArtifacts = step(workflow, "Prepare application and installer artifacts");
    expect(regularArtifacts).toContain(".dmg");
    expect(regularArtifacts).toContain(".app.zip");
    expect(regularArtifacts).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(regularArtifacts).not.toContain(".app.tar.gz");
  });
});

function step(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);

  expect(start, `workflow step ${name} should exist`).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}
