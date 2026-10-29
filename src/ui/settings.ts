/**
 * The in-game settings: the persisted store (`SettingsStore`) and its dialog (`SettingsModal`).
 *
 * Two halves, deliberately separated:
 *
 * - The **store** is DOM-free and total. It reads and writes `localStorage["sahkku_settings"]` through
 *   a two-method {@link StorageLike} seam, normalizes everything it reads (a hand-edited or hostile
 *   value can only ever produce a usable setting), and falls back to memory when storage is missing,
 *   disabled or full — private browsing is a supported configuration, not an error state.
 * - The **modal** is pure DOM. It renders the store's current values, validates nothing itself (the
 *   store does), and writes through `store.update`, so the persisted shape has exactly one author.
 *
 * The endpoint/model/timeout triple is what the LLM seat is configured from: {@link llmConfigFrom}
 * turns a loaded setting into an `LlmConfig`, which is the "settings reach the active agent" link the
 * task's storage test asserts.
 */

import { LlmConfig } from "../agents/llm";
import { DefaultLocale, type Locale, type Translator, normalizeLocale } from "../locale/i18n";
import { createOverlay, dismissOnBackdropAndEscape, focusableActiveElement } from "./dialog";

// ----------------------------------------------------------------------------------------------
// The persisted shape
// ----------------------------------------------------------------------------------------------

/** The `localStorage` key the client owns. */
export const SettingsStorageKey = "sahkku_settings";

/**
 * Everything the client persists, in the units the UI speaks: volumes are percentages (`0..100`) and
 * the LLM timeout is in seconds, so the stored JSON stays hand-editable and matches the dialog.
 *
 * Match *setup* (mode, bot kind, variant, speeds) is deliberately absent: those are per-match choices
 * the toolbar owns, while this file owns the preferences that outlive a match.
 */
export interface SahkkuSettings {
  /** The chosen UI language. */
  locale: Locale;

  /** OpenAI-compatible chat-completions URL the LLM seat posts to. */
  llmEndpoint: string;

  /** Model name sent as the request's `model` field. */
  llmModel: string;

  /** Per-request deadline in seconds before the NPC falls back to the heuristic. */
  llmTimeoutSeconds: number;

  /** Master volume, percent. */
  masterVolume: number;

  /** Sound-effects volume, percent. */
  sfxVolume: number;

  /** Silences every cue regardless of the two volumes. */
  muted: boolean;

  /** Show a notice when an LLM seat gives up and plays the heuristic move instead. */
  notifyOnFallback: boolean;
}

/** The shipped defaults, i.e. the values a first-time player starts from. */
export const DefaultSettings: SahkkuSettings = {
  locale: DefaultLocale,
  llmEndpoint: LlmConfig.DefaultEndpointUrl,
  llmModel: LlmConfig.DefaultModelName,
  llmTimeoutSeconds: Math.round(LlmConfig.DefaultRequestTimeoutMs / 1000),
  masterVolume: 100,
  sfxVolume: 70,
  muted: false,
  notifyOnFallback: true,
};

/** The two methods of `Storage` this module uses, so a test (or a headless host) can stand in. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The platform's `localStorage`, or `null` when it is missing or throws on access. */
function defaultStorage(): StorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: StorageLike | null }).localStorage;
    if (candidate == null) return null;
    // Touching the storage is the only reliable probe: some browsers throw on the getter itself.
    candidate.getItem(SettingsStorageKey);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Reads any value into a complete, usable setting. Total by construction: a value of the wrong type,
 * an out-of-range number or an unknown locale is replaced by that field's default, never by an error.
 * Callers pass the parsed JSON, `null`, or a partial object.
 */
export function normalizeSettings(raw: unknown): SahkkuSettings {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    locale: normalizeLocale(typeof source["locale"] === "string" ? (source["locale"] as string) : null),
    llmEndpoint: normalizeEndpointUrl(readString(source["llmEndpoint"])),
    llmModel: normalizeModelName(readString(source["llmModel"])),
    llmTimeoutSeconds: clampTimeout(readNumber(source["llmTimeoutSeconds"])),
    masterVolume: clampPercent(readNumber(source["masterVolume"]), DefaultSettings.masterVolume),
    sfxVolume: clampPercent(readNumber(source["sfxVolume"]), DefaultSettings.sfxVolume),
    muted: readBoolean(source["muted"], DefaultSettings.muted),
    notifyOnFallback: readBoolean(source["notifyOnFallback"], DefaultSettings.notifyOnFallback),
  };
}

