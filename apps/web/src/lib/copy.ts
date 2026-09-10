"use client";

/**
 * Put text on the clipboard, and say whether it worked.
 *
 * Two paths, because the good one is not always there. `navigator.clipboard` exists only in a
 * secure context — HTTPS or localhost — and `next dev` prints a LAN address next to the local
 * one, so opening the app from a phone on the same network lands on plain http where the API is
 * `undefined` rather than merely denied. It can also reject on a permission prompt, or when the
 * document is not focused.
 *
 * The fallback is `execCommand("copy")`, which is deprecated and works everywhere the modern API
 * does not. It needs a real selection, hence the offscreen textarea.
 *
 * Returning a boolean rather than throwing is the point: a copy button that says "Copied" when
 * nothing was copied is worse than one that quietly does nothing, and the caller can only tell
 * the truth if it is told which happened.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through. A rejection here is normal — denied permission, or an unfocused document.
  }

  try {
    const holder = document.createElement("textarea");
    holder.value = text;
    holder.setAttribute("readonly", "");
    // Offscreen rather than hidden: `display:none` cannot hold a selection, and scrolling the
    // page to a focused element is the other way this trick becomes visible.
    holder.style.position = "fixed";
    holder.style.top = "0";
    holder.style.left = "-9999px";
    holder.style.opacity = "0";
    document.body.appendChild(holder);

    const selection = document.getSelection();
    const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    holder.select();
    const copied = document.execCommand("copy");

    document.body.removeChild(holder);
    // Put back whatever the reader had selected before the button stole it.
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    return copied;
  } catch {
    return false;
  }
}
