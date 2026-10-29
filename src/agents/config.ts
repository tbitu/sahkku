/**
 * The shared LLM endpoint configuration: a port of the retired C# `LlmConfigFile`.
 *
 * One small JSON file (`llm-config.json`) holds the OpenAI-compatible endpoint and the model name, read
 * by the headless benchmark and (later) the web client alike, so the settings dialog and the evaluation
 * harness agree on where the NPC is served from.
 *
 * Discovery order, from strongest to weakest:
 *
 * 1. an explicit path,
 * 2. the `SAHKKU_LLM_CONFIG` environment variable,
 * 3. a settings file already saved in the writable fallback directory, so an edit to a read-only
 *    install is read back rather than shadowed by a shipped file,
 * 4. a search upwards from this module and then from the working directory,
 * 5. otherwise a new file next to the working directory.
 *
 * Every read is total: a missing, empty, unreadable or hand-broken file yields the defaults rather than
 * an exception, because no configuration file is worth failing a game over. Writes normalize the URL
 * first, so an endpoint typed as a base URL is stored ready to post to.
 *
 * The file-system half of this module is Node-only; a browser host stores the same two settings itself
 * and only reuses `parse`, `serialize` and the normalizers.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LlmConfig } from "./llm";

/** The file the tools and the game share. */
export const LlmConfigFileName = "llm-config.json";

/** Overrides the discovery order with a path of its own. */
export const LlmConfigEnvironmentVariable = "SAHKKU_LLM_CONFIG";

/** LM Studio's local server, with the chat-completions path spelled out. */
export const DefaultEndpoint = LlmConfig.DefaultEndpointUrl;

/** The model name the endpoint is asked to serve. */
export const DefaultModel = LlmConfig.DefaultModelName;

/** The two settings this module owns. */
export interface LlmSettings {
  endpoint: string;
  model: string;
}

export class LlmConfigFile {
  /**
   * The one directory a read-only install can always write to: a settings file saved there is read back
   * in preference to a shipped default, and a write to a read-only root is retried there. Left `null`
   * by headless callers.
   */
  static writableFallbackDirectory: string | null = null;

