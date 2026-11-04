import type { Translator } from "../locale/i18n";

type DisplayMode = "window" | "fullscreen";

export function setupDisplayModes(
  doc: Document,
  fullscreenButton: HTMLElement,
  windowButton: HTMLElement,
  translate: Translator,
): () => void {
  const root = doc.documentElement;
  let mode: DisplayMode | null = null;
  let pending = false;
  const controls = [
    [fullscreenButton, "fullscreen", "menu.fullscreen", "menu.exitFullscreen"],
    [windowButton, "window", "menu.fillWindow", "menu.exitFillWindow"],
  ] as const;

  const updateLabels = (): void => {
    for (const [button, target, enterLabel, exitLabel] of controls) {
      const active = mode === target;
      const label = translate(active ? exitLabel : enterLabel);
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", String(active));
    }
  };

  const setMode = (value: DisplayMode | null): void => {
    mode = value;
    root.classList.toggle("is-expanded", mode != null);
    root.classList.toggle("is-fullscreen", mode === "fullscreen");
    updateLabels();
  };

  const leaveNativeFullscreen = (): void => {
    if (doc.fullscreenElement === root) {
      void doc.exitFullscreen().catch(() => undefined);
    }
  };

  const exit = (): void => {
    const button = mode === "window" ? windowButton : fullscreenButton;
    setMode(null);
    leaveNativeFullscreen();
    button.focus({ preventScroll: true });
  };

  for (const [button, target] of controls) {
    button.addEventListener("click", async () => {
      if (mode != null) {
        if (mode === target) exit();
        return;
      }
      if (pending) return;
      setMode(target);
      if (target === "window" || typeof root.requestFullscreen !== "function") return;

      pending = true;
      try {
        await root.requestFullscreen();
      } catch {
        return;
      } finally {
        pending = false;
      }
    });
  }

  doc.addEventListener("fullscreenchange", () => {
    if (doc.fullscreenElement === root) {
      if (mode !== "fullscreen") leaveNativeFullscreen();
    } else if (mode === "fullscreen") {
      exit();
    }
  });
  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mode != null) exit();
  });

  updateLabels();
  return updateLabels;
}