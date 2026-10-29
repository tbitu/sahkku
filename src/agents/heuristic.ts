/**
 * The deterministic bot: the 1:1 port of the retired C# `HeuristicPlayerAgent`.
 *
 * It is the controller's fallback whenever another agent fails to answer, so it has to be total,
 * synchronous and reproducible: it scores every legal move with the weights below and takes the
 * highest-scoring one, ties going to the first candidate. Nothing here mutates the live state — every
 * probe runs on a `GameState.clone()`.
 *
 * The weights are the reference implementation's own. They are larger and more finely graded than the
 * "+100 soldier / +1000 queen / +500 queen-safety" summary in the task's L1 contract, and unlike that
 * summary they include an activation bonus; the reference's values are kept because this task is a
 * port and the ported tests (`tests/agents/player-agents.test.ts`, `tests/cli/bench.test.ts`) pin the
 * resulting ordering — in particular "prefer activating a waiting soldier over a simple advance",
 * which a scoring table without `ActivatingPieceScore` cannot express.
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
import type { PlayerAgent } from "./types";

export class HeuristicPlayerAgent implements PlayerAgent {
  /** Landing on the enemy queen ends the game, so it dominates every other consideration. */
  static readonly CapturingQueenScore = 10000;

  /** Getting the queen out of immediate danger. */
  static readonly SavingQueenScore = 5000;

  /** Bonus for activating the queen specifically: it's the game-winning piece. */
  static readonly ActivatingQueenBonus = 100;

  static readonly CapturingSoldierScore = 500;
  static readonly RecruitingKingScore = 400;
  static readonly ActivatingPieceScore = 300;

  /** Per track step advanced towards the opponent's territory. */
  static readonly AdvancePerStepScore = 10;

  readonly owner: PieceOwner;
  readonly name: string;

  private readonly engine: RulesEngine | null;

  constructor(owner: PieceOwner, name: string | null = null, engine: RulesEngine | null = null) {
    this.owner = owner;
    this.name = name ?? "Heuristic";
    this.engine = engine;
  }

  decideReroll(state: GameState): Promise<RerollDecision> {
    return Promise.resolve(HeuristicPlayerAgent.chooseReroll(this.engine, state));
  }

  decideMove(state: GameState, legalMoves: readonly Move[]): Promise<Move | null> {
    return Promise.resolve(HeuristicPlayerAgent.chooseMove(this.engine, state, legalMoves));
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
    if (isQueenThreatened(engine, state, owner)) return RerollDecision.KeepDiceAndProceed;
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
 * True when any opponent piece could land on the queen with the next throw. The probe runs on a clone,
 * because it has to try every die face on a board that is otherwise untouched.
 */
function isQueenThreatened(engine: RulesEngine, state: GameState, owner: PieceOwner): boolean {
  const queen = findPiece(state, owner, PieceType.Queen);
  if (queen == null) return false;

  const opponent = owner === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;
  const rules = engine.rules;
  for (const face of rules.dice.faces) {
    if (face.steps === 0) continue;

    const probe = state.clone();
    if (probe.dice.length === 0) return false;
    probe.currentActiveDie = 0;
    probe.dice[0] = rules.resolveFace(face.id);

    for (const place of probe.places) {
      for (const candidate of place.pieces) {
        if (candidate.owner !== opponent) continue;
        if (engine.getAllowedPlaces(probe, candidate).includes(queen.placeIndex)) return true;
      }
    }
  }
  return false;
}

function scoreMove(engine: RulesEngine, state: GameState, move: Move): number {
  const piece = engine.findPiece(state, move.pieceId);
  if (piece == null) return Number.NEGATIVE_INFINITY;

  const owner = piece.owner;
  const queenWasThreatened = isQueenThreatened(engine, state, owner);
  const wasInactive = !piece.isActive;
  const sourceArc = piece.arc;

  const clone = state.clone();
  const outcome = engine.tryApplyMove(clone, move);
  if (!outcome.success) return Number.NEGATIVE_INFINITY;

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

  if (wasInactive && piece.type === PieceType.Queen) {
    score += HeuristicPlayerAgent.ActivatingQueenBonus;
  }

  const moved = engine.findPiece(clone, move.pieceId);
  const advanced = moved == null ? 0 : forwardSteps(engine.trackLength, sourceArc, moved.arc);
  score += advanced * HeuristicPlayerAgent.AdvancePerStepScore;

  if (queenWasThreatened && !isQueenThreatened(engine, clone, owner)) {
    score += HeuristicPlayerAgent.SavingQueenScore;
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