  /**
   * The endpoint and model to use, resolved through `locateConfigFile`. Returns the defaults for a file
   * that is missing, empty, unreadable or not the object this module writes; the endpoint is normalized
   * so a base URL comes back ready to post to.
   */
  static load(explicitPath: string | null = null): LlmSettings {
    const path = LlmConfigFile.locateConfigFile(explicitPath);
    if (path == null || !existsSync(path)) return { endpoint: DefaultEndpoint, model: DefaultModel };

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { endpoint: DefaultEndpoint, model: DefaultModel };
    }
    return LlmConfigFile.parse(text);
  }

  /**
   * Reads the two settings out of `text`. Total like `load`: text that is not a JSON object, or a
   * missing, empty or wrongly-typed value, falls back to that setting's default.
   */
  static parse(text: string | null): LlmSettings {
    const root = tryParseObject(text);
    if (root == null) return { endpoint: DefaultEndpoint, model: DefaultModel };

    const endpoint = typeof root["endpoint"] === "string" ? (root["endpoint"] as string) : null;
    const model = typeof root["model"] === "string" ? (root["model"] as string) : null;
    return { endpoint: normalizeEndpoint(endpoint), model: normalizeModel(model) };
  }

  /**
   * Writes `endpoint` and `model` as the shared JSON file, creating the directory if needed. Both are
   * normalized first. When the resolved location cannot be written (a read-only install) the write is
   * retried in `writableFallbackDirectory`; if that is unset or also fails, the error surfaces.
   */
  static save(endpoint: string, model: string, explicitPath: string | null = null): string {
    const path = LlmConfigFile.locateConfigFile(explicitPath);
    const json = LlmConfigFile.serialize(endpoint, model);

    try {
      writeText(path, json);
      return path;
    } catch (error) {
      const fallback =
        LlmConfigFile.writableFallbackDirectory == null
          ? null
          : join(LlmConfigFile.writableFallbackDirectory, LlmConfigFileName);
      if (fallback == null || isSamePath(path, fallback) || !isRecoverableWriteFailure(error)) throw error;

      writeText(fallback, json);
      return fallback;
    }
  }

  /** The exact text `save` writes: a two-key JSON object with the values normalized. */
  static serialize(endpoint: string, model: string): string {
    return `{\n  "endpoint": ${JSON.stringify(normalizeEndpoint(endpoint))},\n  "model": ${JSON.stringify(normalizeModel(model))}\n}\n`;
  }

  /**
   * Resolves the path of the shared config per the documented discovery order. The path need not exist
   * yet: an explicit path, the environment variable and the last-resort root are returned whether or
   * not a file is there, so `save` can create one.
   *
   * `searchStartDirectory` overrides the upward search root; only the tests use it.
   */
  static locateConfigFile(
    explicitPath: string | null = null,
    searchStartDirectory: string | null = null,
  ): string {
    if (explicitPath != null && explicitPath.length > 0) return resolve(explicitPath);

    const fromEnvironment = process.env[LlmConfigEnvironmentVariable];
    if (fromEnvironment != null && fromEnvironment.length > 0) return resolve(fromEnvironment);

    // A settings file the user has already saved next to a read-only install has to win over a shipped
    // default, or every edit after the first would be read back as the shipped value.
    if (LlmConfigFile.writableFallbackDirectory != null) {
      const saved = join(LlmConfigFile.writableFallbackDirectory, LlmConfigFileName);
      if (existsSync(saved)) return saved;
    }

    if (searchStartDirectory != null) {
      return LlmConfigFile.searchUpwards(searchStartDirectory) ?? join(searchStartDirectory, LlmConfigFileName);
    }

    const found = LlmConfigFile.searchUpwards(moduleDirectory()) ?? LlmConfigFile.searchUpwards(process.cwd());
    if (found != null) return found;

    return join(searchRoot(), LlmConfigFileName);
  }

  /**
   * The first `llm-config.json` between `startDirectory` and the filesystem root, or `null`. Walks the
   * directory itself first, then every parent.
   */
  static searchUpwards(startDirectory: string | null): string | null {
    if (startDirectory == null || startDirectory.length === 0) return null;

    let directory: string | null = resolve(startDirectory);
    while (directory != null) {
      const candidate = join(directory, LlmConfigFileName);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(directory);
      directory = parent === directory ? null : parent;
    }
    return null;
  }
}

/**
 * Accepts either a base URL (`http://localhost:1234/v1`) or the full chat-completions URL, and returns
 * the URL the client posts to. An empty value becomes the default endpoint, so a UI can never leave the
 * NPC without somewhere to send its requests.
 */
export function normalizeEndpoint(endpoint: string | null | undefined): string {
  let value = endpoint == null ? "" : endpoint.trim();
  if (value.length === 0) return DefaultEndpoint;
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

/** Trims a model name and falls back to the default when it is empty. */
export function normalizeModel(model: string | null | undefined): string {
  const value = model == null ? "" : model.trim();
  return value.length === 0 ? DefaultModel : value;
}

// ----------------------------------------------------------------------------------------------
// internals
// ----------------------------------------------------------------------------------------------

/** Reads the text as a JSON object, folding every way the platform reader can refuse it into `null`. */
function tryParseObject(text: string | null): Record<string, unknown> | null {
  if (text == null || text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Where a config is created when discovery finds none: the working directory, i.e. the project root. */
function searchRoot(): string {
  if (process.cwd().length > 0) return process.cwd();
  return moduleDirectory() ?? ".";
}

/** The directory this module lives in, standing in for the reference implementation's base directory. */
function moduleDirectory(): string | null {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

function writeText(path: string, json: string): void {
  const directory = dirname(path);
  if (directory.length > 0) mkdirSync(directory, { recursive: true });
  writeFileSync(path, json, "utf8");
}

function isSamePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

/**
 * The failures a read-only or otherwise unusable install produces; anything else (a bad argument) is a
 * bug and is reraised. The set mirrors the reference implementation's recoverable exceptions
 * (`UnauthorizedAccessException`, `IOException`, `NotSupportedException`).
 */
function isRecoverableWriteFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code === "EISDIR" ||
    code === "ENOTDIR" ||
    code === "ENOENT" ||
    code === "EEXIST"
  );
}
