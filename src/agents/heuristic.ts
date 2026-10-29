/**
 * Difficulty-aware whole-game opponent. The synchronous static methods retain the historical greedy
 * policy as an explicit emergency fallback and benchmark reference; normal decisions use turn search.
 */

import {
  GameState,
  Move,
  PieceOwner,
  PieceType,
  RerollDecision,
  RuleEventKind,
  type Piece,
} from "../rules/domain";
import type { RulesEngine } from "../rules/engine";
import type { BotRandomSource, PlayerAgent } from "./types";
import {
  searchDecision, type HeuristicDifficulty, type SearchDiagnostics, type SearchExecutor,
  type SearchOptions, type SearchResult,
  armyKey,
} from "./search";

export interface HeuristicOptions {
  difficulty?: HeuristicDifficulty;
  random?: BotRandomSource | null;
  executor?: SearchExecutor;
  log?: ((message: string) => void) | null;
  onSearch?: (diagnostics: SearchDiagnostics, durationMs: number) => void;
}

export class HeuristicPlayerAgent implements PlayerAgent {
  /** Landing on the enemy queen ends the game, so it dominates every other consideration. */
  static readonly CapturingQueenScore = 10000;

  /** Per opponent piece/die-face capture opportunity removed (or added, as a penalty). */
  static readonly SavingQueenScore = 5000;

  static readonly CapturingSoldierScore = 500;
  static readonly RecruitingKingScore = 400;
  static readonly ActivatingPieceScore = 300;

  /** Per track step advanced towards the opponent's territory. */
  static readonly AdvancePerStepScore = 10;

  static readonly QueenHomeRowScore = 40;

  readonly owner: PieceOwner;
  readonly name: string;

  private readonly engine: RulesEngine | null;
  readonly difficulty: HeuristicDifficulty;
  lastSearch: SearchDiagnostics | null = null;
  readonly searchStats: {
    decisions: number; nodes: number; budgetLimits: number; failures: number; durationMs: number;
    completedTurns: Record<string, number>;
  } = {
    decisions: 0, nodes: 0, budgetLimits: 0, failures: 0, durationMs: 0,
    completedTurns: {},
  };
  private readonly options: HeuristicOptions;
  private readonly recentPositions: string[] = [];

  constructor(
    owner: PieceOwner, name: string | null = null, engine: RulesEngine | null = null,
    options: HeuristicOptions = {},
  ) {
    this.owner = owner;
    this.difficulty = options.difficulty ?? "medium";
    this.name = name ?? `Heuristic (${this.difficulty})`;
    this.engine = engine;
    this.options = options;
  }

  async decideReroll(state: GameState, signal?: AbortSignal): Promise<RerollDecision> {
    signal?.throwIfAborted();
    if (!this.engine || this.difficulty === "easy") {
      return HeuristicPlayerAgent.chooseReroll(this.engine, state);
    }
    const result = await this.search(state, {
      difficulty: this.difficulty, action: "reroll", signal, random: this.options.random,
      tieSeed: this.options.random?.nextInt(0, 0x7fffffff) ?? 0,
    });
    return result?.reroll ?? HeuristicPlayerAgent.chooseReroll(this.engine, state);
  }

  async decideMove(
    state: GameState, legalMoves: readonly Move[], signal?: AbortSignal,
  ): Promise<Move | null> {
    signal?.throwIfAborted();
    if (!this.engine || !legalMoves.length) {
      return HeuristicPlayerAgent.chooseMove(this.engine, state, legalMoves);
    }
    const position = armyKey(state);
    if (this.recentPositions.at(-1) !== position) {
      this.recentPositions.push(position);
      if (this.recentPositions.length > 16) this.recentPositions.shift();
    }
    const result = await this.search(state, {
      difficulty: this.difficulty, action: "move", moves: legalMoves, signal,
      random: this.options.random,
      tieSeed: this.options.random?.nextInt(0, 0x7fffffff) ?? 0,
      recentPositions: this.recentPositions,
    });
    return result?.move ?? HeuristicPlayerAgent.chooseMove(this.engine, state, legalMoves);
  }

  private async search(state: GameState, options: SearchOptions): Promise<SearchResult | null> {
    if (!this.engine) throw new Error("Search requires a rules engine.");
    const started = performance.now();
    try {
      const result = await (this.options.executor ?? searchDecision)(this.engine, state, options);
      if (options.action === "move" && options.moves?.length &&
          (!result.move || !this.engine.isLegalMove(state, result.move))) {
        throw new Error("Search returned an illegal or missing move.");
      }
      this.lastSearch = result.diagnostics;
      this.searchStats.decisions++;
      this.searchStats.nodes += result.diagnostics.nodes;
      this.searchStats.budgetLimits += Number(result.diagnostics.budgetExhausted);
      this.searchStats.durationMs += performance.now() - started;
      const depth = String(result.diagnostics.completedTurns);
      this.searchStats.completedTurns[depth] = (this.searchStats.completedTurns[depth] ?? 0) + 1;
      this.options.onSearch?.(result.diagnostics, performance.now() - started);
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      this.searchStats.failures++;
      const message = `${this.name}: search failed (${error instanceof Error ? error.message : String(error)}); using the emergency heuristic.`;
      if (this.options.log) this.options.log(message);
      else console.error(message);
      this.lastSearch = null;
      return null;
    }
  }

