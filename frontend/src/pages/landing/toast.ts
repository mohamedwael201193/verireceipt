// Minimal toast bus: any landing component calls toast(msg); the Landing
// page renders the toast element and listens for the event.
export function toast(message: string): void {
  window.dispatchEvent(new CustomEvent<string>("vr-toast", { detail: message }));
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast("Copied to clipboard");
    } catch {
      toast("Copy unavailable");
    }
  }
}
