/**
 * Settings tests — `T4_SETTINGS_STORAGE`.
 *
 * The store is exercised through its own two-method `StorageLike` seam, which is what makes the
 * interesting cases reachable in plain Node: a working store, a store whose backend is missing, and a
 * backend that refuses to write (private browsing, full quota) all have to end in a usable setting.
 *
 * The last test closes the loop the contract asks for — a saved endpoint/model/timeout reaching the
 * agent that plays the NPC — by building the `LlmConfig` out of the loaded settings.
 */

import { describe, expect, it } from "vitest";

import { LlmConfig } from "../../src/agents/llm";
import { HelpModal } from "../../src/ui/help";
import {
  DefaultSettings,
  SettingsModal,
  SettingsStorageKey,
  SettingsStore,
  llmConfigFrom,
  normalizeEndpointUrl,
  normalizeModelName,
  normalizeSettings,
  probeLlmConnection,
  type SahkkuSettings,
  type StorageLike,
} from "../../src/ui/settings";

// ---------------------------------------------------------------------------------- doubles

/** A stand-in for `localStorage` that records what it was asked to store. */
class FakeStorage implements StorageLike {
  readonly entries = new Map<string, string>();
  writes = 0;
  reads = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.entries.set(key, value);
  }

  getItem(key: string): string | null {
    this.reads++;
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes++;
    this.entries.set(key, value);
  }

  /** What a hand-edited or hostile stored value looks like. */
  get raw(): string | undefined {
    return this.entries.get(SettingsStorageKey);
  }
}

/** Storage that refuses every write, the way a private window or a full quota does. */
class ReadOnlyStorage implements StorageLike {
  readonly entries: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.entries[key] ?? null;
  }

  setItem(_key: string, _value: string): void {
    throw new Error("QuotaExceededError");
  }
}

/** Storage that throws on read as well, the way a browser with storage disabled does. */
class BrokenStorage implements StorageLike {
  getItem(_key: string): string | null {
    throw new Error("SecurityError");
  }

  setItem(_key: string, _value: string): void {
    throw new Error("SecurityError");
  }
}

// ---------------------------------------------------------------------------------- tests

