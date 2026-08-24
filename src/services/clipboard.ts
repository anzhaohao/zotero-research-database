/** Copy plain text using Zotero's privileged helper before browser fallbacks. */
export async function copyPlainText(
  value: string,
  document?: Document | null,
): Promise<boolean> {
  if (!value) return false;

  const zoteroCopy = (globalThis as any).Zotero?.Utilities?.Internal
    ?.copyTextToClipboard;
  if (typeof zoteroCopy === "function") {
    try {
      await Promise.resolve(
        zoteroCopy.call((globalThis as any).Zotero.Utilities.Internal, value),
      );
      return true;
    } catch {
      // Continue to the real browser clipboard when the privileged helper fails.
    }
  }

  const navigator = document?.defaultView?.navigator;
  if (typeof navigator?.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // A denied browser clipboard is allowed to use the textarea fallback.
    }
  }

  if (!document?.body || typeof document.execCommand !== "function") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