/**
 * The `LlmConfig` a seat plays with. The endpoint is already normalized by the settings store, and the
 * second-resolution timeout in the dialog is converted back to the milliseconds the transport wants.
 */
export function llmConfigFrom(settings: SahkkuSettings): LlmConfig {
  return new LlmConfig({
    endpointUrl: settings.llmEndpoint,
    modelName: settings.llmModel,
    requestTimeoutMs: Math.round(settings.llmTimeoutSeconds * 1000),
  });
}

/**
 * Normalizes an endpoint the way the transport needs it: a bare base URL such as
 * `http://localhost:1234/v1` gains the `/chat/completions` path, an empty value becomes the default.
 *
 * (`src/agents/config.ts` does the same job for the Node tooling, but that module reads the filesystem
 * and therefore cannot be part of the browser bundle.)
 */
export function normalizeEndpointUrl(endpoint: string | null | undefined): string {
  let value = endpoint == null ? "" : endpoint.trim();
  if (value.length === 0) return LlmConfig.DefaultEndpointUrl;

  if (value.toLowerCase().endsWith("/chat/completions")) return value;

  if (/(?:^|\/)v1\/?$/i.test(value)) {
    return `${value.replace(/\/+$/, "")}/chat/completions`;
  }

  try {
    const url = new URL(value);
    if (url.pathname === "" || url.pathname === "/") {
      return `${value.replace(/\/+$/, "")}/v1/chat/completions`;
    }
  } catch {
    if (/^https?:\/\/[^/]+\/?$/i.test(value)) {
      return `${value.replace(/\/+$/, "")}/v1/chat/completions`;
    }
  }

  return value;
}

/** Trims a model name, falling back to the shipped default when it is empty. */
export function normalizeModelName(model: string | null | undefined): string {
  const value = model == null ? "" : model.trim();
  return value.length === 0 ? LlmConfig.DefaultModelName : value;
}

// ----------------------------------------------------------------------------------------------
// The store
// ----------------------------------------------------------------------------------------------

/**
 * The client's settings, read once and written back on every change.
 *
 * A missing, unreadable or hand-broken stored value is not an error: the store keeps working from the
 * defaults and simply writes the repaired value on the next save. If `localStorage` is disabled the
 * store keeps the same object in memory (`persistent` reports which one happened), so the dialog keeps
 * behaving like a dialog — it just forgets on reload.
 */
export class SettingsStore {
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly listeners = new Set<(settings: SahkkuSettings) => void>();

  private current: SahkkuSettings;

  constructor(storage: StorageLike | null | undefined = undefined, storageKey: string = SettingsStorageKey) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.storageKey = storageKey;
    this.current = this.readFromStorage();
  }

  /** The live settings. Read it; never mutate it — go through `update`/`save`. */
  get settings(): SahkkuSettings {
    return this.current;
  }

  /** False when the client is running from memory alone (storage missing, disabled or full). */
  get persistent(): boolean {
    return this.storage != null;
  }

  /** Replaces the whole setting (normalized first), persists it and notifies subscribers. */
  save(settings: SahkkuSettings | Partial<SahkkuSettings>): SahkkuSettings {
    this.current = normalizeSettings({ ...this.current, ...settings });
    this.writeToStorage(this.current);
    for (const listener of [...this.listeners]) listener(this.current);
    return this.current;
  }

  /** Alias of {@link save} for the common "change one field" call. */
  update(partial: Partial<SahkkuSettings>): SahkkuSettings {
    return this.save(partial);
  }

  /** Registers a change listener; returns the unsubscribe function. */
  subscribe(listener: (settings: SahkkuSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readFromStorage(): SahkkuSettings {
    if (this.storage == null) return normalizeSettings(null);

    let text: string | null = null;
    try {
      text = this.storage.getItem(this.storageKey);
    } catch {
      return normalizeSettings(null);
    }
    if (text == null || text.trim().length === 0) return normalizeSettings(null);

    try {
      return normalizeSettings(JSON.parse(text));
    } catch {
      return normalizeSettings(null);
    }
  }

  private writeToStorage(settings: SahkkuSettings): void {
    if (this.storage == null) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(settings, null, 2));
    } catch {
      // Quota, private-mode refusals and read-only storage all land here: the in-memory copy stands.
    }
  }
}