describe("SettingsStore (T4_SETTINGS_STORAGE)", () => {
  it("starts from the shipped defaults when nothing has been saved", () => {
    const storage = new FakeStorage();
    const store = new SettingsStore(storage);

    expect(store.settings).toEqual(DefaultSettings);
    expect(store.persistent).toBe(true);
    expect(storage.reads).toBeGreaterThan(0);
    expect(storage.raw).toBeUndefined();
  });

  it("persists under `sahkku_settings` and round-trips through a fresh store", () => {
    const storage = new FakeStorage();
    const store = new SettingsStore(storage);

    const saved = store.save({
      locale: "se",
      llmEndpoint: "http://localhost:8080/v1",
      llmModel: "sahkku-local",
      llmTimeoutSeconds: 12,
      masterVolume: 55,
      sfxVolume: 33,
      muted: true,
      notifyOnFallback: false,
    });

    // The click-through endpoint is normalized on the way in, so the stored value is post-ready.
    expect(saved.llmEndpoint).toBe("http://localhost:8080/v1/chat/completions");
    expect(storage.raw).toBeDefined();

    const reloaded = new SettingsStore(storage).settings;
    expect(reloaded).toEqual(saved);
    expect(reloaded.locale).toBe("se");
    expect(reloaded.llmModel).toBe("sahkku-local");
    expect(reloaded.llmTimeoutSeconds).toBe(12);
    expect(reloaded.masterVolume).toBe(55);
    expect(reloaded.sfxVolume).toBe(33);
    expect(reloaded.muted).toBe(true);
    expect(reloaded.notifyOnFallback).toBe(false);
  });

  it("keeps the stored JSON readable: one object, with the values the dialog speaks", () => {
    const storage = new FakeStorage();
    new SettingsStore(storage).save({ sfxVolume: 40 });

    const text = storage.raw!;
    expect(text.startsWith("{")).toBe(true);
    expect(text.endsWith("}")).toBe(true);
    // Indented, so a curious player can read and hand-edit it.
    expect(text.split("\n").length).toBeGreaterThan(2);
    expect(JSON.parse(text)).toMatchObject({ sfxVolume: 40, masterVolume: 100 });
  });

  it("repairs a stored value that is broken, out of range or of the wrong type", () => {
    const broken = [
      "not json at all",
      "[]",
      "null",
      '"a string"',
      JSON.stringify({ locale: "klingon", llmEndpoint: 42, masterVolume: 500, sfxVolume: -9 }),
      JSON.stringify({ llmTimeoutSeconds: 0, muted: "yes", notifyOnFallback: 1 }),
    ];

    for (const text of broken) {
      const settings = normalizeSettings(safeParse(text));
      expect(settings.locale).toBe("en");
      expect(settings.llmEndpoint).toBe(DefaultSettings.llmEndpoint);
      expect(settings.llmModel).toBe(DefaultSettings.llmModel);
      expect(settings.llmTimeoutSeconds).toBeGreaterThan(0);
      expect(settings.masterVolume).toBeGreaterThanOrEqual(0);
      expect(settings.masterVolume).toBeLessThanOrEqual(100);
      expect(settings.sfxVolume).toBeGreaterThanOrEqual(0);
      expect(typeof settings.muted).toBe("boolean");
      expect(typeof settings.notifyOnFallback).toBe("boolean");
    }

    // Out-of-range numbers are clamped rather than rejected, so a slider can never wedge the client.
    expect(normalizeSettings({ masterVolume: 500 }).masterVolume).toBe(100);
    expect(normalizeSettings({ sfxVolume: -9 }).sfxVolume).toBe(0);
    expect(normalizeSettings({ masterVolume: "64" }).masterVolume).toBe(64);
    expect(normalizeSettings({ llmTimeoutSeconds: 100000 }).llmTimeoutSeconds).toBe(600);
    expect(normalizeSettings({ locale: "nb-NO" }).locale).toBe("no");
    expect(normalizeSettings(undefined)).toEqual(DefaultSettings);
  });

  it("normalizes the endpoint and the model name the way the transport needs them", () => {
    expect(normalizeEndpointUrl("http://localhost:1234/v1")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(normalizeEndpointUrl("http://localhost:1234/v1/")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(normalizeEndpointUrl("http://localhost:1234/v1/chat/completions")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(normalizeEndpointUrl("http://localhost:1234")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(normalizeEndpointUrl("http://localhost:11434")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    expect(normalizeEndpointUrl("http://localhost:11434/api/chat")).toBe(
      "http://localhost:11434/api/chat",
    );
    expect(normalizeEndpointUrl("   ")).toBe(LlmConfig.DefaultEndpointUrl);
    expect(normalizeEndpointUrl("https://api.example.com/openai/CHAT/COMPLETIONS")).toContain(
      "/CHAT/COMPLETIONS",
    );

    expect(normalizeModelName("  local-model ")).toBe("local-model");
    expect(normalizeModelName("")).toBe(LlmConfig.DefaultModelName);
    expect(normalizeModelName(null)).toBe(LlmConfig.DefaultModelName);
  });

  it("falls back to memory when storage refuses to write, and stays usable", () => {
    const storage = new ReadOnlyStorage();
    const store = new SettingsStore(storage);

    expect(store.persistent).toBe(true);
    expect(() => store.save({ sfxVolume: 12 })).not.toThrow();
    expect(store.settings.sfxVolume).toBe(12);

    // A later store cannot read it back — the write really did fail — but nothing broke.
    expect(new SettingsStore(storage).settings.sfxVolume).toBe(DefaultSettings.sfxVolume);
  });

  it("falls back to memory when there is no storage at all", () => {
    const store = new SettingsStore(null);
    expect(store.persistent).toBe(false);
    expect(store.settings).toEqual(DefaultSettings);

    store.update({ locale: "no", muted: true });
    expect(store.settings.locale).toBe("no");
    expect(store.settings.muted).toBe(true);
  });

  it("survives a backend that throws on read", () => {
    const store = new SettingsStore(new BrokenStorage());
    expect(store.settings).toEqual(DefaultSettings);
    expect(() => store.save({ masterVolume: 10 })).not.toThrow();
    expect(store.settings.masterVolume).toBe(10);
  });

  it("notifies subscribers on every real change, and only then", () => {
    const store = new SettingsStore(new FakeStorage());
    const seen: SahkkuSettings[] = [];
    const unsubscribe = store.subscribe((settings) => {
      seen.push(settings);
    });

    store.update({ muted: true });
    store.update({ muted: false });
    expect(seen.map((settings) => settings.muted)).toEqual([true, false]);

    unsubscribe();
    store.update({ muted: true });
    expect(seen).toHaveLength(2);
  });

  it("hands the saved endpoint, model and timeout to the agent that plays the NPC", () => {
    const storage = new FakeStorage();
    const store = new SettingsStore(storage);

    store.save({
      llmEndpoint: "http://192.168.1.9:11434/v1",
      llmModel: "qwen-local",
      llmTimeoutSeconds: 9,
    });

    // The settings the next start reads back are the ones the LLM seat is configured from.
    const reloaded = new SettingsStore(storage).settings;
    const config = llmConfigFrom(reloaded);

    expect(config).toBeInstanceOf(LlmConfig);
    expect(config.endpointUrl).toBe("http://192.168.1.9:11434/v1/chat/completions");
    expect(config.modelName).toBe("qwen-local");
    expect(config.requestTimeoutMs).toBe(9000);
  });
});

describe("SettingsModal", () => {
  it("mounts and unmounts one dialog in the container it was given", () => {
    const doc = fakeDocument();
    const container = (doc as unknown as FakeDocument).createElement("div") as unknown as HTMLElement;
    const store = new SettingsStore(null);

    const modal = new SettingsModal({ container, store, translate: (key) => key });

    expect(modal.isOpen).toBe(false);
    expect(container.childElementCount).toBe(0);

    modal.open();
    expect(modal.isOpen).toBe(true);
    expect(container.childElementCount).toBe(1);

    // The shared dialog chrome: a modal overlay that names itself and its dialog.
    const overlay = container.firstElementChild as unknown as FakeElement;
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(overlay.getAttribute("aria-label")).toBe("settings.label");
    expect(overlay.dataset["dialog"]).toBe("settings");

    // Idempotent: opening twice does not stack two dialogs.
    modal.open();
    expect(container.childElementCount).toBe(1);

    modal.close();
    expect(modal.isOpen).toBe(false);
    expect(container.childElementCount).toBe(0);
    modal.close();

    // Re-openable, and re-labelled when the language changes while it is on screen.
    modal.open();
    modal.setTranslator((key) => `se:${key}`);
    expect((container.firstElementChild as unknown as FakeElement).getAttribute("aria-label")).toBe(
      "se:settings.label",
    );
  });
});

describe("probeLlmConnection", () => {
  it("detects models successfully via GET /models", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/models")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            data: [{ id: "qwen-test-model" }, { id: "backup-model" }],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, statusText: "Not Found", text: async () => "Not Found" } as unknown as Response;
    }) as typeof fetch;

    try {
      const result = await probeLlmConnection("http://localhost:1234/v1/chat/completions", "test", 2);
      expect(result.ok).toBe(true);
      expect(result.models).toEqual(["qwen-test-model", "backup-model"]);
      expect(result.message).toContain("qwen-test-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to POST probe when GET /models fails but POST chat completion succeeds", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/models")) {
        return { ok: false, status: 404, statusText: "Not Found", text: async () => "Not Found" } as unknown as Response;
      }
      if (init?.method === "POST") {
        return { ok: true, status: 200, statusText: "OK", text: async () => "{}" } as unknown as Response;
      }
      return { ok: false, status: 500, statusText: "Error", text: async () => "Error" } as unknown as Response;
    }) as typeof fetch;

    try {
      const result = await probeLlmConnection("http://localhost:11434/api/chat", "test", 2);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Connected!");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports failure message when endpoint is unreachable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Failed to fetch");
    }) as typeof fetch;

    try {
      const result = await probeLlmConnection("http://localhost:9999/v1/chat/completions", "test", 2);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Failed to fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("HelpModal", () => {
  it("mounts the illustrated guide and closes it again", () => {
    const doc = fakeDocument();
    const container = (doc as unknown as FakeDocument).createElement("div") as unknown as HTMLElement;

    const modal = new HelpModal({ container, translate: (key) => key });

    expect(modal.isOpen).toBe(false);
    modal.open();
    expect(modal.isOpen).toBe(true);

    const overlay = container.firstElementChild as unknown as FakeElement;
    expect(overlay.dataset["dialog"]).toBe("help");
    expect(overlay.getAttribute("aria-label")).toBe("help.label");

    // Inside the card: the title, one section per rules topic, the credit and the close button.
    const card = overlay.firstElementChild as unknown as FakeElement;
    const sections = card.children.filter((child) => child.className === "help-section");
    expect(sections.length).toBeGreaterThanOrEqual(6);
    // Every section is illustrated, so the guide is a document with diagrams, not a wall of text.
    for (const section of sections) {
      expect(section.querySelector(".help-figure")).not.toBeNull();
    }

    modal.close();
    expect(container.childElementCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------- helpers

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The smallest DOM two dialogs need, so their mount/unmount contract can be asserted in the Node
 * environment the whole suite runs in (see `vitest.config.ts`). Only the members `SettingsModal` and
 * `HelpModal` touch are real: elements with attributes, children, listeners and a tag-name lookup.
 */
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  parent: FakeElement | null = null;

  className = "";
  id = "";
  name = "";
  value = "";
  type = "";
  checked = false;
  tabIndex = -1;
  textContent = "";

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tag: string,
  ) {}

  get childElementCount(): number {
    return this.children.length;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get dataset(): Record<string, string> {
    return (this.domDataset ??= {});
  }

  private domDataset?: Record<string, string>;

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    const parent = this.parent;
    if (parent == null) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
    if (name === "id") this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  /** Supports the three selector shapes the dialogs use: a tag name, `.class` and `[name="..."]`. */
  querySelector(selector: string): FakeElement | null {
    const named = /^\[name="(.*)"\]$/.exec(selector);
    const className = selector.startsWith(".") ? selector.slice(1) : null;

    const walk = (node: FakeElement): FakeElement | null => {
      for (const child of node.children) {
        const matches =
          named != null
            ? child.name === named[1]
            : className != null
              ? child.className.split(" ").includes(className)
              : child.tag === selector;
        if (matches) return child;
        const found = walk(child);
        if (found != null) return found;
      }
      return null;
    };
    return walk(this);
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly created: FakeElement[] = [];

  createElement(tag: string): FakeElement {
    return this.make(tag);
  }

  /** SVG children, which the illustrated help dialog builds through `PieceRenderer`. */
  createElementNS(_namespace: string, tag: string): FakeElement {
    return this.make(tag);
  }

  private make(tag: string): FakeElement {
    const element = new FakeElement(this, tag);
    this.created.push(element);
    return element;
  }
}

/** The document cast to what the dialogs expect; only the DOM members above are real. */
function fakeDocument(): Document {
  return new FakeDocument() as unknown as Document;
}
