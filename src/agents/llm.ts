/**
 * The LLM NPC: the 1:1 port of the retired C# `LlmClient` and `LlmPlayerAgent`.
 *
 * The agent asks an OpenAI-compatible endpoint to pick one of the moves the engine has already declared
 * legal, and accepts the answer only after checking it against that list. The rules engine stays the sole
 * authority — this agent can only ever return a member of `legalMoves`, never a mutation of the state.
 *
 * Every failure resolves the same way, without throwing and without hanging the match: no transport,
 * connection refused, HTTP non-200, timeout, an answer that is not the JSON it was asked for, an index
 * outside the legal list, or a re-roll that is not on offer. All of them log once and fall back to the
 * deterministic `HeuristicPlayerAgent`. A cancellation of the *caller's* signal is the one exception,
 * because that is the match ending rather than the model failing.
 */

import { GameState, Move, PieceOwner, RerollDecision } from "../rules/domain";
import type { RulesEngine } from "../rules/engine";
import { GameStateFormatter } from "../rules/formatter";
import sahkkuRulesJson from "../rules/SahkkuRules.json";
import { HeuristicPlayerAgent } from "./heuristic";
import type { PlayerAgent } from "./types";

// ----------------------------------------------------------------------------------------------
// The transport seam
// ----------------------------------------------------------------------------------------------

/** The bits of a `Response` the transport reads, so a test can script one without a socket. */
export interface LlmHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

/** The shape of the platform `fetch`, narrowed to what this module uses. */
export type LlmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<LlmHttpResponse>;

/**
 * The network seam under `LlmPlayerAgent`: one POST of an OpenAI-compatible chat-completions body,
 * resolved with the response text. Tests script it, which is what keeps the headless suite offline;
 * every failure surfaces as an exception, because deciding what to do about a failure is the agent's
 * job (see the fallback matrix in `LlmPlayerAgent`), not the transport's.
 */
export interface LlmTransport {
  /** Posts `requestJson` to `endpointUrl` and returns the response body. */
  postChatCompletion(endpointUrl: string, requestJson: string, signal?: AbortSignal): Promise<string>;
}

/** Default per-request deadline of `FetchLlmTransport`, allowing local LLMs adequate thinking time. */
export const DefaultTransportTimeoutMs = 60000;

/**
 * The shipped transport: plain `fetch` against any OpenAI-compatible endpoint — LM Studio
 * (`http://localhost:1234/v1/chat/completions`), Ollama, or a hosted API.
 *
 * The deadline is its own controller linked to the caller's signal rather than a property of a shared
 * client, so a deadline that fires cancels the *linked* signal only: the agent can then tell "the model
 * was too slow" (a failure it recovers from) apart from "the match was cancelled" (an error it rethrows).
 */
export class FetchLlmTransport implements LlmTransport {
  private readonly fetchImpl: LlmFetch;

  /** Per-request deadline in milliseconds; zero or a negative value disables it. */
  readonly requestTimeoutMs: number;

  constructor(fetchImpl: LlmFetch | null = null, requestTimeoutMs = DefaultTransportTimeoutMs) {
    this.fetchImpl = fetchImpl ?? defaultFetch;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async postChatCompletion(
    endpointUrl: string,
    requestJson: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (endpointUrl == null) throw new Error("An endpoint URL is required.");

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(signal?.reason);
    if (signal != null) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const deadline =
      this.requestTimeoutMs > 0
        ? setTimeout(() => controller.abort(new Error("the request deadline elapsed")), this.requestTimeoutMs)
        : null;

    try {
      const response = await this.fetchImpl(endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestJson ?? "{}",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`the endpoint answered HTTP ${response.status}${statusSuffix(response)}`);
      }
      return await response.text();
    } finally {
      if (deadline != null) clearTimeout(deadline);
      if (signal != null) signal.removeEventListener("abort", forwardAbort);
    }
  }
}

function defaultFetch(url: string, init: Parameters<LlmFetch>[1]): Promise<LlmHttpResponse> {
  return fetch(url, init);
}

function statusSuffix(response: LlmHttpResponse): string {
  return response.statusText.length > 0 ? ` ${response.statusText}` : "";
}

// ----------------------------------------------------------------------------------------------
// Configuration and the request body
// ----------------------------------------------------------------------------------------------

