export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface AvailableUpdate {
  currentVersion: string;
  version: string;
  downloadAndInstall(onEvent?: (event: UpdateDownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateClient {
  check(): Promise<AvailableUpdate | null>;
  relaunch(): Promise<void>;
}

export interface UpdateService {
  checkForUpdate(): Promise<AvailableUpdate | null>;
  installAndRelaunch(update: AvailableUpdate, onEvent?: (event: UpdateDownloadEvent) => void): Promise<void>;
}

export class UpdateRestartError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("The update was installed, but Attn could not restart.");
    this.name = "UpdateRestartError";
    this.cause = cause;
  }
}

export function createUpdateService(client: UpdateClient): UpdateService {
  return {
    checkForUpdate: () => client.check(),
    async installAndRelaunch(update, onEvent) {
      try {
        await update.downloadAndInstall(onEvent);
      } finally {
        await update.close().catch(() => undefined);
      }

      try {
        await client.relaunch();
      } catch (error) {
        throw new UpdateRestartError(error);
      }
    },
  };
}
