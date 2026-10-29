/**
 * The headless entry point of the benchmark tool: a rewrite of the retired C# console app's
 * `Program` entry point.
 *
 * <pre>
 * npm run bench -- --games 100 --p1 heuristic --p2 random
 * </pre>
 *
 * It wires one agent per seat, runs the games through `MatchRunner` — which hands every action to
 * `RulesEngine` and checks the board after every one — and prints the run as a table or as JSON. Nothing
 * here decides a rule, and nothing here needs a browser or a renderer.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PieceOwner, RerollDecision, WinReason, type GameState, type Move } from "../rules/domain";
import { RulesEngine } from "../rules/engine";
import { RuleSetJson, loadShippedRuleset, type RuleSet } from "../rules/ruleset";
import { LlmConfigFile, normalizeEndpoint, normalizeModel } from "../agents/config";
import { HumanPlayerAgent } from "../agents/human";
import { HeuristicPlayerAgent } from "../agents/heuristic";
import { difficultyFor } from "../agents/search";
import { FetchLlmTransport, LlmConfig, LlmPlayerAgent } from "../agents/llm";
import { RandomPlayerAgent } from "../agents/random";
import type { HumanInteraction, PlayerAgent } from "../agents/types";
import { BenchmarkSummary, LlmFallbackCounter } from "./benchmark-stats";
import { MatchConfig, MatchRunner, SeededRandomSource, type MatchResult } from "./match-runner";

/** The agent kinds one seat can be played by. */
export const AgentKinds = ["human", "random", "easy", "medium", "hard", "heuristic", "llm"] as const;
export type AgentKind = (typeof AgentKinds)[number];

/** The parsed command line. */
export interface CliOptions {
  games: number;
  p1: AgentKind;
  p2: AgentKind;
  endpoint: string;
  model: string;
  seed: number;
  useRandomSeed: boolean;
  maxHalfMoves: number;
  rulesetPath: string | null;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

export const Usage = `Sáhkku headless match runner, evaluation harness and benchmark.

Plays automated matches between any combination of agents and reports the outcome. Every action goes
through the rules engine, which validates each move and is checked after every change: the harness
cannot drive the game into an illegal position, and a rule violation ends the run with exit code 1.

Usage:
  npm run bench -- [options]

Options:
  --games <N>        Games to play (default: 10).
  --p1 <type>        Agent for player one: ${AgentKinds.join(" | ")} (default: heuristic).
  --p2 <type>        Agent for player two: ${AgentKinds.join(" | ")} (default: heuristic).
  --endpoint <url>   OpenAI-compatible endpoint for LLM agents (default: the shared llm-config.json,
                     else ${LlmConfig.DefaultEndpointUrl}).
  --model <name>     Model name sent to the endpoint (default: the shared llm-config.json, else
                     blank to use the endpoint's loaded model).
  --seed <int>       Base seed for a reproducible run (default: the clock).
  --max-turns <N>    Half-moves before a game is declared a draw (default: 10000).
  --ruleset <path>   Path to SahkkuRules.json (default: the ruleset shipped in src/rules).
  --json             Print the summary as JSON instead of as a table.
  --verbose          Print one line per game and the agents' decisions as they happen.
  --help, -h         Print this help.

Heuristic levels:
  easy              Greedy whole-board evaluation.
  medium            Turn planning and tactical opponent replies (default).
  hard              Deeper/wider chance-weighted adversarial search; can think longer.
  heuristic         Compatibility alias for medium.

Examples:
  npm run bench -- --games 100 --p1 heuristic --p2 random
  npm run bench -- --games 10 --p1 llm --p2 heuristic --endpoint http://localhost:1234/v1

Exit codes:
  0  every game completed: no rule violations and no failed games.
  1  bad arguments, a missing ruleset, a rule violation, or a game that did not complete.`;

/**
 * The presentation-less stand-in for a `human` seat: the headless harness has no board to click and no
 * re-roll button, so a seat played by a person resolves the way a UI does when it is never answered —
 * keep the dice, and take the first move the engine offered. A real client injects a `HumanInteraction`
 * that resolves from clicks instead (see `HumanPlayerAgent`).
 */
export class HeadlessHumanInteraction implements HumanInteraction {
  requestReroll(): Promise<RerollDecision> {
    return Promise.resolve(RerollDecision.KeepDiceAndProceed);
  }