/** A single message in an OpenAI-compatible chat-completions request. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The raw JSON rules specification that the rules engine strictly adheres to. */
export const SahkkuRulesJson = JSON.stringify(sahkkuRulesJson, null, 2);

/**
 * The authoritative rules document sent to the LLM on the initial turn, containing the exact
 * SahkkuRules.json specification that the rules engine interprets.
 */
export const SahkkuRulesText = [
  "# Sáhkku Rules Specification (SahkkuRules.json)",
  "The game rules engine strictly adheres to the following JSON ruleset:",
  "```json",
  SahkkuRulesJson,
  "```",
  "",
  "# Rules Overview",
  "- Board: Three rows of fifteen lines (y=0: P1 Women, y=2: P2 Men, y=1: shared middle row).",
  "- Pieces: S1 (P1 soldier), S2 (P2 soldier), Q1 (P1 queen), Q2 (P2 queen), K0 (neutral king).",
  "- Track: Continuous figure-of-8 loop through the rows (home row -> middle row -> enemy row -> middle row -> home row).",
  "- Dice: 3 four-sided dice spent in order: X (1 step + activates 1 soldier), III (3 steps), II (2 steps), - (blank, 0 steps).",
  "- Piece Abilities: Soldiers move forward; Queen moves forward/backward/vertical (loss if captured!); King recruited when landed upon or when a soldier reaches the enemy home row.",
  "- Win Condition: Capture opponent's Queen OR eliminate all opponent soldiers.",
].join("\n");

export const SahkkuGameRules = SahkkuRulesText;

export interface LlmConfigInit {
  endpointUrl?: string;
  modelName?: string;
  temperature?: number;
  maxTokens?: number;
  requestTimeoutMs?: number;
}

/**
 * Everything an LLM agent needs to reach its endpoint. Plain data with defaults aimed at a local LM
 * Studio server, so it can be owned by a settings dialog or by a headless harness.
 */
export class LlmConfig {
  /** LM Studio's local server, with the chat-completions path spelled out. */
  static readonly DefaultEndpointUrl = "http://localhost:1234/v1/chat/completions";

  /** The model name the endpoint is asked to serve; empty by default so endpoints use their loaded model. */
  static readonly DefaultModelName = "";

  /** Adequate budget for local LLMs and thinking models to respond without prematurely aborting. */
  static readonly DefaultRequestTimeoutMs = 60000;

  endpointUrl: string;
  modelName: string;
  temperature: number;
  maxTokens?: number | null;
  requestTimeoutMs: number;

  constructor(init: LlmConfigInit = {}) {
    this.endpointUrl = init.endpointUrl ?? LlmConfig.DefaultEndpointUrl;
    this.modelName = init.modelName ?? LlmConfig.DefaultModelName;
    this.temperature = init.temperature ?? 0.2;
    this.maxTokens = init.maxTokens ?? null;
    this.requestTimeoutMs = init.requestTimeoutMs ?? LlmConfig.DefaultRequestTimeoutMs;
  }
}

/**
 * Builds the OpenAI-compatible chat-completions request body. Supports either a full list of
 * `ChatMessage` objects (for multi-turn session history) or a legacy (systemPrompt, userPrompt) pair.
 */
export function buildLlmChatRequest(
  config: LlmConfig | null,
  messages: readonly ChatMessage[],
): string;
export function buildLlmChatRequest(
  config: LlmConfig | null,
  systemPrompt: string | null,
  userPrompt: string | null,
): string;
export function buildLlmChatRequest(
  config: LlmConfig | null,
  systemOrMessages: string | readonly ChatMessage[] | null,
  userPrompt?: string | null,
): string {
  const effective = config ?? new LlmConfig();
  let messages: readonly ChatMessage[];
  if (Array.isArray(systemOrMessages)) {
    messages = systemOrMessages;
  } else {
    messages = [
      { role: "system", content: (systemOrMessages as string) ?? "" },
      { role: "user", content: userPrompt ?? "" },
    ];
  }

  const request: Record<string, unknown> = {
    temperature: Math.round((effective.temperature ?? 0) * 1000) / 1000,
    stream: false,
    reasoning_effort: "low",
    messages,
  };

  if (effective.maxTokens != null && effective.maxTokens > 0) {
    request.max_tokens = effective.maxTokens;
  }

  const model = effective.modelName?.trim();
  if (model && model.length > 0) {
    request.model = model;
  }

  return JSON.stringify(request);
}

