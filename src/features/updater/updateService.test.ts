import { describe, expect, it, vi } from "vitest";
import { createUpdateService, UpdateRestartError, type AvailableUpdate } from "./updateService";

function availableUpdate(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    currentVersion: "0.1.0",
    version: "0.1.1",
    downloadAndInstall: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("createUpdateService", () => {
  it("delegates update checks without downloading", async () => {
    const update = availableUpdate();
    const check = vi.fn(async () => update);
    const relaunch = vi.fn(async () => undefined);
    const service = createUpdateService({ check, relaunch });

    await expect(service.checkForUpdate()).resolves.toBe(update);
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("downloads, closes the update resource, and relaunches after confirmation", async () => {
    const update = availableUpdate();
    const check = vi.fn(async () => update);
    const relaunch = vi.fn(async () => undefined);
    const service = createUpdateService({ check, relaunch });
    const onEvent = vi.fn();

    await service.installAndRelaunch(update, onEvent);

    expect(update.downloadAndInstall).toHaveBeenCalledWith(onEvent);
    expect(update.close).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("closes the update resource when download or installation fails", async () => {
    const update = availableUpdate({
      downloadAndInstall: vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    });
    const service = createUpdateService({
      check: vi.fn(async () => update),
      relaunch: vi.fn(async () => undefined),
    });

    await expect(service.installAndRelaunch(update)).rejects.toThrow("network unavailable");
    expect(update.close).toHaveBeenCalledOnce();
  });

  it("reports an installed update that cannot restart", async () => {
    const update = availableUpdate();
    const service = createUpdateService({
      check: vi.fn(async () => update),
      relaunch: vi.fn(async () => {
        throw new Error("process permission denied");
      }),
    });

    await expect(service.installAndRelaunch(update)).rejects.toBeInstanceOf(UpdateRestartError);
  });
});
