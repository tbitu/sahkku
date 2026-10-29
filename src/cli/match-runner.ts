/**
 * The headless match runner: the 1:1 port of the retired C# `MatchRunner`.
 *
 * It drives one game to its end — roll, ask the active agent about the optional re-roll, ask it for its
 * move, hand every action to the engine — and runs off-engine, so a benchmark needs neither a browser nor
 * a renderer. The runner decides no rule and mutates no board itself: the engine stays the sole authority
 * and every proposal is checked against it first, so a broken agent can only ever produce a reported
 * failure, never a corrupted board.
 */

import {
  EngineOptions,
  GameState,
  IllegalMoveException,
  Move,
  PieceOwner,
  RerollDecision,
  WinReason,
  type IRandomSource,
} from "../rules/domain";
import type { RulesEngine } from "../rules/engine";
import type { BotRandomSource, PlayerAgent } from "../agents/types";

/**
 * The knobs one benchmark run turns.
 *
 * The defaults mirror the shipped game — the even-odds setup, player one to move — and add a base seed,
 * a turn cap and a per-turn deadline: an offline harness has to be replayable, and it has to end even
 * when an agent misbehaves.
 */
export class MatchConfig {
  /** How many rolls one game may take before it is declared a turn-limit draw. */
  maxHalfMoves = 10000;

  /** Base seed; each game of a run derives its own stream from `seed + matchIndex`. */
  seed = 0;

  /** When true the seed comes from the clock instead of `seed`. */
  useRandomSeed = true;

  /** Who moves first, unless `throwForStartingPlayer` is set. */
  startingPlayer: PieceOwner = PieceOwner.P1;

  /** When true the engine throws for the starting player, as the ruleset prescribes. */
  throwForStartingPlayer = false;

  /** Deadline in milliseconds for a single agent decision; zero or a negative value disables it. */
  turnTimeoutMs = 30000;

  /**
   * Plays the ruleset's even-odds variant — the setup the shipped game starts from, in which both players
   * already have three soldiers loose. With it off, both sides start fully queued and a game takes far
   * longer to leave its home row.
   */
  evenOdds = true;
}

/** Everything one benchmark game did. The runner owns this record and nothing else writes to it. */
export class MatchResult {
  matchIndex = 0;

  /** The winner, or `PieceOwner.None` for a draw (turn limit) or a failed game. */
  winner: PieceOwner = PieceOwner.None;

  winReason: WinReason = WinReason.None;

  /** Rolls spent in the game, i.e. the turn counter the turn limit measures. */
  totalHalfMoves = 0;

  /** Throws of the dice; a re-throw of one die counts as a re-roll instead (`totalRerollDecisions`). */
  totalDiceRolls = 0;

  /** Times an agent was asked whether to keep or re-throw the sáhkku die. */
  totalRerollDecisions = 0;

  totalCaptures = 0;

  /** Wall-clock time the game took, every agent decision included. */
  durationMs = 0;

  /** `null` on a clean game, the reason the game was aborted otherwise. */
  errorMessage: string | null = null;

  /** True when an agent proposed an illegal move or a state invariant broke. */
  ruleViolationOccurred = false;

  /** True when the game ended by reaching `MatchConfig.maxHalfMoves`. */
  hitTurnLimit = false;

  /** How often an LLM agent gave up on its endpoint and played the heuristic choice. */
  llmFallbacks = 0;

  /** The final board, so a caller can print it or assert on it. Set once the game has started. */
  finalState: GameState | null = null;

  /** True when the game did not complete cleanly, whether by rule violation or by an agent/timeout error. */
  get failed(): boolean {
    return this.errorMessage != null && this.errorMessage.length > 0;
  }
}

/**
 * Deterministic randomness for a benchmark run: the engine's die faces and the random bot's draws come
 * from one small generator, so replaying a seed replays the games exactly. SplitMix64 is written out
 * rather than borrowed from the platform so a runtime upgrade cannot silently change a seed's games.
 *
 * The 64-bit state is kept in a `bigint` because JavaScript numbers cannot represent it exactly; the
 * arithmetic is masked to 64 bits after every step, exactly like the reference implementation's
 * `unchecked` unsigned operations.
 */
export class SeededRandomSource implements IRandomSource, BotRandomSource {
  private static readonly Mask64 = (1n << 64n) - 1n;
  private static readonly GoldenGamma = 0x9e3779b97f4a7c15n;
  private static readonly Mix1 = 0xbf58476d1ce4e5b9n;
  private static readonly Mix2 = 0x94d049bb133111ebn;

  /** The number of die faces `IRandomSource.nextDieFaceIndex` promises: an index in [0, 4). */
  private static readonly DieFaceCount = 4;

  private state: bigint;

  constructor(seed: number) {
    this.state =
      (BigInt.asUintN(64, BigInt(Math.trunc(seed))) * SeededRandomSource.GoldenGamma +
        SeededRandomSource.Mix1) &
      SeededRandomSource.Mask64;
  }