// ----------------------------------------------------------------------------------------------
// Reading the model's answer
// ----------------------------------------------------------------------------------------------

/**
 * Reads a chat-completion response down to the decision object the agent's prompt asked for:
 * `{"move_index": N, "reasoning": "..."}` or `{"reroll": true, "reasoning": "..."}`.
 *
 * Every method here is total: a chatty, truncated or hostile answer yields `null` and never throws,
 * which is what lets the agent fall back to the heuristic instead of failing the match. "Unreadable"
 * therefore covers every way `JSON.parse` can refuse a candidate. Accepted shapes, in order of
 * preference:
 *
 * 1. the OpenAI envelope (`choices[0].message.content`, a string or a text-parts array),
 * 2. its content wrapped in a Markdown fence (```` ```json ... ``` ````),
 * 3. a plain body that is the decision object itself,
 * 4. any of the above with conversational prose around the JSON object.
 */
export class LlmResponseParser {
  static readonly MoveIndexKey = "move_index";
  static readonly MoveIndexCamelKey = "moveIndex";
  static readonly RerollKey = "reroll";
  static readonly ReasoningKey = "reasoning";

  /**
   * The move index the model named, or `null` when it named none that is inside
   * `[0, legalMoveCount)`. An index that is present but unreadable, negative or out of range is a
   * rejection, not a clue: the caller falls back to the heuristic rather than guessing what the model
   * meant.
   */
  static tryParseMoveIndex(responseBody: string | null, legalMoveCount: number): number | null {
    if (legalMoveCount <= 0) return null;

    const decision = findDecision(responseBody, [LlmResponseParser.MoveIndexKey, LlmResponseParser.MoveIndexCamelKey]);
    if (decision === undefined) return null;

    const index = readInt(decision);
    if (index == null) return null;
    if (index < 0 || index >= legalMoveCount) return null;
    return index;
  }

  /** The re-roll answer the model gave, or `null` when it did not give a usable one. */
  static tryParseReroll(responseBody: string | null): boolean | null {
    const decision = findDecision(responseBody, [LlmResponseParser.RerollKey]);
    if (decision === undefined) return null;
    return readBool(decision);
  }

  /** The model's own explanation, when it sent one. `null` when it did not. */
  static readReasoning(responseBody: string | null): string | null {
    const reasoning = findDecision(responseBody, [LlmResponseParser.ReasoningKey]);
    return reasoning === undefined ? null : readString(reasoning);
  }

  /** The finish reason reported by the chat completions envelope (e.g. 'stop', 'length'). */
  static finishReason(responseBody: string | null): string | null {
    if (responseBody == null || responseBody.length === 0) return null;
    const root = tryParseObject(responseBody);
    if (root == null) return null;
    const choices = root["choices"];
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0];
    if (!isJsonObject(first)) return null;
    return typeof first["finish_reason"] === "string" ? first["finish_reason"] : null;
  }

  /**
   * The text the decision lives in: the first message content of a chat-completion envelope, or the
   * body itself when it is not an envelope (or is an unreadable one).
   */
  static decisionText(responseBody: string | null): string | null {
    if (responseBody == null || responseBody.length === 0) return null;

    // A body that is not a readable chat-completion envelope is its own decision text: the object the
    // agent is after may still be in there (or nowhere at all), and the extraction below decides that.
    const root = tryParseObject(responseBody);
    if (root == null) return responseBody;

    const choices = root["choices"];
    if (!Array.isArray(choices)) return responseBody;

    const first = choices[0];
    if (!isJsonObject(first)) return responseBody;

    const message = first["message"];
    if (!isJsonObject(message)) return responseBody;

    const text = contentText(message["content"]);
    if (text != null && text.trim().length > 0) return text;

    const reasoning = contentText(message["reasoning_content"] ?? message["reasoning"]);
    if (reasoning != null && reasoning.trim().length > 0) return reasoning;

    return responseBody;
  }

  /**
   * The balanced `{ ... }` objects in `text`, outermost first and including nested ones, with braces
   * inside strings ignored. Scanning rather than parsing means prose, fences and truncated tails around
   * the object do not have to be understood.
   */
  static objectCandidates(text: string | null): string[] {
    const candidates: string[] = [];
    if (text == null || text.length === 0) return candidates;

    for (let start = 0; start < text.length; start++) {
      if (text[start] !== "{") continue;

      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (c === "\\") {
            escaped = true;
            continue;
          }
          if (c === '"') inString = false;
          continue;
        }

        if (c === '"') {
          inString = true;
          continue;
        }
        if (c === "{") {
          depth++;
          continue;
        }
        if (c !== "}") continue;

        depth--;
        if (depth !== 0) continue;

        candidates.push(text.slice(start, i + 1));
        break;
      }
    }
    return candidates;
  }
}

