/**
 * Vitest port of the headless half of the retired C# `BenchmarkTests` suite: the match runner's
 * turn loop, the failure rules it has to follow, the statistics it reports, and the CLI on top of them.
 *
 * Strength is measured against a baseline that is weak by construction. A sáhkku is worth one step
 * where a two or a three is worth more, and a re-throw is free while no die of the throw has been
 * spent, so a bot that never re-rolls has to play its sáhkku as it fell — a one-step move, or an
 * activation — rather than fishing for a bigger face. That is why the strength fixture below seats a
 * *keep-the-dice* random bot rather than the shipped one, whose re-roll flips would add a second source
 * of randomness to the comparison.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DieFace,
  Move,
  PieceOwner,
  PieceType,
  RerollDecision,
  TurnPhase,
  WinReason,
  type GameState,
} from "../../src/rules/domain";
import type { RulesEngine } from "../../src/rules/engine";
import { LegacyHeuristicAgent as HeuristicPlayerAgent } from "../helpers/legacy-agent";
import { LlmConfig, LlmPlayerAgent, type LlmTransport } from "../../src/agents/llm";
import { RandomPlayerAgent } from "../../src/agents/random";
import type { PlayerAgent } from "../../src/agents/types";
import { BenchmarkSummary, LlmFallbackCounter } from "../../src/cli/benchmark-stats";
import { main, parseOptions } from "../../src/cli/cli";
import { MatchConfig, MatchResult, MatchRunner, SeededRandomSource } from "../../src/cli/match-runner";
import { Board, testEngine } from "../helpers/board";

function config(seed: number, maxHalfMoves: number, turnTimeoutMs = 30000): MatchConfig {
  const cfg = new MatchConfig();
  cfg.maxHalfMoves = maxHalfMoves;
  cfg.seed = seed;
  cfg.useRandomSeed = false;
  cfg.turnTimeoutMs = turnTimeoutMs;
  return cfg;
}

function runner(engine: RulesEngine, p1: PlayerAgent, p2: PlayerAgent): MatchRunner {
  return new MatchRunner(engine, p1, p2);
}

// ------------------------------------------------------------------ the match loop

describe("BenchmarkTests", () => {
  it("MatchRunner_PlaysDeterministicHeuristicGameToCompletion", async () => {
    const engine = testEngine();
    const p1 = new HeuristicPlayerAgent(PieceOwner.P1, "Heuristic", engine);
    const p2 = new HeuristicPlayerAgent(PieceOwner.P2, "Heuristic", engine);
    const cfg = config(20260919, 10000);

    const first = await runner(engine, p1, p2).runMatch(0, cfg);
    const again = await runner(engine, p1, p2).runMatch(0, cfg);

    expect(first.ruleViolationOccurred, first.errorMessage ?? undefined).toBe(false);
    expect(first.errorMessage, "a clean game reports no error").toBeNull();
    expect(first.hitTurnLimit, "two heuristics finish well inside the turn limit").toBe(false);
    expect(first.winner, "the game has to produce a winner").not.toBe(PieceOwner.None);
    expect(first.winReason).not.toBe(WinReason.None);
    expect(first.finalState?.gameOver).toBe(true);
    expect(first.totalHalfMoves).toBeGreaterThan(0);
    expect(first.totalHalfMoves, "one throw per half-move").toBe(first.totalDiceRolls);
    expect(engine.validateState(first.finalState as GameState), "the final board has to be sound").toEqual([]);

    // The whole point of a seeded harness: the same seed replays the same game.
    expect(again.winner).toBe(first.winner);
    expect(again.winReason).toBe(first.winReason);
    expect(again.totalHalfMoves).toBe(first.totalHalfMoves);
    expect(again.totalCaptures).toBe(first.totalCaptures);
  });

  it("MatchRunner_PlaysRandomBotMatchWithoutRuleViolations", async () => {
    const engine = testEngine();
    const p1 = new RandomPlayerAgent(PieceOwner.P1, "Random", new SeededRandomSource(1));
    const p2 = new RandomPlayerAgent(PieceOwner.P2, "Random", new SeededRandomSource(2));

    const result = await runner(engine, p1, p2).runMatch(0, config(20260919, 1000));

    expect(result.ruleViolationOccurred, result.errorMessage ?? undefined).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.totalHalfMoves).toBeGreaterThan(0);
    expect(result.finalState).not.toBeNull();
    expect(engine.validateState(result.finalState as GameState)).toEqual([]);
  });

  it("MatchRunner_PlaysHeuristicVersusTheShippedRandomBotToADecision", async () => {
    const games = 10;
    const engine = testEngine();
    const summary = new BenchmarkSummary();
    let worstGame = 0;

    for (let game = 0; game < games; game++) {
      const heuristic = new HeuristicPlayerAgent(PieceOwner.P1, "Heuristic", engine);
      const random = new RandomPlayerAgent(PieceOwner.P2, "Random", new SeededRandomSource(20260919 + game));
      const result = await runner(engine, heuristic, random).runMatch(game, config(1000 + game, 10000));

      expect(result.ruleViolationOccurred, `game ${game}: ${result.errorMessage}`).toBe(false);
      expect(result.errorMessage, `game ${game}: ${result.errorMessage}`).toBeNull();
      expect(engine.validateState(result.finalState as GameState), `game ${game} ended on a sound board`).toEqual([]);

      // The regression this pins: the shipped CPU used to re-throw every sáhkku, so it could never
      // spend one on activating a queued piece — once its loose soldiers were gone it had nothing legal
      // to play. With these seeds that left 9 of the 10 games grinding all 10,000 half-moves out into a
      // draw; the tenth ended in 16 half-moves, on a queen captured by the re-thrower itself.
      expect(result.hitTurnLimit, `game ${game} ran into the turn limit`).toBe(false);
      expect(result.winner, `game ${game} produced no winner`).not.toBe(PieceOwner.None);
      expect(result.winReason).not.toBe(WinReason.None);
      expect(result.finalState?.gameOver).toBe(true);

      summary.add(result);
      worstGame = Math.max(worstGame, result.totalHalfMoves);
    }

    expect(summary.draws, "a random opponent that can activate pieces still gets beaten").toBe(0);
    expect(summary.failures).toBe(0);
    expect(
      summary.averageHalfMoves,
      `games have to resolve far inside the cap, but averaged ${summary.averageHalfMoves} half-moves and the worst took ${worstGame}`,
    ).toBeLessThan(300);
  });

  it("MatchRunner_EnforcesTurnLimit", async () => {
    const engine = testEngine();
    // Two random bots capped at twenty half-moves: the point is the cap, so this pair is picked for the
    // game it plays — with these streams both sides are still mobilising when the cap arrives.
    const p1 = new RandomPlayerAgent(PieceOwner.P1, "Random", new SeededRandomSource(11));
    const p2 = new RandomPlayerAgent(PieceOwner.P2, "Random", new SeededRandomSource(12));

    const result = await runner(engine, p1, p2).runMatch(0, config(424242, 20));

    expect(result.hitTurnLimit, "the game has to stop at the cap").toBe(true);
    expect(result.totalHalfMoves, "the loop stops exactly at the cap").toBe(20);
    expect(result.winner).toBe(PieceOwner.None);
    expect(result.winReason).toBe(WinReason.None);
    expect(result.finalState?.gameOver, "a game that ran out of turns is not a finished game").toBe(false);
    expect(result.ruleViolationOccurred, result.errorMessage ?? undefined).toBe(false);
    expect(result.errorMessage, "a turn-limit draw is a result, not a failure").toBeNull();
    expect(engine.validateState(result.finalState as GameState)).toEqual([]);
  });

  it("MatchRunner_HeuristicOutperformsARandomOpponent", async () => {
    const games = 40;
    const baseSeed = 1000;

    // 22 of 40 is a floor chosen a comfortable distance under the measured rate, not a number fitted to
    // one sample.
    const minimumHeuristicWins = 22;

    const engine = testEngine();
    let heuristicWins = 0;

    for (let game = 0; game < games; game++) {
      // Both seats are played, so a seat's first-move advantage cannot decide the comparison.
      const heuristicIsP1 = game % 2 === 0;
      const opponentSeed = baseSeed * 31 + game;

      const heuristic = new HeuristicPlayerAgent(
        heuristicIsP1 ? PieceOwner.P1 : PieceOwner.P2,
        "Heuristic",
        engine,
      );
      const opponent = new KeepTheDiceRandomAgent(
        heuristicIsP1 ? PieceOwner.P2 : PieceOwner.P1,
        opponentSeed,
      );
      const match = runner(engine, heuristicIsP1 ? heuristic : opponent, heuristicIsP1 ? opponent : heuristic);

      const result = await match.runMatch(game, config(baseSeed + game, 1000));

      expect(result.ruleViolationOccurred, `game ${game}: ${result.errorMessage}`).toBe(false);
      expect(result.errorMessage, `game ${game}: ${result.errorMessage}`).toBeNull();
      expect(engine.validateState(result.finalState as GameState), `game ${game} ended on a sound board`).toEqual([]);

      if (result.winner !== PieceOwner.None && (result.winner === PieceOwner.P1) === heuristicIsP1) {
        heuristicWins++;
      }
    }

    expect(
      heuristicWins,
      `the heuristic has to win the clear majority of the matchups, but won only ${heuristicWins} of ${games}`,
    ).toBeGreaterThanOrEqual(minimumHeuristicWins);
  });

  // ------------------------------------------------------------------ the failure rules

  it("MatchRunner_RecordsAnIllegalProposalAsARuleViolationAndAborts", async () => {
    const engine = testEngine();
    const match = runner(
      engine,
      new IllegalMoveAgent(PieceOwner.P1),
      new HeuristicPlayerAgent(PieceOwner.P2, "Heuristic", engine),
    );

    const result = await match.runMatch(0, config(4242, 500));

    expect(result.ruleViolationOccurred, "an illegal proposal is a rule violation").toBe(true);
    expect(result.errorMessage).not.toBeNull();
    expect(result.errorMessage).toContain("not legal");
    expect(result.winner).toBe(PieceOwner.None);
    expect(result.winReason).toBe(WinReason.None);
    expect(result.hitTurnLimit, "the game was aborted, not drawn").toBe(false);
    expect(result.totalHalfMoves, "the game stops as soon as the violation happens").toBeLessThan(500);
    expect(engine.validateState(result.finalState as GameState), "the refused move never touched the board").toEqual([]);

    // A violation is what makes the run exit non-zero, so the summary has to carry it.
    const summary = new BenchmarkSummary();
    summary.add(result);
    expect(summary.ruleViolations).toBe(1);
    expect(summary.failures).toBe(1);
  });

  it("MatchRunner_RecordsAnAgentTimeoutAsAFailureWithoutAViolation", async () => {
    const engine = testEngine();
    const cfg = config(99, 200, 50);

    const slow = new SlowAgent(PieceOwner.P1);
    const cancellation = new AbortController();
    const match = runner(
      engine,
      slow,
      new HeuristicPlayerAgent(PieceOwner.P2, "Heuristic", engine),
    );

    const result = await match.runMatch(0, cfg, cancellation.signal);

    expect(result.ruleViolationOccurred, "a slow agent breaks the deadline, not the rules").toBe(false);
    expect(result.errorMessage).not.toBeNull();
    expect(result.errorMessage).toContain("AgentTimeoutError");
    expect(result.winner).toBe(PieceOwner.None);
    expect(slow.signal?.aborted).toBe(true);
    expect(slow.signal?.reason).toHaveProperty("name", "AgentTimeoutError");
    expect(cancellation.signal.aborted).toBe(false);

    const summary = new BenchmarkSummary();
    summary.add(result);
    expect(summary.ruleViolations).toBe(0);
    expect(summary.failures, "a failed game has to make the run exit non-zero").toBe(1);
  });

  it("MatchRunner_RejectsAgentsSeatedOnTheWrongSide", () => {
    const engine = testEngine();
    const first = new HeuristicPlayerAgent(PieceOwner.P1, "Heuristic", engine);
    const second = new HeuristicPlayerAgent(PieceOwner.P2, "Heuristic", engine);

    expect(() => runner(engine, second, first)).toThrow();
    expect(() => runner(engine, first, first)).toThrow();
    expect(() => runner(engine, first, null as unknown as PlayerAgent)).toThrow();
  });

  // ------------------------------------------------------------------ the seeded source

  it("SeededRandomSource_ReplaysASeedExactlyAndClampsTheLegacyDraw", () => {
    const first = new SeededRandomSource(-123456789);
    const again = new SeededRandomSource(-123456789);
    const other = new SeededRandomSource(987654321);

    const faces = Array.from({ length: 8 }, () => first.nextDieFaceIndex());
    expect(faces).toEqual(Array.from({ length: 8 }, () => again.nextDieFaceIndex()));
    expect(faces.every((face) => face >= 0 && face < 4)).toBe(true);
    expect(Array.from({ length: 8 }, () => other.nextDieFaceIndex())).not.toEqual(faces);

    // The legacy draw's contract: an empty range draws *below* its minimum, which is what the bot
    // clamps back to zero.
    expect(new SeededRandomSource(7).nextInt(3, 3), "an empty range draws below its minimum").toBe(2);
    const source = new SeededRandomSource(7);
    const draws = Array.from({ length: 32 }, () => source.nextInt(0, 4));
    expect(draws.every((draw) => draw >= 0 && draw < 4)).toBe(true);
  });

  // ------------------------------------------------------------------ the LLM fallback count

  it("LlmFallbackCounter_CountsEveryFallbackTheAgentLogs", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);
    expect(legalMoves.length, "the fixture has to offer a move choice").toBeGreaterThan(1);
    expect(engine.canReroll(board.state), "the fixture has to offer a re-roll").toBe(true);

    const counter = new LlmFallbackCounter();
    const log = (line: string): void => void counter.observe(line);

    // No endpoint at all.
    await llmAgent(engine, null, log).decideReroll(board.state);
    await llmAgent(engine, null, log).decideMove(board.state, legalMoves);
    expect(counter.count, "both 'no endpoint is configured' fallbacks have to be counted").toBe(2);

    // An endpoint that answers, but not with a decision the agent can use.
    const unusable = new ScriptedLlmTransport(chat("I am not sure what to play."));
    await llmAgent(engine, unusable, log).decideReroll(board.state);
    await llmAgent(engine, unusable, log).decideMove(board.state, legalMoves);
    expect(counter.count, "both 'did not answer with a usable ...' fallbacks have to be counted").toBe(4);

    // An endpoint that fails outright, which names the failure it absorbed.
    const failing = new ScriptedLlmTransport(chat("{}"));
    failing.failure = new Error("connection refused");
    await llmAgent(engine, failing, log).decideReroll(board.state);
    await llmAgent(engine, failing, log).decideMove(board.state, legalMoves);
    expect(counter.count, "both 'request failed (...)' fallbacks have to be counted").toBe(6);

    counter.reset();
    expect(counter.count, "a run reports each game on its own").toBe(0);
  });

  it("LlmFallbackCounter_IgnoresAFallbackSentenceQuotedInTheModelsReasoning", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const counter = new LlmFallbackCounter();
    const log = (line: string): void => void counter.observe(line);

    const moveEcho = new ScriptedLlmTransport(
      chat(
        '{"move_index": 1, "reasoning": "I was deciding heuristically, then the endpoint did not answer ' +
          'with a usable move index; playing the heuristic choice."}',
      ),
    );
    const chosen = await llmAgent(engine, moveEcho, log).decideMove(board.state, legalMoves);

    expect(chosen?.pieceId, "the model's own answer still decides the move").toBe(legalMoves[1].pieceId);
    expect(counter.count, "the model's reasoning is not the agent's fallback").toBe(0);

    const rerollEcho = new ScriptedLlmTransport(
      chat('{"reroll": false, "reasoning": "no endpoint is configured; deciding heuristically."}'),
    );
    expect(await llmAgent(engine, rerollEcho, log).decideReroll(board.state)).toBe(
      RerollDecision.KeepDiceAndProceed,
    );
    expect(counter.count, "a decision line that quotes a fallback is still a decision").toBe(0);
  });

  it("LlmFallbackCounter_NeedsTheAgentsOwnLogLine", () => {
    const counter = new LlmFallbackCounter();

    expect(counter.observe(null)).toBe(false);
    expect(counter.observe("")).toBe(false);
    expect(
      counter.observe("no endpoint is configured; deciding heuristically."),
      "a line without the agent's name prefix is not the agent's log",
    ).toBe(false);
    expect(
      counter.observe("NPC: the endpoint did not answer with a usable move index; playing the heuristic choice"),
      "the sentence has to be the one the agent logs, punctuation and all",
    ).toBe(false);
    expect(
      counter.observe(
        "NPC: chose move 0 of 4 (piece 1000 -> place 3): the move request failed (500); playing the heuristic choice.",
      ),
      "an echoed sentence sits in the middle of a decision line, where no fallback starts",
    ).toBe(false);
    expect(counter.count).toBe(0);

    expect(counter.observe("NPC: no endpoint is configured; deciding heuristically.")).toBe(true);
    expect(
      counter.observe("Sáhkku player: the move request failed (connection refused); playing the heuristic choice."),
      "a multi-word name still splits at the first separator",
    ).toBe(true);
    expect(counter.count).toBe(2);
  });

  // ------------------------------------------------------------------ the statistics

  it("BenchmarkStats_AggregatesResultsCorrectly", () => {
    const summary = new BenchmarkSummary();
    summary.add(resultOf(0, PieceOwner.P1, WinReason.QueenCaptured, 10, 2, 1));
    summary.add(resultOf(1, PieceOwner.P1, WinReason.OpponentSoldiersExhausted, 20, 4, 2));
    summary.add(resultOf(2, PieceOwner.P2, WinReason.QueenCaptured, 30, 6, 3));
    summary.add(resultOf(3, PieceOwner.None, WinReason.None, 40, 8, 0));

    expect(summary.totalGames).toBe(4);
    expect(summary.p1Wins).toBe(2);
    expect(summary.p2Wins).toBe(1);
    expect(summary.draws).toBe(1);
    expect(summary.p1WinRate).toBeCloseTo(0.5, 9);
    expect(summary.p2WinRate).toBeCloseTo(0.25, 9);
    expect(summary.averageHalfMoves).toBeCloseTo(25, 9);
    expect(summary.minHalfMoves).toBe(10);
    expect(summary.maxHalfMoves).toBe(40);
    expect(summary.totalHalfMoves).toBe(100);
    expect(summary.totalCaptures).toBe(20);
    expect(summary.totalLlmFallbacks).toBe(6);
    expect(summary.ruleViolations).toBe(0);
    expect(summary.failures).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("BenchmarkStats_ReportsFailuresAndFormatsBothForms", () => {
    const summary = new BenchmarkSummary();
    summary.add(resultOf(0, PieceOwner.P1, WinReason.QueenCaptured, 10, 2, 0));
    summary.add(resultOf(1, PieceOwner.P2, WinReason.QueenCaptured, 20, 4, 0));
    summary.add(resultOf(2, PieceOwner.None, WinReason.None, 30, 6, 0));

    const failed = resultOf(3, PieceOwner.None, WinReason.None, 4, 0, 0);
    failed.ruleViolationOccurred = true;
    failed.errorMessage = "rule violation: piece -1 -> place -1 is not legal.";
    summary.add(failed);

    const timedOut = resultOf(4, PieceOwner.None, WinReason.None, 7, 0, 0);
    timedOut.errorMessage = "TimeoutException: too slow";
    summary.add(timedOut);

    expect(summary.totalGames).toBe(5);
    expect(summary.draws).toBe(3);
    expect(summary.ruleViolations).toBe(1);
    expect(summary.failures).toBe(2);
    expect(summary.errors.length).toBe(2);
    expect(summary.minHalfMoves, "a failed game still counts towards the range").toBe(4);
    expect(summary.maxHalfMoves).toBe(30);

    const pretty = summary.toPrettyString("Heuristic", "Random");
    expect(pretty).toContain("Heuristic (P1) vs Random (P2)");
    expect(pretty).toContain("P1 wins (Heuristic)");
    expect(pretty).toContain("rule violations");
    expect(pretty).toContain("! game 3: rule violation: piece -1 -> place -1 is not legal.");
    expect(pretty).toContain("! game 4: TimeoutException: too slow");

    const json = summary.toJsonString("Heuristic", "Random");
    expect(json).toContain('"p1":"Heuristic"');
    expect(json).toContain('"p2":"Random"');
    expect(json).toContain('"totalGames":5');
    expect(json).toContain('"p1Wins":1');
    expect(json).toContain('"p2Wins":1');
    expect(json).toContain('"draws":3');
    expect(json).toContain('"p1WinRate":0.2');
    expect(json).toContain('"averageHalfMoves":14.2');
    expect(json).toContain('"minHalfMoves":4');
    expect(json).toContain('"ruleViolations":1');
    expect(json).toContain('"failures":2');
    expect(json).toContain('"errors":["game 3: rule violation');

    // The empty-run summary must still be printable, and must not divide by zero.
    const empty = new BenchmarkSummary();
    expect(empty.p1WinRate).toBeCloseTo(0, 9);
    expect(empty.toPrettyString("Heuristic", "Random").length).toBeGreaterThan(0);
    expect(empty.toJsonString("Heuristic", "Random")).toContain('"errors":[]');
  });
});

// ------------------------------------------------------------------ the CLI

describe("CliTests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureConsole(): { lines: string[]; errors: string[] } {
    const lines: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    return { lines, errors };
  }

  it("Cli_ParsesTheDocumentedFlagsAndRejectsTypos", () => {
    const parsed = parseOptions(["--games", "5", "--p1", "heuristic", "--p2", "random", "--seed", "42", "--json"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.games).toBe(5);
    expect(parsed.options.p1).toBe("heuristic");
    expect(parsed.options.p2).toBe("random");
    expect(parsed.options.seed).toBe(42);
    expect(parsed.options.useRandomSeed, "--seed makes the run reproducible").toBe(false);
    expect(parsed.options.json).toBe(true);
    expect(parsed.options.endpoint).toContain("/chat/completions");

    // A named flag beats the shared configuration; its value travels verbatim, because the URL is only
    // completed to the chat-completions path where the LLM agent is built.
    const explicit = parseOptions(["--endpoint", "http://example.test/v1", "--model", "tiny"]);
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      expect(explicit.options.endpoint).toBe("http://example.test/v1");
      expect(explicit.options.model).toBe("tiny");
    }

    for (const bad of [
      ["--games", "0"],
      ["--games"],
      ["--p1", "wizard"],
      ["--max-turns", "-3"],
      ["--seed", "abc"],
      ["--nonsense"],
    ]) {
      const rejected = parseOptions(bad);
      expect(rejected.ok, bad.join(" ")).toBe(false);
      if (!rejected.ok) expect(rejected.error.length).toBeGreaterThan(0);
    }
  });

  it("Cli_RunsABenchmarkSuiteHeadlesslyAndPrintsJson", async () => {
    const captured = captureConsole();

    const exitCode = await main([
      "--games",
      "2",
      "--p1",
      "easy",
      "--p2",
      "random",
      "--seed",
      "20260919",
      "--max-turns",
      "400",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(captured.lines.join("\n")) as Record<string, unknown>;
    expect(summary.totalGames).toBe(2);
    expect(summary.ruleViolations).toBe(0);
    expect(summary.failures).toBe(0);
    expect(summary.p1).toBe("Heuristic (easy)");
    expect(summary.p2).toBe("Random");
    expect(Number(summary.totalHalfMoves)).toBeGreaterThan(0);
  });

  it("Cli_RunsASeatedHumanMatchAndPrintsTheTable", async () => {
    const captured = captureConsole();

    // A `human` seat has no presentation layer in the harness, so it plays the shape an unanswered UI
    // produces: keep the dice and take the first legal move the engine offered.
    const exitCode = await main([
      "--games",
      "1",
      "--p1",
      "human",
      "--p2",
      "easy",
      "--seed",
      "3",
      "--max-turns",
      "200",
    ]);

    expect(exitCode).toBe(0);
    const table = captured.lines.join("\n");
    expect(table).toContain("Sáhkku benchmark: Human (P1) vs Heuristic (easy) (P2)");
    expect(table).toContain("rule violations");
  });

  it("Cli_ReportsBadArgumentsAndHelpWithoutRunningAGame", async () => {
    const captured = captureConsole();

    expect(await main(["--games", "lots"])).toBe(1);
    expect(captured.errors.join("\n")).toContain("--games needs a positive integer");

    expect(await main(["--help"])).toBe(0);
    expect(captured.lines.join("\n")).toContain("npm run bench");
  });
});

// ------------------------------------------------------------------ the scripted endpoint

/** Stands in for the HTTP transport under the real `LlmPlayerAgent`, so the fallback count can be pinned. */
class ScriptedLlmTransport implements LlmTransport {
  /** Thrown instead of answering, e.g. a connection refusal the fetch transport surfaced. */
  failure: Error | null = null;