  /**
   * The engine-free re-roll policy: keep the sáhkku when it buys something concrete (a piece that can
   * be activated with it, or a queen that has to be walked out of danger), otherwise throw it again
   * hoping for a die that goes further.
   */
  static chooseReroll(engine: RulesEngine | null, state: GameState | null): RerollDecision {
    if (engine == null || state == null) return RerollDecision.KeepDiceAndProceed;
    if (!engine.canReroll(state)) return RerollDecision.KeepDiceAndProceed;

    const owner = state.currentPlayer;
    if (canActivateAPiece(engine, state, owner)) return RerollDecision.KeepDiceAndProceed;
    if (countQueenThreats(engine, state, owner) > 0) return RerollDecision.KeepDiceAndProceed;
    return RerollDecision.RerollActiveDie;
  }

  /** The highest scoring of `legalMoves`; ties go to the first one, so the choice is stable. */
  static chooseMove(
    engine: RulesEngine | null,
    state: GameState | null,
    legalMoves: readonly Move[],
  ): Move | null {
    if (legalMoves.length === 0) return null;
    if (engine == null || state == null) return legalMoves[0];

    let best: Move = legalMoves[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const move of legalMoves) {
      const score = scoreMove(engine, state, move);
      if (score > bestScore) {
        bestScore = score;
        best = move;
      }
    }
    return best;
  }
}

/** True when the sáhkku up for spending can move (i.e. activate) a piece that is still waiting. */
function canActivateAPiece(engine: RulesEngine, state: GameState, owner: PieceOwner): boolean {
  for (const place of state.places) {
    for (const piece of place.pieces) {
      if (piece.owner !== owner || piece.isActive || !piece.canBeActivated) continue;
      if (engine.getAllowedPlaces(state, piece).length > 0) return true;
    }
  }
  return false;
}

/**
 * Counts opponent piece/die-face pairs that can capture the queen in one move. The engine's landing
 * rules also account for inactive queens being protected until activated.
 */
function countQueenThreats(engine: RulesEngine, state: GameState, owner: PieceOwner): number {
  const queen = findPiece(state, owner, PieceType.Queen);
  if (queen == null) return 0;

  const opponent = owner === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;
  const rules = engine.rules;
  let threats = 0;
  const probe = state.clone();
  probe.currentActiveDie = 0;
  for (const face of rules.dice.faces) {
    if (face.steps === 0) continue;

    probe.dice[0] = rules.resolveFace(face.id);

    for (const place of probe.places) {
      for (const candidate of place.pieces) {
        if (candidate.owner !== opponent) continue;
        if (engine.getAllowedPlaces(probe, candidate).includes(queen.placeIndex)) threats++;
      }
    }
  }
  return threats;
}

function scoreMove(engine: RulesEngine, state: GameState, move: Move): number {
  const piece = engine.findPiece(state, move.pieceId);
  if (piece == null) return Number.NEGATIVE_INFINITY;

  const owner = piece.owner;
  const threatsBefore = countQueenThreats(engine, state, owner);
  const wasInactive = !piece.isActive;
  const sourceArc = piece.arc;

  const clone = state.clone();
  const outcome = engine.tryApplyMove(clone, move);
  if (!outcome.success) return Number.NEGATIVE_INFINITY;
  if (clone.gameOver && clone.winner === owner) return Number.POSITIVE_INFINITY;

  let score = 0;
  for (const ruleEvent of outcome.events) {
    switch (ruleEvent.kind) {
      case RuleEventKind.QueenCaptured:
        score += HeuristicPlayerAgent.CapturingQueenScore;
        break;
      case RuleEventKind.SoldierCaptured:
        score += HeuristicPlayerAgent.CapturingSoldierScore;
        break;
      case RuleEventKind.KingRecruited:
        score += HeuristicPlayerAgent.RecruitingKingScore;
        break;
      default:
        break;
    }
  }

  if (wasInactive) score += HeuristicPlayerAgent.ActivatingPieceScore;

  const moved = engine.findPiece(clone, move.pieceId);
  const advanced = moved == null ? 0 : forwardSteps(engine.trackLength, sourceArc, moved.arc);
  score += advanced * HeuristicPlayerAgent.AdvancePerStepScore;

  const threatsAfter = countQueenThreats(engine, clone, owner);
  score += (threatsBefore - threatsAfter) * HeuristicPlayerAgent.SavingQueenScore;
  const queen = findPiece(clone, owner, PieceType.Queen);
  if (queen?.isActive && clone.places[queen.placeIndex].y === engine.homeRowOf(owner)) {
    score += HeuristicPlayerAgent.QueenHomeRowScore;
  }
  return score;
}

/**
 * How far forward a move carried the piece, in track steps. A backwards move wraps around the track, so
 * anything past the longest die (three) is not counted as progress.
 */
function forwardSteps(trackLength: number, fromArc: number, toArc: number): number {
  if (trackLength <= 0) return 0;
  const delta = (((toArc - fromArc) % trackLength) + trackLength) % trackLength;
  return delta <= 3 ? delta : 0;
}

function findPiece(state: GameState, owner: PieceOwner, type: PieceType): Piece | null {
  for (const place of state.places) {
    for (const piece of place.pieces) {
      if (piece.owner === owner && piece.type === type) return piece;
    }
  }
  return null;
}
