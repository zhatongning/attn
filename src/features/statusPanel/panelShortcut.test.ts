import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_TOGGLE_SHORTCUT,
  DEFAULT_POSITION_CYCLE_SHORTCUT,
  capturePanelShortcut,
  formatPanelShortcut,
  normalizePanelToggleShortcut,
  normalizePositionCycleShortcut,
} from "./panelShortcut";

describe("panel shortcut contract", () => {
  it("normalizes missing and disabled position-cycle shortcuts independently", () => {
    expect(DEFAULT_POSITION_CYCLE_SHORTCUT).toBe("control+super+p");
    expect(normalizePositionCycleShortcut(undefined)).toBe("control+super+p");
    expect(normalizePositionCycleShortcut(null)).toBeNull();
    expect(normalizePositionCycleShortcut("CONTROL+SUPER+SHIFT+SPACE")).toBe("shift+control+super+space");
    expect(normalizePositionCycleShortcut("shift+p")).toBe("control+super+p");
  });
  it("uses the stable default and canonical modifier order", () => {
    expect(DEFAULT_PANEL_TOGGLE_SHORTCUT).toBe("control+super+9");
    expect(capturePanelShortcut({
      code: "Space",
      altKey: true,
      shiftKey: true,
      metaKey: true,
      ctrlKey: false,
      repeat: false,
    })).toEqual({ status: "captured", value: "shift+alt+super+space" });
  });

  it("records supported code names independently of keyboard layout", () => {
    expect(capturePanelShortcut(event("KeyA", { ctrlKey: true }))).toEqual({
      status: "captured",
      value: "control+a",
    });
    expect(capturePanelShortcut(event("Digit7", { altKey: true }))).toEqual({
      status: "captured",
      value: "alt+7",
    });
    expect(capturePanelShortcut(event("F20", { metaKey: true }))).toEqual({
      status: "captured",
      value: "super+f20",
    });
    expect(capturePanelShortcut(event("ArrowLeft", { shiftKey: true, altKey: true }))).toEqual({
      status: "captured",
      value: "shift+alt+left",
    });
  });

  it("cancels Escape and ignores invalid or repeated events", () => {
    expect(capturePanelShortcut(event("Escape"))).toEqual({ status: "cancelled" });
    expect(capturePanelShortcut(event("ShiftLeft", { shiftKey: true }))).toEqual({ status: "ignored" });
    expect(capturePanelShortcut(event("KeyA"))).toEqual({ status: "ignored" });
    expect(capturePanelShortcut(event("KeyA", { shiftKey: true }))).toEqual({ status: "ignored" });
    expect(capturePanelShortcut(event("F21", { metaKey: true }))).toEqual({ status: "ignored" });
    expect(capturePanelShortcut(event("Unknown", { altKey: true }))).toEqual({ status: "ignored" });
    expect(capturePanelShortcut(event("KeyA", { altKey: true, repeat: true }))).toEqual({ status: "ignored" });
  });

  it("normalizes only the canonical accelerator grammar", () => {
    expect(normalizePanelToggleShortcut(undefined)).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
    expect(normalizePanelToggleShortcut("not-a-shortcut")).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
    expect(normalizePanelToggleShortcut("")).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
    expect(normalizePanelToggleShortcut(42)).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
    expect(normalizePanelToggleShortcut(null)).toBeNull();
    expect(normalizePanelToggleShortcut("ALT+CONTROL+SUPER+P")).toBe("control+alt+super+p");
    expect(normalizePanelToggleShortcut("space")).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
    expect(normalizePanelToggleShortcut("shift+a")).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
    expect(normalizePanelToggleShortcut("super+f20")).toBe("super+f20");
    expect(normalizePanelToggleShortcut("super+f21")).toBe(DEFAULT_PANEL_TOGGLE_SHORTCUT);
  });

  it("formats canonical accelerators for display", () => {
    expect(formatPanelShortcut(DEFAULT_PANEL_TOGGLE_SHORTCUT)).toBe("Control-Command-9");
    expect(formatPanelShortcut(DEFAULT_POSITION_CYCLE_SHORTCUT)).toBe("Control-Command-P");
    expect(formatPanelShortcut("control+alt+super+left")).toBe("Option-Control-Command-Left");
    expect(formatPanelShortcut(null)).toBe("Disabled");
  });

  it("records the new defaults and preserves valid four-key saved shortcuts", () => {
    expect(capturePanelShortcut(event("Digit9", { ctrlKey: true, metaKey: true }))).toEqual({
      status: "captured",
      value: "control+super+9",
    });
    expect(capturePanelShortcut(event("KeyP", { ctrlKey: true, metaKey: true }))).toEqual({
      status: "captured",
      value: "control+super+p",
    });
    expect(normalizePanelToggleShortcut("shift+alt+super+space")).toBe("shift+alt+super+space");
    expect(normalizePositionCycleShortcut("shift+control+super+space")).toBe("shift+control+super+space");
  });
});

function event(
  code: string,
  overrides: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
  }> = {},
) {
  return {
    code,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  };
}
