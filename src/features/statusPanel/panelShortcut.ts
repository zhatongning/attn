export const DEFAULT_PANEL_TOGGLE_SHORTCUT = "shift+alt+super+space" as const;

export interface PanelShortcutKeyboardEvent {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export type PanelShortcutCapture =
  | { status: "captured"; value: string }
  | { status: "cancelled" }
  | { status: "ignored" };

const modifierCodes = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

const navigationKeys: Record<string, string> = {
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  Backspace: "backspace",
  Delete: "delete",
  End: "end",
  Home: "home",
  Insert: "insert",
  PageDown: "pagedown",
  PageUp: "pageup",
  Enter: "enter",
  Tab: "tab",
};

const canonicalModifiers = ["shift", "control", "alt", "super"] as const;
const displayModifiers = ["alt", "shift", "control", "super"] as const;
const modifierDisplayNames: Record<(typeof displayModifiers)[number], string> = {
  alt: "Option",
  shift: "Shift",
  control: "Control",
  super: "Command",
};

export function capturePanelShortcut(event: PanelShortcutKeyboardEvent): PanelShortcutCapture {
  if (event.code === "Escape") return { status: "cancelled" };
  if (event.repeat || modifierCodes.has(event.code)) return { status: "ignored" };

  const key = keyNameForCode(event.code);
  if (!key) return { status: "ignored" };

  const modifiers = canonicalModifiers.filter((modifier) => {
    if (modifier === "shift") return event.shiftKey;
    if (modifier === "control") return event.ctrlKey;
    if (modifier === "alt") return event.altKey;
    return event.metaKey;
  });
  if (!event.altKey && !event.ctrlKey && !event.metaKey) return { status: "ignored" };

  return { status: "captured", value: [...modifiers, key].join("+") };
}

export function normalizePanelToggleShortcut(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return DEFAULT_PANEL_TOGGLE_SHORTCUT;

  const normalized = normalizeShortcutString(value);
  return normalized ?? DEFAULT_PANEL_TOGGLE_SHORTCUT;
}

export function formatPanelShortcut(value: string | null): string {
  if (value === null) return "Disabled";

  const normalized = normalizeShortcutString(value);
  if (!normalized) return "Disabled";

  const parts = normalized.split("+");
  const key = parts.pop()!;
  const modifierNames = parts
    .sort((left, right) => displayModifiers.indexOf(left as typeof displayModifiers[number])
      - displayModifiers.indexOf(right as typeof displayModifiers[number]))
    .map((modifier) => modifierDisplayNames[modifier as typeof displayModifiers[number]]);
  return [...modifierNames, titleCase(key)].join("-");
}

function keyNameForCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|20)$/.test(code)) return code.toLowerCase();
  if (code === "Space") return "space";
  return navigationKeys[code] ?? null;
}

function normalizeShortcutString(value: string): string | null {
  const tokens = value.trim().toLowerCase().split("+");
  if (tokens.length < 2 || tokens.some((token) => token.length === 0)) return null;

  const key = tokens.pop()!;
  if (!isShortcutKey(key)) return null;

  const modifiers = tokens as string[];
  if (modifiers.length === 0 || modifiers.some((modifier) => !canonicalModifiers.includes(modifier as typeof canonicalModifiers[number]))) {
    return null;
  }
  if (new Set(modifiers).size !== modifiers.length) return null;
  if (!modifiers.some((modifier) => modifier === "alt" || modifier === "control" || modifier === "super")) return null;

  const orderedModifiers = canonicalModifiers.filter((modifier) => modifiers.includes(modifier));
  return [...orderedModifiers, key].join("+");
}

function isShortcutKey(value: string): boolean {
  return /^[a-z]$/.test(value)
    || /^[0-9]$/.test(value)
    || /^f(?:[1-9]|1[0-9]|20)$/.test(value)
    || [
      "space",
      "down",
      "left",
      "right",
      "up",
      "backspace",
      "delete",
      "end",
      "enter",
      "home",
      "insert",
      "pagedown",
      "pageup",
      "tab",
    ].includes(value);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
