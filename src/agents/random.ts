/**
 * The random CPU: the port of the retired C# `RandomPlayerAgent`, faithful decision for decision
 * except its re-roll, which is now probabilistic instead of always a re-throw (see `decideReroll`).
 *
 * It is the bot the Unity game shipped with, and its draw is deliberately preserved, quirk included:
 * it picks a random movable piece, then draws an index in `[0, 4)` and clamps it to that piece's
 * options — the pre-engine CPU's draw, which is *not* uniform over the real range. Its re-roll is a
 * fair coin flip drawn from that same stream: the shipped CPU re-threw every sáhkku unconditionally,
 * which kept it from ever spending a sáhkku on activating a queued piece, so most matches against it
 * ground out the whole turn limit into a draw (the mechanism is in the task's problem summary).
 *
 * When available, the random agent biases selection towards the queen's greater mobility. Unlike the
 * heuristic agent, this baseline does not evaluate whether a move exposes its queen to capture.
 */

import { Move, PieceType, RerollDecision, type GameState, type PieceOwner } from "../rules/domain";
import type { BotRandomSource, PlayerAgent } from "./types";

export class RandomPlayerAgent implements PlayerAgent {
  readonly owner: PieceOwner;
  readonly name: string;

  private readonly random: BotRandomSource | null;

  constructor(owner: PieceOwner, name: string | null = null, random: BotRandomSource | null = null) {
    this.owner = owner;
    this.name = name ?? "Random";
    this.random = random;
  }

  /**
   * Keeps the thrown dice or throws the active sáhkku again, with even odds.
   *
   * A random player has to be random about this too, and it is load-bearing: spending a sáhkku is the
   * only way to activate a queued piece, so a CPU that always re-threw could never bring a new soldier
   * (or its queen) onto the track — once its three loose soldiers were captured it had nothing legal to
   * play, so most games against it ground out the whole turn limit into a draw; the ones that did end
   * were won by the re-thrower itself, nearly always by an early queen capture. The draw comes from the
   * bot's own stream so a seeded run still replays exactly; a source-less agent has no stream to draw
   * from and flips `Math.random` instead. That fallback is this method's own: `decideMove` answers a
   * missing source without drawing at all, by taking the first legal move.
   */
  decideReroll(_state: GameState, _signal?: AbortSignal): Promise<RerollDecision> {
    const keepsTheDice = this.random == null ? Math.random() < 0.5 : this.random.nextInt(0, 2) === 0;
    return Promise.resolve(
      keepsTheDice ? RerollDecision.KeepDiceAndProceed : RerollDecision.RerollActiveDie,
    );
  }

  decideMove(state: GameState, legalMoves: readonly Move[]): Promise<Move | null> {
    if (legalMoves.length === 0) return Promise.resolve(null);
    if (this.random == null) return Promise.resolve(legalMoves[0]);

    const pieceIds: number[] = [];
    for (const move of legalMoves) {
      if (!pieceIds.includes(move.pieceId)) pieceIds.push(move.pieceId);
    }

    let pieceId: number;

    // Check if the queen is a legal move option; prefer it with 70% probability (vs random pick).
    const queenId = findQueenId(state, this.owner);
    const shouldPreferQueen = queenId != null && pieceIds.includes(queenId) && this.random.nextInt(0, 10) < 7;

    if (shouldPreferQueen) {
      pieceId = queenId!;
    } else {
      pieceId = pieceIds[clamp(this.random.nextInt(0, pieceIds.length), 0, pieceIds.length - 1)];
    }

    const targets: number[] = [];
    for (const move of legalMoves) {
      if (move.pieceId === pieceId) targets.push(move.targetPlaceIndex);
    }

    // The original draw clamped the raw [0, 4) roll instead of drawing inside the real range.
    const index = clamp(this.random.nextInt(0, 4), 0, targets.length - 1);
    return Promise.resolve(new Move(pieceId, targets[index]));
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function findQueenId(state: GameState, owner: PieceOwner): number | null {
  for (const place of state.places) {
    for (const piece of place.pieces) {
      if (piece.owner === owner && piece.type === PieceType.Queen) {
        return piece.id;
      }
    }
  }
  return null;
}