  private readonly responseBody: string;

  constructor(responseBody: string) {
    this.responseBody = responseBody;
  }

  postChatCompletion(): Promise<string> {
    if (this.failure != null) return Promise.reject(this.failure);
    return Promise.resolve(this.responseBody);
  }
}

/** An OpenAI-compatible chat-completion body whose single message is `content`. */
function chat(content: string): string {
  return `{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":${JSON.stringify(content)}},"finish_reason":"stop"}]}`;
}

/** A board that offers the player a choice of moves and the option to re-throw the sáhkku die. */
function boardWithChoices(engine: RulesEngine): Board {
  const board = new Board(engine);
  board.addOnArc(10, PieceType.Soldier, PieceOwner.P1, true);
  board.addOnArc(40, PieceType.Soldier, PieceOwner.P1, true);
  board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
  board.phase(TurnPhase.P1move);
  return board;
}

/** An LLM agent logging into `log`, which is where the counter reads from. */
function llmAgent(engine: RulesEngine, transport: LlmTransport | null, log: (line: string) => void): LlmPlayerAgent {
  return new LlmPlayerAgent(PieceOwner.P1, "NPC", transport, new LlmConfig(), engine, log);
}

// ------------------------------------------------------------------ the test agents

/**
 * The strength baseline: uniform random legal moves, keeping whatever it rolled. Deterministic from its
 * seed, and weak by construction — it never re-rolls, so a sáhkku is only ever played as it fell. Kept
 * apart from `RandomPlayerAgent` so the comparison does not ride on the shipped CPU's own coin flips.
 */