  requestMove(_state: GameState, legalMoves: readonly Move[]): Promise<Move> {
    return Promise.resolve(legalMoves[0]);
  }
}

/** Parses the command line, stopping at the first problem so a typo can never mean a silent default. */
export function parseOptions(args: readonly string[]): { ok: true; options: CliOptions } | { ok: false; error: string } {
  // The shared file fills in only what the command line leaves out, so it is read once here and the
  // precedence (flag > file > default) lives in one place instead of at every agent construction.
  const shared = LlmConfigFile.load();

  const options: CliOptions = {
    games: 10,
    p1: "heuristic",
    p2: "heuristic",
    endpoint: shared.endpoint,
    model: shared.model,
    seed: 0,
    useRandomSeed: true,
    maxHalfMoves: 10000,
    rulesetPath: null,
    json: false,
    verbose: false,
    help: false,
  };

  // Whether the caller named each setting itself. Only the ones they did not stay resolved from the
  // shared config file above, so a flag always beats the file and the file always beats the default.
  let endpointGiven = false;
  let modelGiven = false;

  const readValue = (index: number): string | null => (index + 1 < args.length ? args[index + 1] : null);
  const readInt = (flag: string, value: string | null, minimum: number | null): number | null => {
    if (value == null || !/^[+-]?\d+$/.test(value.trim())) return null;
    const parsed = Number.parseInt(value.trim(), 10);
    if (minimum != null && parsed < minimum) return null;
    return parsed;
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        return { ok: true, options };

      case "--json":
        options.json = true;
        break;

      case "--verbose":
        options.verbose = true;
        break;

      case "--games": {
        const value = readValue(i);
        const games = readInt(flag, value, 1);
        if (games == null) return { ok: false, error: `--games needs a positive integer, got '${value ?? ""}'.` };
        options.games = games;
        i++;
        break;
      }

      case "--max-turns": {
        const value = readValue(i);
        const maxHalfMoves = readInt(flag, value, 1);
        if (maxHalfMoves == null) {
          return { ok: false, error: `--max-turns needs a positive integer, got '${value ?? ""}'.` };
        }
        options.maxHalfMoves = maxHalfMoves;
        i++;
        break;
      }

      case "--seed": {
        const value = readValue(i);
        const seed = readInt(flag, value, null);
        if (seed == null) return { ok: false, error: `--seed needs an integer, got '${value ?? ""}'.` };
        options.seed = seed;
        options.useRandomSeed = false;
        i++;
        break;
      }

      case "--p1":
      case "--p2": {
        const value = readValue(i);
        if (value == null || !isAgentKind(value)) {
          return { ok: false, error: `${flag} needs one of ${AgentKinds.join(" | ")}, got '${value ?? ""}'.` };
        }
        if (flag === "--p1") options.p1 = value;
        else options.p2 = value;
        i++;
        break;
      }

      case "--endpoint": {
        const value = readValue(i);
        if (value == null || value.length === 0) return { ok: false, error: "--endpoint needs a URL." };
        options.endpoint = value;
        endpointGiven = true;
        i++;
        break;
      }

      case "--model": {
        const value = readValue(i);
        if (value == null) return { ok: false, error: "--model needs a value." };
        options.model = value;
        modelGiven = true;
        i++;
        break;
      }

      case "--ruleset": {
        const value = readValue(i);
        if (value == null || value.length === 0) return { ok: false, error: "--ruleset needs a path." };
        options.rulesetPath = value;
        i++;
        break;
      }

      default:
        return { ok: false, error: `unknown option '${flag}'.` };
    }
  }

  // Endpoint and model: the flag wins, else the shared file, else the built-in default.
  if (!endpointGiven || !modelGiven) {
    if (!endpointGiven) options.endpoint = shared.endpoint;
    if (!modelGiven) options.model = shared.model;
  }

  return { ok: true, options };
}

