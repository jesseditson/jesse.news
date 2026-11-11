const loadedAt = Date.now();
const FAILED = "That didn't go through. Try again in a bit.";

interface ContactResult {
  ok: boolean;
  message?: string;
}

export function initContact(): void {
  document.addEventListener("submit", async (event) => {
    const form = (event.target as Element | null)?.closest<HTMLFormElement>("[data-contact-form]");
    if (!form) return;
    event.preventDefault();

    const status = form.querySelector<HTMLElement>("[data-contact-status]");
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const data = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      if (typeof value === "string") data.append(key, value);
    }
    data.set("_js", "1");
    data.set("_t", String(loadedAt));

    const report = (message: string, kind: "" | "ok" | "error") => {
      if (!status) return;
      status.textContent = message;
      status.dataset.kind = kind;
    };

    if (button) button.disabled = true;
    report("Sending…", "");
    try {
      const response = await fetch(form.action, { method: "POST", body: data, headers: { accept: "application/json" } });
      const result: ContactResult = await response.json().catch(() => ({ ok: false, message: FAILED }));
      report(result.message || (result.ok ? "Sent." : FAILED), result.ok ? "ok" : "error");
      if (result.ok) form.reset();
    } catch {
      report(FAILED, "error");
    } finally {
      if (button) button.disabled = false;
    }
  });
}