class KeepTheDiceRandomAgent implements PlayerAgent {
  readonly owner: PieceOwner;
  readonly name = "Random (keeps the dice)";

  private readonly random: SeededRandomSource;

  constructor(owner: PieceOwner, seed: number) {
    this.owner = owner;
    this.random = new SeededRandomSource(seed);
  }

  decideReroll(): Promise<RerollDecision> {
    return Promise.resolve(RerollDecision.KeepDiceAndProceed);
  }

  decideMove(_state: GameState, legalMoves: readonly Move[]): Promise<Move | null> {
    if (legalMoves.length === 0) return Promise.resolve(null);
    return Promise.resolve(legalMoves[this.random.nextInt(0, legalMoves.length)]);
  }
}

/** Proposes a move that cannot be legal, to pin the violation path end to end. */
class IllegalMoveAgent implements PlayerAgent {
  readonly owner: PieceOwner;
  readonly name = "Illegal";

  constructor(owner: PieceOwner) {
    this.owner = owner;
  }

  decideReroll(): Promise<RerollDecision> {
    return Promise.resolve(RerollDecision.KeepDiceAndProceed);
  }

  decideMove(): Promise<Move | null> {
    // Neither -1 is a piece or a place the engine knows, whatever the legal list holds.
    return Promise.resolve(new Move(-1, -1));
  }
}

/** Never answers inside the deadline, to pin the per-turn timeout rule. */
class SlowAgent implements PlayerAgent {
  readonly owner: PieceOwner;
  readonly name = "Slow";
  signal: AbortSignal | undefined;

  constructor(owner: PieceOwner) {
    this.owner = owner;
  }

  decideReroll(_state: GameState, signal?: AbortSignal): Promise<RerollDecision> {
    return this.waitForCancellation(signal);
  }

  decideMove(_state: GameState, _legalMoves: readonly Move[], signal?: AbortSignal): Promise<Move | null> {
    return this.waitForCancellation(signal);
  }

  private waitForCancellation(signal?: AbortSignal): Promise<never> {
    if (!signal) throw new Error("The runner must supply a decision abort signal.");
    this.signal = signal;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultOf(
  index: number,
  winner: PieceOwner,
  reason: WinReason,
  halfMoves: number,
  captures: number,
  llmFallbacks: number,
): MatchResult {
  const result = new MatchResult();
  result.matchIndex = index;
  result.winner = winner;
  result.winReason = reason;
  result.totalHalfMoves = halfMoves;
  result.totalCaptures = captures;
  result.llmFallbacks = llmFallbacks;
  return result;
}