/** The decision value under the first candidate object that carries one of `keys`. */
function findDecision(responseBody: string | null, keys: string[]): unknown {
  const text = LlmResponseParser.decisionText(responseBody);
  for (const candidate of LlmResponseParser.objectCandidates(text)) {
    const parsed = tryParseObject(candidate);
    if (parsed == null) continue;

    // The first object that mentions the key wins even when its value is unusable, so a later object
    // can never be mistaken for the answer the model actually gave.
    for (const key of keys) {
      if (Object.hasOwn(parsed, key)) return parsed[key];
    }
  }
  return undefined;
}

/**
 * Reads a candidate object, folding every way the platform reader can refuse it into one `null`. A
 * malformed `\u` escape — a model writing `C:\users` inside its reasoning, say — fails exactly like
 * malformed JSON does, and to a parser that is promised to be total the distinction is meaningless:
 * either way the text is not the JSON the prompt asked for, so a later candidate still gets its turn
 * and an answer nobody can read is simply not one.
 */
function tryParseObject(candidate: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  return isJsonObject(parsed) ? parsed : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a JSON integer, tolerating the quoted form some small models emit. */
function readInt(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null; // "1.5" is not a move index
    if (!Number.isSafeInteger(value)) return null;
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
  }
  return null;
}

/** Reads a JSON boolean, tolerating the quoted form some small models emit. */
function readBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The content of a message: a plain string, or the concatenated text parts of a multimodal one. */
function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  let out = "";
  for (const part of content) {
    if (!isJsonObject(part)) continue;
    const text = part["text"];
    if (typeof text === "string") out += text;
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// The agent
// ----------------------------------------------------------------------------------------------

export class LlmPlayerAgent implements PlayerAgent {
  /** Role prompt for a move decision. The JSON shape is repeated in the user turn next to the board. */
  static readonly MoveSystemPrompt =
    "You are a Sáhkku player. You will be given the board, the dice in spending order and the " +
    "numbered list of legal moves for the current player.\n" +
    "Be concise. Do not produce lengthy internal reasoning. Choose the strongest move and answer with one JSON object and nothing else.";

  /** Role prompt for the optional re-roll decision. */
  static readonly RerollSystemPrompt =
    "You are a Sáhkku player. You may throw the sáhkku die again, or keep the dice and play on.\n" +
    "Be concise. Do not produce lengthy internal reasoning. Decide and answer with one JSON object and nothing else.";

  /** Appended to the formatted state for a move decision (the contract the parser enforces). */
  static readonly MoveInstruction =
    '\nChoose one move. Be concise. Answer ONLY with JSON: {"move_index": <number>, "reasoning": "<short reason>"}';

  /** Appended to the formatted state for a re-roll decision (the contract the parser enforces). */
  static readonly RerollInstruction =
    '\nShould the sáhkku die be thrown again? Be concise. Answer ONLY with JSON: {"reroll": <true|false>, "reasoning": "<short reason>"}';

  readonly owner: PieceOwner;
  readonly name: string;

  private readonly transport: LlmTransport | null;
  private readonly config: LlmConfig;
  private readonly engine: RulesEngine | null;
  private readonly log: ((message: string) => void) | null;
  private readonly fallback: PlayerAgent;

  /** Multi-turn chat session history for the current game. */
  private sessionMessages: ChatMessage[] = [];

  /**
   * @param engine The authority the fallback and the re-roll question consult. May be null only for tests.
   * @param log Optional sink for the agent's decisions and fallbacks (a benchmark passes a counter).
   */
  constructor(
    owner: PieceOwner,
    name: string | null = null,
    transport: LlmTransport | null = null,
    config: LlmConfig | null = null,
    engine: RulesEngine | null = null,
    log: ((message: string) => void) | null = null,
    fallback?: PlayerAgent,
  ) {
    this.owner = owner;
    this.name = name ?? "LLM NPC";
    this.transport = transport;
    this.config = config ?? new LlmConfig();
    this.engine = engine;
    this.log = log;
    this.fallback = fallback ?? new HeuristicPlayerAgent(owner, null, engine);
  }

  /** Clears the conversation history so the next turn starts as a fresh session with rules. */
  resetSession(): void {
    this.sessionMessages = [];
  }

  /** Read-only view of the ongoing session messages, primarily for tests and diagnostics. */
  getSessionMessages(): readonly ChatMessage[] {
    return this.sessionMessages;
  }

  /**
   * System prompt tailored to the agent's assigned seat, explicitly telling the model which side
   * it plays (e.g. Player 2 Men vs Player 1 Women) and what its objective is.
   */
  private buildSystemPrompt(): string {
    const side = this.owner === PieceOwner.P1 ? "Player 1 (Women / Nisu)" : "Player 2 (Men / Almmái)";
    const opponent = this.owner === PieceOwner.P1 ? "Player 2 (Men / Almmái)" : "Player 1 (Women / Nisu)";
    return (
      `You are playing Sáhkku as ${side}.\n` +
      `Your opponent is ${opponent}. Your objective is to defeat ${opponent} by capturing their Queen or eliminating all of their soldiers, while keeping your Queen safe.\n` +
      "You will be given the board, the dice in spending order, and the numbered list of legal moves.\n" +
      'Be concise. Do not produce lengthy internal reasoning. Choose the strongest move and answer ONLY with one JSON object: {"move_index": <number>, "reasoning": "<short reason>"}.'
    );
  }

  async decideReroll(state: GameState, signal?: AbortSignal): Promise<RerollDecision> {
    // The engine decides whether a re-roll is even on offer; when it is not, there is nothing to ask.
    if (this.engine != null && state != null && !this.engine.canReroll(state)) {
      return RerollDecision.KeepDiceAndProceed;
    }

    if (this.transport == null) {
      this.writeLog("no endpoint is configured; deciding heuristically.");
      return this.fallback.decideReroll(state, signal);
    }

    const isInitialTurn = this.sessionMessages.length === 0;
    if (isInitialTurn) {
      this.sessionMessages.push({ role: "system", content: this.buildSystemPrompt() });
    }

    const boardPrompt = this.buildRerollPrompt(state);
    const userPrompt = isInitialTurn
      ? `${SahkkuRulesText}\n\n${boardPrompt}`
      : boardPrompt;

    this.sessionMessages.push({ role: "user", content: userPrompt });

    try {
      throwIfAborted(signal);

      const requestJson = buildLlmChatRequest(this.config, this.sessionMessages);
      const responseJson = await this.transport.postChatCompletion(
        this.config.endpointUrl,
        requestJson,
        signal,
      );

      const reroll = LlmResponseParser.tryParseReroll(responseJson);
      if (reroll != null) {
        const decisionText = LlmResponseParser.decisionText(responseJson) ?? JSON.stringify({ reroll });
        this.sessionMessages.push({ role: "assistant", content: decisionText });
        while (this.sessionMessages.length > 30) this.sessionMessages.splice(1, 2);

        this.writeLog(
          `chose to ${reroll ? "throw the sáhkku die again" : "keep the dice"}${this.reasoningSuffix(responseJson)}`,
        );
        return reroll ? RerollDecision.RerollActiveDie : RerollDecision.KeepDiceAndProceed;
      }

      this.sessionMessages.pop();
      const finishReason = LlmResponseParser.finishReason(responseJson);
      if (finishReason === "length") {
        console.warn(`[LlmPlayerAgent] ${this.name}: reroll output was truncated by max_tokens limit before finishing.`);
        this.writeLog("the endpoint truncated its response (hit max_tokens limit); deciding heuristically.");
      } else {
        this.writeLog("the endpoint did not answer with a usable reroll decision; deciding heuristically.");
      }
    } catch (error) {
      if (this.sessionMessages.length > 0 && this.sessionMessages[this.sessionMessages.length - 1].role === "user") {
        this.sessionMessages.pop();
      }
      // The match ended while the model was thinking. That is the controller's contract, not a model
      // failure, so it propagates instead of being absorbed by the fallback below. A timeout lands in
      // the *transport's* own deadline, which never sets the caller's signal, so it still recovers.
      if (signal?.aborted === true) throw error;
      console.warn(`[LlmPlayerAgent] ${this.name}: reroll request failed:`, error);
      this.writeLog(`the reroll request failed (${errorMessage(error)}); deciding heuristically.`);
    }

    return this.fallback.decideReroll(state, signal);
  }

  async decideMove(
    state: GameState,
    legalMoves: readonly Move[],
    signal?: AbortSignal,
  ): Promise<Move | null> {
    if (legalMoves.length === 0) return null;

    // A forced move is not a decision: the engine left exactly one option, so skip the round trip.
    if (legalMoves.length === 1) return legalMoves[0];

    if (this.transport == null) {
      this.writeLog("no endpoint is configured; playing the heuristic choice.");
      return this.fallback.decideMove(state, legalMoves, signal);
    }

    const isInitialTurn = this.sessionMessages.length === 0;
    if (isInitialTurn) {
      this.sessionMessages.push({ role: "system", content: this.buildSystemPrompt() });
    }

    const sideName = this.owner === PieceOwner.P1 ? "Player 1 (Women)" : "Player 2 (Men)";
    const instruction = `\nChoose one move for ${sideName}. Be concise. Answer ONLY with JSON: {"move_index": <number>, "reasoning": "<short reason>"}`;
    const boardContext = GameStateFormatter.formatPromptContext(state, legalMoves) + instruction;
    const userPrompt = isInitialTurn
      ? `${SahkkuRulesText}\n\n${boardContext}`
      : boardContext;

    this.sessionMessages.push({ role: "user", content: userPrompt });

    try {
      throwIfAborted(signal);

      const requestJson = buildLlmChatRequest(this.config, this.sessionMessages);
      const responseJson = await this.transport.postChatCompletion(
        this.config.endpointUrl,
        requestJson,
        signal,
      );

      const moveIndex = LlmResponseParser.tryParseMoveIndex(responseJson, legalMoves.length);
      if (moveIndex != null) {
        // The index was checked against the count of the list the engine just produced, so the move is
        // legal by construction: no proposal the model makes can bypass the engine.
        const decisionText = LlmResponseParser.decisionText(responseJson) ?? JSON.stringify({ move_index: moveIndex });
        this.sessionMessages.push({ role: "assistant", content: decisionText });
        while (this.sessionMessages.length > 30) this.sessionMessages.splice(1, 2);

        const move = legalMoves[moveIndex];
        this.writeLog(
          `chose move ${moveIndex} of ${legalMoves.length} (${move})${this.reasoningSuffix(responseJson)}`,
        );
        return move;
      }

      this.sessionMessages.pop();
      const finishReason = LlmResponseParser.finishReason(responseJson);
      if (finishReason === "length") {
        console.warn(`[LlmPlayerAgent] ${this.name}: move output was truncated by max_tokens limit before finishing.`);
        this.writeLog("the endpoint truncated its response (hit max_tokens limit); playing the heuristic choice.");
      } else {
        this.writeLog("the endpoint did not answer with a usable move index; playing the heuristic choice.");
      }
    } catch (error) {
      if (this.sessionMessages.length > 0 && this.sessionMessages[this.sessionMessages.length - 1].role === "user") {
        this.sessionMessages.pop();
      }
      if (signal?.aborted === true) throw error;
      console.warn(`[LlmPlayerAgent] ${this.name}: move request failed:`, error);
      this.writeLog(`the move request failed (${errorMessage(error)}); playing the heuristic choice.`);
    }

    return this.fallback.decideMove(state, legalMoves, signal);
  }

  /**
   * The re-roll question, projected from the authoritative state: the board and the dice as the shared
   * formatter renders them, plus the moves the throw would offer if the dice were kept — which is
   * exactly what the decision turns on.
   */
  private buildRerollPrompt(state: GameState): string {
    const movesIfKept = this.engine == null || state == null ? [] : this.engine.legalMoves(state);
    return GameStateFormatter.formatPromptContext(state, movesIfKept) + LlmPlayerAgent.RerollInstruction;
  }

  /** The model's own reason, appended to the decision log when it sent one. */
  private reasoningSuffix(responseJson: string): string {
    if (this.log == null) return "";
    const reasoning = LlmResponseParser.readReasoning(responseJson);
    return reasoning == null || reasoning.length === 0 ? "" : `: ${reasoning}`;
  }

  private writeLog(message: string): void {
    if (this.log != null) this.log(`${this.name}: ${message}`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("The decision was cancelled.");
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