  /** A die face index in [0, 4), which the engine maps through its ruleset's face table. */
  nextDieFaceIndex(): number {
    return Number(this.next() % BigInt(SeededRandomSource.DieFaceCount));
  }

  /** A draw in `[minimumInclusive, maximumExclusive)`; below zero when the range is empty. */
  nextInt(minimumInclusive: number, maximumExclusive: number): number {
    if (maximumExclusive <= minimumInclusive) return minimumInclusive - 1;
    const span = BigInt(maximumExclusive - minimumInclusive);
    return minimumInclusive + Number(this.next() % span);
  }

  private next(): bigint {
    this.state = (this.state + SeededRandomSource.GoldenGamma) & SeededRandomSource.Mask64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * SeededRandomSource.Mix1) & SeededRandomSource.Mask64;
    z = ((z ^ (z >> 27n)) * SeededRandomSource.Mix2) & SeededRandomSource.Mask64;
    return z ^ (z >> 31n);
  }
}

/**
 * Raised inside the runner when an agent or the engine produced something the harness must not paper
 * over. It always ends the game with a recorded failure and never escapes `MatchRunner`.
 */
export class RuleViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleViolationError";
  }
}

/** Raised when an agent did not answer inside `MatchConfig.turnTimeoutMs`. */
export class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTimeoutError";
  }
}

export class MatchRunner {
  /**
   * How often one throw may be re-thrown before the agent is treated as broken. A re-roll replaces the
   * die and re-orders the dice, so a fair source ends the loop quickly; the cap is only there to catch
   * an agent that answers "re-roll" forever.
   */
  static readonly MaxRerollDecisionsPerThrow = 64;

  private readonly engine: RulesEngine;
  private readonly p1Agent: PlayerAgent;
  private readonly p2Agent: PlayerAgent;

  constructor(engine: RulesEngine, p1Agent: PlayerAgent, p2Agent: PlayerAgent) {
    if (engine == null) throw new Error("engine is required.");
    if (p1Agent == null) throw new Error("p1Agent is required.");
    if (p2Agent == null) throw new Error("p2Agent is required.");
    if (p1Agent.owner !== PieceOwner.P1) {
      throw new Error(`The agent for the first slot must own P1, not ${PieceOwner[p1Agent.owner]}.`);
    }
    if (p2Agent.owner !== PieceOwner.P2) {
      throw new Error(`The agent for the second slot must own P2, not ${PieceOwner[p2Agent.owner]}.`);
    }

    this.engine = engine;
    this.p1Agent = p1Agent;
    this.p2Agent = p2Agent;
  }

