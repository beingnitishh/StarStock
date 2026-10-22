const NON_TYPING_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isEditableElement(el: unknown): boolean {
  if (!el || typeof el !== "object") return false;
  const node = el as Partial<HTMLElement> & {
    tagName?: string;
    type?: string;
    closest?: (selector: string) => unknown;
  };
  const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const inputType = typeof node.type === "string" ? node.type.toLowerCase() : "text";
    return !NON_TYPING_INPUT_TYPES.has(inputType || "text");
  }
  if (node.isContentEditable) return true;
  if (
    typeof node.closest === "function" &&
    node.closest(
      '[contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"]',
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Returns true when the user is typing in or interacting with an input,
 * textarea, select, or contenteditable element, so single-key navigation
 * shortcuts (D / I / T / W) never interfere with text entry.
 */
export function isTypingTarget(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  if (isEditableElement(event.target)) return true;
  if (typeof document !== "undefined" && isEditableElement(document.activeElement)) {
    return true;
  }
  return false;
}

/**
 * Returns true when any modal dialog is currently open in the document.
 */
export function isModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * Matches `Alt + <letter>` (Alt on Windows/Linux, Option on macOS) without
 * Ctrl, Cmd, Shift, or AltGr. Falls back to physical `event.code` when macOS
 * Option produces a special symbol or dead key (e.g. Option+S → "ß",
 * Option+A → "å", Option+I → "Dead", Option+O → "ø").
 */
export function matchesAltKey(event: KeyboardEvent, letter: string): boolean {
  if (event.defaultPrevented || event.repeat) return false;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (typeof event.getModifierState === "function" && event.getModifierState("AltGraph")) {
    return false;
  }
  const target = letter.toLowerCase();
  if (/^[a-z]$/i.test(event.key)) {
    return event.key.toLowerCase() === target;
  }
  return event.code === `Key${target.toUpperCase()}`;
}

/**
 * Matches an unmodified single-letter shortcut (no Alt, Ctrl, or Cmd held).
 */
export function matchesPlainKey(event: KeyboardEvent, letter: string): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return event.key.toLowerCase() === letter.toLowerCase();
}
