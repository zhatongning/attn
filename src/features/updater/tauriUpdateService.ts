import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { createUpdateService, type AvailableUpdate, type UpdateDownloadEvent } from "./updateService";

function toAvailableUpdate(update: Update): AvailableUpdate {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    downloadAndInstall: (onEvent) => update.downloadAndInstall(
      onEvent as ((event: DownloadEvent) => void) | undefined,
    ),
    close: () => update.close(),
  };
}

export const tauriUpdateService = createUpdateService({
  async check() {
    const update = await check();
    return update ? toAvailableUpdate(update) : null;
  },
  relaunch,
});

export type { UpdateDownloadEvent };
