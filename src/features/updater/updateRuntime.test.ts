import { describe, expect, it } from "vitest";
import { shouldCheckForUpdates } from "./updateRuntime";

describe("shouldCheckForUpdates", () => {
  it("requires both a production build and the Tauri runtime", () => {
    expect(shouldCheckForUpdates(true, true)).toBe(true);
    expect(shouldCheckForUpdates(true, false)).toBe(false);
    expect(shouldCheckForUpdates(false, true)).toBe(false);
    expect(shouldCheckForUpdates(false, false)).toBe(false);
  });
});