  /**
   * Plays one game. The result always describes what happened: a decisive winner, a turn-limit draw, or —
   * with `MatchResult.errorMessage` set — a game the harness refused to continue (an illegal proposal, a
   * broken invariant, an agent that timed out or never stopped re-rolling). A cancellation of `signal` is
   * the one thing that propagates, because that is the caller ending the run rather than a game failing.
   */
  async runMatch(matchIndex: number, config: MatchConfig | null = null, signal?: AbortSignal): Promise<MatchResult> {
    const effective = config ?? new MatchConfig();
    const result = new MatchResult();
    result.matchIndex = matchIndex;
    const startedAt = Date.now();

    try {
      const random = createRandomSource(effective, matchIndex);
      const options = new EngineOptions(
        effective.startingPlayer,
        effective.evenOdds,
        effective.throwForStartingPlayer,
      );
      const state = this.engine.initGame(options, random);
      result.finalState = state;

      let halfMoves = 0;
      while (!state.gameOver && halfMoves < effective.maxHalfMoves) {
        throwIfAborted(signal);

        if (state.isRollPhase) {
          this.engine.rollDice(state, random);
          result.totalDiceRolls++;
          result.totalHalfMoves = ++halfMoves;
        }

        await this.resolveRerolls(state, effective, random, result, signal);
        await this.playMovePhase(state, effective, result, signal);
      }

      if (state.gameOver) {
        result.winner = state.winner;
        result.winReason = state.winReason;
      } else {
        // The missing-data rule: a game that runs past the cap is a draw, not a crash, and the engine's
        // state is left exactly as it was so a caller can still inspect it.
        result.hitTurnLimit = true;
        result.winner = PieceOwner.None;
        result.winReason = WinReason.None;
      }

      result.totalCaptures = state.p1Captures + state.p2Captures;

      const problems = this.engine.validateState(state);
      if (problems.length > 0) {
        throw new RuleViolationError(
          `the board is not sound at the end of the game: ${problems.join("; ")}`,
        );
      }
    } catch (error) {
      if (error instanceof RuleViolationError) {
        markViolation(result, error.message);
      } else if (error instanceof IllegalMoveException) {
        // Never silenced: an illegal move reaching the engine means an agent bypassed the legality check,
        // which is exactly the failure a benchmark exists to catch.
        markViolation(result, error.message);
      } else if (signal?.aborted === true) {
        throw error;
      } else {
        // A timeout, a failed decision, or an agent that never converged: the game is aborted with the
        // reason recorded and the runner's own bookkeeping stays intact.
        result.winner = PieceOwner.None;
        result.winReason = WinReason.None;
        result.errorMessage = `${errorName(error)}: ${messageOf(error)}`;
      }
    }

    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // ------------------------------------------------------------------ the turn loop

  /**
   * Asks the active agent about the sáhkku re-roll until the engine stops offering one, and applies every
   * answer through `RulesEngine.applyRerollDecision`. Keeping the dice closes the question for this throw;
   * re-throwing it can open it again, which is why the loop counts.
   */
  private async resolveRerolls(
    state: GameState,
    config: MatchConfig,
    random: IRandomSource,
    result: MatchResult,
    signal?: AbortSignal,
  ): Promise<void> {
    let decisions = 0;
    while (!state.gameOver && this.engine.canReroll(state)) {
      if (++decisions > MatchRunner.MaxRerollDecisionsPerThrow) {
        throw new Error(
          `the re-roll decision did not settle after ${MatchRunner.MaxRerollDecisionsPerThrow} rounds.`,
        );
      }

      const agent = this.agentFor(state.currentPlayer);
      const decision = await withDeadline(
        config,
        decisionSignal => agent.decideReroll(state, decisionSignal),
        signal,
      );

      result.totalRerollDecisions++;

      // The engine validates the decision as well: "re-roll" outside canReroll is refused, so an agent
      // cannot re-throw a die the ruleset has closed.
      this.engine.applyRerollDecision(
        state,
        decision,
        decision === RerollDecision.RerollActiveDie ? random : null,
      );
    }
  }

  /**
   * Plays out the move phase: it asks the current agent for one of the moves the engine declared legal,
   * checks it, and applies it. When a thrown die leaves nobody able to move, the turn is handed over — the
   * ruleset forbids skipping a die value, so an unusable throw simply ends the turn.
   */
  private async playMovePhase(
    state: GameState,
    config: MatchConfig,
    result: MatchResult,
    signal?: AbortSignal,
  ): Promise<void> {
    while (!state.gameOver && !state.isRollPhase) {
      const legalMoves = this.engine.legalMoves(state);
      if (legalMoves.length === 0) {
        this.engine.nextPlayerTurn(state);
        return;
      }

      const agent = this.agentFor(state.currentPlayer);
      const move: Move | null = await withDeadline(
        config,
        decisionSignal => agent.decideMove(state, legalMoves, decisionSignal),
        signal,
      );

      // The engine is the authority. A proposal outside the legal list is a critical violation and aborts
      // the game: substituting a different move here would hide the very defect being measured.
      if (move == null || !this.engine.isLegalMove(state, move)) {
        throw new RuleViolationError(
          `${agent.name} proposed ${move}, which is not legal (${legalMoves.length} legal moves were offered).`,
        );
      }

      this.engine.applyMove(state, move);

      const problems = this.engine.validateState(state);
      if (problems.length > 0) {
        throw new RuleViolationError(`the board is not sound after ${move}: ${problems.join("; ")}`);
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private agentFor(owner: PieceOwner): PlayerAgent {
    return owner === PieceOwner.P2 ? this.p2Agent : this.p1Agent;
  }
}

/**
 * Gives each decision an isolated abort signal. A timeout stops search/fallback work without
 * cancelling the whole run, and is reported as this game's failure.
 */
function withDeadline<T>(
  config: MatchConfig, decide: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolveDecision, rejectDecision) => {
    const controller = new AbortController();
    const timer = config.turnTimeoutMs > 0 ? setTimeout(() => {
      const error = new AgentTimeoutError(`the agent did not decide within ${config.turnTimeoutMs}ms.`);
      controller.abort(error);
      settle();
      rejectDecision(error);
    }, config.turnTimeoutMs) : undefined;

    const onAbort = (): void => {
      controller.abort(signal?.reason);
      settle();
      rejectDecision(signal?.reason ?? new Error("The match was cancelled."));
    };
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => decide(controller.signal)).then(
      (value) => {
        settle();
        resolveDecision(value);
      },
      (error: unknown) => {
        settle();
        rejectDecision(error);
      },
    );
  });
}

function createRandomSource(config: MatchConfig, matchIndex: number): IRandomSource & BotRandomSource {
  const seed = config.useRandomSeed
    ? (Date.now() + matchIndex * 7919) | 0
    : (config.seed + matchIndex) | 0;
  return new SeededRandomSource(seed);
}

function markViolation(result: MatchResult, message: string): void {
  result.ruleViolationOccurred = true;
  result.winner = PieceOwner.None;
  result.winReason = WinReason.None;
  result.errorMessage = `rule violation: ${message}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("The match was cancelled.");
  }
}
