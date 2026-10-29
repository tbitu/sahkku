import { GameState, PieceOwner, PieceType } from "../rules/domain";
import type { RulesEngine } from "../rules/engine";

export const WinningScore = 1_000_000;
export const PositionScoreLimit = 50_000;
export const otherOwner = (owner: PieceOwner): PieceOwner =>
  owner === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;

/** Read-only movement probes share places, but never cached allowedPlaces or live dice. */
export function movementProbe(state: GameState): GameState {
  const probe = Object.assign(new GameState(), state);
  probe.dice = [...state.dice];
  probe.currentActiveDie = 0;
  return probe;
}

export function queenThreats(engine: RulesEngine, state: GameState, owner: PieceOwner): number {
  const queen = state.places.flatMap(p => p.pieces)
    .find(p => p.owner === owner && p.type === PieceType.Queen);
  if (!queen) return 0;
  const probe = movementProbe(state);
  let threats = 0;
  for (const face of engine.rules.dice.faces) {
    if (face.steps === 0) continue;
    probe.dice[0] = engine.rules.resolveFace(face.id);
    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (piece.owner === otherOwner(owner) &&
            engine.getAllowedPlaces(probe, piece).includes(queen.placeIndex)) threats++;
      }
    }
  }
  return threats;
}

/** Same objective at every difficulty: army development, control, activity and tactical survival. */
export function evaluatePosition(
  engine: RulesEngine, state: GameState, owner: PieceOwner, detailed = true,
): number {
  if (state.gameOver) {
    return state.winner === owner ? WinningScore :
      state.winner === otherOwner(owner) ? -WinningScore : 0;
  }
  let score = 0;
  const probe = movementProbe(state);
  const pieces = state.places.flatMap(p => p.pieces);
  const values = new Map<number, number>();
  for (const piece of pieces) {
    if (piece.owner === PieceOwner.None) continue;
    let value = piece.type === PieceType.Soldier ? 500 : piece.type === PieceType.King ? 450 : 0;
    if (piece.isActive) value += piece.type === PieceType.Soldier ? 85 : 20;
    else if (piece.canBeActivated) value += 30;
    if (piece.type === PieceType.Soldier && piece.isActive) {
      const enemyRow = engine.homeRowOf(otherOwner(piece.owner));
      const row = state.places[piece.placeIndex].y;
      value += row === enemyRow ? 40 : row !== engine.homeRowOf(piece.owner) ? 20 : 0;
      // Progress on the first approach, not an incentive to circle indefinitely.
      value += Math.min(piece.arc, engine.trackLength / 2) * 0.5;
    }
    if (piece.type === PieceType.Queen && piece.isActive &&
        state.places[piece.placeIndex].y === engine.homeRowOf(piece.owner)) value += 40;
    values.set(piece.id, value);
  }
  if (!detailed) {
    for (const piece of pieces) {
      if (piece.owner !== PieceOwner.None) {
        score += (piece.owner === owner ? 1 : -1) * (values.get(piece.id) ?? 0);
      }
    }
    score += 5_000 * (queenThreats(engine, state, otherOwner(owner)) - queenThreats(engine, state, owner));
    return Math.max(-PositionScoreLimit, Math.min(PositionScoreLimit, score));
  }
  const attackers = new Map<number, Set<number>>();
  for (const face of engine.rules.dice.faces) {
    if (face.steps === 0) continue;
    probe.dice[0] = engine.rules.resolveFace(face.id);
    for (const piece of pieces) {
      if (piece.owner === PieceOwner.None) continue;
      const targets = engine.getAllowedPlaces(probe, piece);
      values.set(piece.id, (values.get(piece.id) ?? 0) + targets.length * 2);
      for (const target of targets) {
        for (const victim of state.places[target].pieces) {
          if (victim.owner === piece.owner || victim.owner === PieceOwner.None) continue;
          let set = attackers.get(victim.id);
          if (!set) attackers.set(victim.id, set = new Set());
          set.add(piece.id);
        }
      }
    }
  }
  for (const piece of pieces) {
    if (piece.owner === PieceOwner.None) continue;
    const exposure = attackers.get(piece.id)?.size ?? 0;
    let value = values.get(piece.id) ?? 0;
    const rules = engine.rules.def(piece.type);
    value -= exposure * (rules.landingEndsGame ? 5_000 :
      rules.recruitedWhenLanded ? 180 : rules.capturable ? 90 : 0);
    score += piece.owner === owner ? value : -value;
  }
  return Math.max(-PositionScoreLimit, Math.min(PositionScoreLimit, score));
}