// ----------------------------------------------------------------------------------------------
// The dialog
// ----------------------------------------------------------------------------------------------

export interface SettingsModalInit {  /** Where the dialog is mounted, e.g. `#dialog-root`. */
  container: HTMLElement;

  /** The store the dialog reads and writes. */
  store: SettingsStore;

  /** The active language. */
  translate: Translator;

  /** Called after a save, with the freshly persisted settings. */
  onSave?: ((settings: SahkkuSettings) => void) | null;
}

/**
 * The settings dialog: LLM endpoint, model, request timeout, the two volume sliders and the two
 * checkboxes, in a modal overlay.
 *
 * Every value is edited in the DOM and only written on **Save**, so a half-typed endpoint never reaches
 * a running match. `refresh()` re-labels the open dialog in a new language without losing what the
 * player has typed; `close()` discards the draft.
 */
export class SettingsModal {
  private readonly container: HTMLElement;
  private readonly store: SettingsStore;
  private readonly onSave: ((settings: SahkkuSettings) => void) | null;

  private translate: Translator;
  private overlay: HTMLElement | null = null;
  private restoreFocusTo: HTMLElement | null = null;

  constructor(init: SettingsModalInit) {
    this.container = init.container;
    this.store = init.store;
    this.translate = init.translate;
    this.onSave = init.onSave ?? null;
  }

  get isOpen(): boolean {
    return this.overlay != null;
  }

  /** Uses `translator` for every subsequent render (and repaints now, if the dialog is open). */
  setTranslator(translator: Translator): void {
    this.translate = translator;
    if (this.isOpen) this.render();
  }

  /** Mounts the dialog with the store's current values. Idempotent. */
  open(): void {
    if (this.isOpen) return;

    const doc = this.container.ownerDocument;
    this.restoreFocusTo = focusableActiveElement(doc);

    const overlay = createOverlay(doc, "settings", this.translate("settings.label"));
    this.container.appendChild(overlay);
    this.overlay = overlay;
    this.render();
  }

  /** Unmounts the dialog, discarding any unsaved edit. Idempotent. */
  close(): void {
    const overlay = this.overlay;
    if (overlay == null) return;

    overlay.remove();
    this.overlay = null;

    const target = this.restoreFocusTo;
    this.restoreFocusTo = null;
    target?.focus();
  }

  // ------------------------------------------------------------------ rendering

  /** Rebuilds the dialog from the store's values and the current translator. */
  private render(): void {
    const overlay = this.overlay;
    if (overlay == null) return;

    const doc = overlay.ownerDocument;
    const t = this.translate;
    overlay.textContent = "";

    const card = doc.createElement("form");
    card.className = "modal-card modal-card--form";
    card.setAttribute("novalidate", "");
    card.addEventListener("submit", (event) => {
      event.preventDefault();
      this.commit();
    });

    const title = doc.createElement("h2");
    title.className = "modal-title";
    title.textContent = t("settings.title");
    overlay.setAttribute("aria-label", t("settings.label"));
    card.appendChild(title);

    const values = this.store.settings;

    card.appendChild(
      fieldset(doc, t("settings.llm.section"), [
        textField(doc, "endpoint", t("settings.llm.endpoint"), values.llmEndpoint, t("settings.llm.endpointHint")),
        textField(doc, "model", t("settings.llm.model"), values.llmModel, t("settings.llm.modelHint")),
        numberField(
          doc,
          "timeout",
          t("settings.llm.timeout"),
          values.llmTimeoutSeconds,
          t("settings.llm.timeoutHint"),
        ),
        checkboxField(doc, "fallback-notice", t("settings.llm.fallbackNotice"), values.notifyOnFallback),
        testConnectionRow(doc, t, async (statusEl) => {
          const endpointInput = overlay.querySelector<HTMLInputElement>('[name="endpoint"]');
          const modelInput = overlay.querySelector<HTMLInputElement>('[name="model"]');
          const timeoutInput = overlay.querySelector<HTMLInputElement>('[name="timeout"]');

          const endpoint = normalizeEndpointUrl(endpointInput?.value);
          const model = modelInput?.value?.trim() ?? "";
          const timeout = Number(timeoutInput?.value) || 10;

          statusEl.textContent = t("settings.llm.testing");
          statusEl.className = "field-hint";

          const result = await probeLlmConnection(endpoint, model, timeout);
          if (result.ok) {
            statusEl.textContent = `✓ ${result.message}`;
            statusEl.className = "field-hint field-hint--success";
          } else {
            statusEl.textContent = `✗ ${result.message}`;
            statusEl.className = "field-hint field-hint--error";
          }
        }),
      ]),
    );

    card.appendChild(
      fieldset(doc, t("settings.audio.section"), [
        rangeField(doc, "master-volume", t("settings.audio.masterVolume"), values.masterVolume),
        rangeField(doc, "sfx-volume", t("settings.audio.sfxVolume"), values.sfxVolume),
        checkboxField(doc, "mute", t("settings.audio.mute"), values.muted),
        hint(doc, t("settings.audio.hint")),
      ]),
    );

    const actions = doc.createElement("div");
    actions.className = "modal-actions";

    const save = doc.createElement("button");
    save.type = "submit";
    save.className = "button button--primary";
    save.dataset["action"] = "save";
    save.textContent = t("settings.save");

    const close = doc.createElement("button");
    close.type = "button";
    close.className = "button button--ghost";
    close.dataset["action"] = "close";
    close.textContent = t("settings.close");
    close.addEventListener("click", () => {
      this.close();
    });

    actions.append(save, close);
    card.appendChild(actions);
    overlay.appendChild(card);

    dismissOnBackdropAndEscape(overlay, card, () => {
      this.close();
    });

    const first = overlay.querySelector<HTMLInputElement>("input");
    if (first != null) first.focus();
  }