/** Runs the benchmark described by `args`; returns the process exit code. */
export async function main(args: readonly string[]): Promise<number> {
  const parsed = parseOptions(args);
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}`);
    console.error();
    console.error(Usage);
    return 1;
  }
  if (parsed.options.help) {
    console.log(Usage);
    return 0;
  }

  try {
    return await runBenchmark(parsed.options);
  } catch (error) {
    if (isAbortError(error)) {
      console.error("error: the run was cancelled.");
      return 1;
    }
    console.error(`error: ${errorName(error)}: ${messageOf(error)}`);
    return 1;
  }
}

async function runBenchmark(options: CliOptions): Promise<number> {
  const engine = new RulesEngine(loadRuleset(options.rulesetPath));

  // The seed is resolved once, here, so every game of the run draws its own stream from it and yet the
  // whole run is reproducible from --seed.
  const seed = options.useRandomSeed ? Date.now() | 0 : options.seed;

  const config = new MatchConfig();
  config.maxHalfMoves = options.maxHalfMoves;
  config.seed = seed;
  config.useRandomSeed = false;

  const fallbacks = new LlmFallbackCounter();
  const llmLog = (message: string): void => {
    fallbacks.observe(message);
    if (options.verbose) console.log(`    ${message}`);
  };

  const p1 = createAgent("--p1", options.p1, PieceOwner.P1, engine, seed, options, llmLog);
  const p2 = createAgent("--p2", options.p2, PieceOwner.P2, engine, seed, options, llmLog);
  const runner = new MatchRunner(engine, p1, p2);

  const summary = new BenchmarkSummary();

  if (options.verbose) {
    console.log(
      `Sáhkku benchmark: ${p1.name} (P1) vs ${p2.name} (P2), ${options.games} game(s), seed ${seed}, ruleset ${options.rulesetPath ?? "src/rules/SahkkuRules.json"}`,
    );
  }

  for (let game = 0; game < options.games; game++) {
    fallbacks.reset();
    const result = await runner.runMatch(game, config);

    result.llmFallbacks = fallbacks.count;
    summary.add(result);

    if (options.verbose) console.log(describe(result, game, options.games));
  }

  if (options.json) {
    const data: unknown = JSON.parse(summary.toJsonString(p1.name, p2.name));
    if (typeof data !== "object" || data == null) throw new Error("Invalid benchmark summary.");
    console.log(JSON.stringify({
      ...data,
      search: {
        p1: p1 instanceof HeuristicPlayerAgent ? p1.searchStats : null,
        p2: p2 instanceof HeuristicPlayerAgent ? p2.searchStats : null,
      },
    }));
  } else console.log(summary.toPrettyString(p1.name, p2.name));

  return summary.failures > 0 ? 1 : 0;
}

/**
 * Builds the agent for one seat from its CLI name. A random bot gets its own deterministic stream
 * (offset by the seat), and an LLM agent gets the endpoint configuration plus the run's log sink, which
 * is what lets the summary report how often the model was not the one deciding.
 */
function createAgent(
  flag: string,
  kind: AgentKind,
  owner: PieceOwner,
  engine: RulesEngine,
  seed: number,
  options: CliOptions,
  log: (message: string) => void,
): PlayerAgent {
  switch (kind) {
    case "human":
      return new HumanPlayerAgent(owner, "Human", new HeadlessHumanInteraction());

    case "easy":
    case "medium":
    case "hard":
    case "heuristic":
      return new HeuristicPlayerAgent(owner, null, engine, {
        difficulty: difficultyFor(kind) ?? "medium",
        random: new SeededRandomSource((seed * 31 + owner) | 0),
        log: message => console.error(message),
      });

    case "random":
      return new RandomPlayerAgent(owner, "Random", new SeededRandomSource((seed * 31 + owner) | 0));

    case "llm": {
      // options.endpoint/options.model already carry the flag > shared file > default resolution from
      // parseOptions; the URL is completed to the chat-completions path here.
      const config = new LlmConfig({
        endpointUrl: normalizeEndpoint(options.endpoint),
        modelName: normalizeModel(options.model),
      });
      const transport = new FetchLlmTransport(null, config.requestTimeoutMs);
      return new LlmPlayerAgent(owner, "LLM", transport, config, engine, log);
    }

    default:
      throw new Error(`Unknown agent type '${String(kind)}' for ${flag}.`);
  }
}

/** Finds the ruleset: an explicit path, else the copy shipped inside `src/rules`. */
function loadRuleset(explicitPath: string | null): RuleSet {
  if (explicitPath == null) return loadShippedRuleset();
  return RuleSetJson.fromJson(readFileSync(explicitPath, "utf8"));
}

function describe(result: MatchResult, index: number, total: number): string {
  let outcome: string;
  if (result.failed) {
    outcome = `failed: ${result.errorMessage}`;
  } else if (result.winner === PieceOwner.None) {
    outcome = result.hitTurnLimit ? "draw (turn limit)" : "draw";
  } else {
    outcome = `${PieceOwner[result.winner]} wins by ${WinReason[result.winReason]}`;
  }

  return `game ${index + 1}/${total}: ${outcome} in ${result.totalHalfMoves} half-moves, ${result.totalCaptures} captures, ${(result.durationMs / 1000).toFixed(3)}s`;
}

function isAgentKind(value: string): value is AgentKind {
  return (AgentKinds as readonly string[]).includes(value);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError" || error.name === "AbortSignal";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ----------------------------------------------------------------------------------------------
// Module entry point
// ----------------------------------------------------------------------------------------------

const invokedAsScript =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