  /** Writes the dialog's values through the store and reports them to the caller. */
  private commit(): void {
    const overlay = this.overlay;
    if (overlay == null) return;

    const read = (name: string): HTMLInputElement | null =>
      overlay.querySelector<HTMLInputElement>(`[name="${name}"]`);

    const settings = this.store.save({
      llmEndpoint: read("endpoint")?.value ?? this.store.settings.llmEndpoint,
      llmModel: read("model")?.value ?? this.store.settings.llmModel,
      llmTimeoutSeconds: Number(read("timeout")?.value ?? this.store.settings.llmTimeoutSeconds),
      masterVolume: Number(read("master-volume")?.value ?? this.store.settings.masterVolume),
      sfxVolume: Number(read("sfx-volume")?.value ?? this.store.settings.sfxVolume),
      muted: read("mute")?.checked ?? this.store.settings.muted,
      notifyOnFallback: read("fallback-notice")?.checked ?? this.store.settings.notifyOnFallback,
    });

    this.onSave?.(settings);
    this.close();
  }
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  models?: string[];
}

/** Probes an LLM endpoint with a short timeout to verify connectivity and discover available models. */
export async function probeLlmConnection(
  endpointUrl: string,
  modelName: string,
  timeoutSeconds = 10,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Connection timed out")), timeoutSeconds * 1000);

  let modelsUrl: string | null = null;
  if (/\/chat\/completions\/?$/i.test(endpointUrl)) {
    modelsUrl = endpointUrl.replace(/\/chat\/completions\/?$/i, "/models");
  } else if (/\/v1\/?$/i.test(endpointUrl)) {
    modelsUrl = `${endpointUrl.replace(/\/+$/, "")}/models`;
  }

  try {
    if (modelsUrl != null) {
      try {
        const response = await fetch(modelsUrl, {
          method: "GET",
          signal: controller.signal,
        });
        if (response.ok) {
          const data = (await response.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
          const modelList: string[] = [];
          if (Array.isArray(data.data)) {
            for (const item of data.data) {
              if (item.id) modelList.push(item.id);
            }
          } else if (Array.isArray(data.models)) {
            for (const item of data.models) {
              if (item.name) modelList.push(item.name);
            }
          }
          clearTimeout(timer);
          return {
            ok: true,
            message: modelList.length > 0 ? `Connected! Models: ${modelList.join(", ")}` : "Connected to server!",
            models: modelList,
          };
        }
      } catch {
        // Fall back to POST probe below
      }
    }

    const probeBody: Record<string, unknown> = {
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    };
    if (modelName.trim().length > 0) {
      probeBody.model = modelName.trim();
    }

    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(probeBody),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.ok) {
      return { ok: true, message: "Connected! Endpoint answered successfully." };
    }
    const errorText = await response.text().catch(() => "");
    return {
      ok: false,
      message: `HTTP ${response.status}${response.statusText ? " " + response.statusText : ""}${errorText ? `: ${errorText.slice(0, 80)}` : ""}`,
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function testConnectionRow(
  doc: Document,
  t: Translator,
  onTest: (statusEl: HTMLElement) => void,
): HTMLElement {
  const row = doc.createElement("div");
  row.className = "field";

  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "button button--secondary";
  btn.dataset["action"] = "test-connection";
  btn.textContent = t("settings.llm.testConnection");

  const status = doc.createElement("div");
  status.className = "field-hint";
  status.dataset["status"] = "test-connection";

  btn.addEventListener("click", () => {
    onTest(status);
  });

  row.append(btn, status);
  return row;
}

// ----------------------------------------------------------------------------------------------
// form helpers
// ----------------------------------------------------------------------------------------------

function fieldset(doc: Document, legendText: string, controls: HTMLElement[]): HTMLFieldSetElement {
  const group = doc.createElement("fieldset");
  group.className = "form-group";

  const legend = doc.createElement("legend");
  legend.className = "form-group-title";
  legend.textContent = legendText;

  group.appendChild(legend);
  for (const control of controls) group.appendChild(control);
  return group;
}

function fieldRow(doc: Document, labelText: string, control: HTMLElement, name: string): HTMLElement {
  const row = doc.createElement("div");
  row.className = "field";

  const label = doc.createElement("label");
  label.className = "field-label";
  label.setAttribute("for", `settings-${name}`);
  label.textContent = labelText;

  control.id = `settings-${name}`;
  row.append(label, control);
  return row;
}

function textField(
  doc: Document,
  name: string,
  label: string,
  value: string,
  description: string,
): HTMLElement {
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "field-input";
  input.name = name;
  input.value = value;
  input.autocomplete = "off";
  input.spellcheck = false;

  const row = fieldRow(doc, label, input, name);
  row.appendChild(hint(doc, description));
  return row;
}

function numberField(
  doc: Document,
  name: string,
  label: string,
  value: number,
  description: string,
): HTMLElement {
  const input = doc.createElement("input");
  input.type = "number";
  input.className = "field-input";
  input.name = name;
  input.value = String(value);
  input.min = "1";
  input.max = "600";
  input.step = "1";

  const row = fieldRow(doc, label, input, name);
  row.appendChild(hint(doc, description));
  return row;
}

function rangeField(doc: Document, name: string, label: string, value: number): HTMLElement {
  const input = doc.createElement("input");
  input.type = "range";
  input.className = "field-range";
  input.name = name;
  input.min = "0";
  input.max = "100";
  input.step = "1";
  input.value = String(value);

  const output = doc.createElement("output");
  output.className = "field-output";
  output.setAttribute("for", `settings-${name}`);
  output.textContent = `${value}%`;
  input.addEventListener("input", () => {
    output.textContent = `${input.value}%`;
  });

  const row = fieldRow(doc, label, input, name);
  row.appendChild(output);
  return row;
}

function checkboxField(doc: Document, name: string, label: string, checked: boolean): HTMLElement {
  const row = doc.createElement("div");
  row.className = "field field--checkbox";

  const input = doc.createElement("input");
  input.type = "checkbox";
  input.className = "field-checkbox";
  input.name = name;
  input.id = `settings-${name}`;
  input.checked = checked;

  const text = doc.createElement("label");
  text.className = "field-label field-label--inline";
  text.setAttribute("for", `settings-${name}`);
  text.textContent = label;

  row.append(input, text);
  return row;
}

function hint(doc: Document, text: string): HTMLElement {
  const node = doc.createElement("p");
  node.className = "field-hint";
  node.textContent = text;
  return node;
}

// ----------------------------------------------------------------------------------------------
// normalization helpers
// ----------------------------------------------------------------------------------------------

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampPercent(value: number | null, fallback: number): number {
  if (value == null) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function clampTimeout(value: number | null): number {
  if (value == null || value <= 0) return DefaultSettings.llmTimeoutSeconds;
  return Math.min(600, Math.max(1, Math.round(value)));
}
