import { GameState, Move, PieceOwner, PieceType, RerollDecision, type DieFace } from "../rules/domain";
import type { RulesEngine } from "../rules/engine";
import { evaluatePosition, WinningScore } from "./evaluation";
import type { BotRandomSource } from "./types";

export const HeuristicDifficulties = ["easy", "medium", "hard"] as const;
export type HeuristicDifficulty = (typeof HeuristicDifficulties)[number];
export function difficultyFor(kind: string): HeuristicDifficulty | null {
  return kind === "heuristic" ? "medium" :
    HeuristicDifficulties.find(d => d === kind) ?? null;
}

export interface SearchProfile {
  readonly nodes: number;
  readonly iterations: readonly { turns: number; width: number }[];
}
export const SearchProfiles: Record<HeuristicDifficulty, SearchProfile> = {
  easy: { nodes: 1000, iterations: [] },
  medium: { nodes: 8_000, iterations: [{ turns: 1, width: 4 }, { turns: 2, width: 2 }] },
  hard: { nodes: 100_000, iterations: [
    // Complete Medium's layers first; a failed deeper iteration must not regress to a shallower AI.
    { turns: 1, width: 4 }, { turns: 2, width: 2 },
    { turns: 2, width: 4 }, { turns: 3, width: 2 },
  ] },
};
export interface SearchDiagnostics {
  difficulty: HeuristicDifficulty;
  nodes: number;
  completedTurns: number;
  selectiveWidth: number;
  budgetExhausted: boolean;
  rerollResidual: number;
  rerollIterations: number;
  score: number;
  tacticalWin: boolean;
}
export interface SearchResult {
  move: Move | null;
  reroll: RerollDecision;
  diagnostics: SearchDiagnostics;
}
export interface SearchOptions {
  difficulty: HeuristicDifficulty;
  action: "move" | "reroll";
  moves?: readonly Move[];
  signal?: AbortSignal;
  random?: BotRandomSource | null;
  tieSeed?: number;
  recentPositions?: readonly string[];
  profile?: SearchProfile;
}
export type SearchExecutor = (
  engine: RulesEngine, state: GameState, options: SearchOptions,
) => Promise<SearchResult>;

export interface RollOutcome { dice: DieFace[]; probability: number }
export function rollOutcomes(engine: RulesEngine): RollOutcome[] {
  const faces = engine.rules.dice.faces.map(f => engine.rules.resolveFace(f.id));
  const count = engine.rules.dice.count;
  if (faces.length ** count > 65_536) throw new RangeError("Ruleset dice space exceeds the search limit.");
  const grouped = new Map<string, { dice: DieFace[]; count: number }>();
  function visit(dice: DieFace[]): void {
    if (dice.length === count) {
      const sorted = [...dice].sort((a, b) => engine.rules.useOrderOf(a) - engine.rules.useOrderOf(b));
      const key = sorted.join(",");
      const previous = grouped.get(key);
      if (previous) previous.count++;
      else grouped.set(key, { dice: sorted, count: 1 });
      return;
    }
    for (const face of faces) visit([...dice, face]);
  }
  visit([]);
  return [...grouped.values()].map(g => ({
    dice: g.dice, probability: g.count / faces.length ** count,
  }));
}

/** Monotone optimal stopping on the finite dice-state graph, including repeat reroll offers. */
export function solveRerolls(
  engine: RulesEngine, outcomes: readonly RollOutcome[], keep: readonly number[],
  maximize: boolean,
): { values: number[]; residual: number; iterations: number } {
  const indices = new Map(outcomes.map((o, i) => [o.dice.join(","), i]));
  const faces = engine.rules.dice.faces.map(f => engine.rules.resolveFace(f.id));
  const values = [...keep];
  let residual = 0;
  for (let iteration = 1; iteration <= 2048; iteration++) {
    residual = 0;
    for (let i = 0; i < outcomes.length; i++) {
      const dice = outcomes[i].dice;
      if (!engine.rules.dice.reroll.faces.includes(
        engine.rules.dice.faces[dice[0]].id,
      )) continue;
      let expected = 0;
      for (const face of faces) {
        const next = [face, ...dice.slice(1)]
          .sort((a, b) => engine.rules.useOrderOf(a) - engine.rules.useOrderOf(b));
        const index = indices.get(next.join(","));
        if (index == null) throw new Error("Missing reroll outcome.");
        expected += values[index] / faces.length;
      }
      const updated = maximize ? Math.max(keep[i], expected) : Math.min(keep[i], expected);
      residual = Math.max(residual, Math.abs(updated - values[i]));
      values[i] = updated;
    }
    if (residual < 1e-7) return { values, residual, iterations: iteration };
  }
  throw new Error(`Reroll value iteration did not converge (residual ${residual}).`);
}

export function positionKey(state: GameState): string {
  return [
    state.turnPhase, state.currentActiveDie, Number(state.rerollDecisionMade),
    state.dice.join(","), Number(state.gameOver), state.winner, state.winReason,
    state.p1Captures, state.p2Captures,
    armyKey(state),
  ].join("|");
}

export function armyKey(state: GameState): string {
  return state.places.flatMap(p => p.pieces).sort((a, b) => a.id - b.id).map(p =>
    `${p.id}:${p.owner}:${p.type}:${p.placeIndex}:${p.arc}:${+p.isActive}:${+p.canBeActivated}`).join(";");
}
class SearchLimit extends Error {}
class TacticalLimit extends Error {}
type Work<T> = Generator<void, T, void>;
type Candidate = { move: Move; state: GameState; score: number };

export const searchDecision: SearchExecutor = async (engine, state, options) => {
  options.signal?.throwIfAborted();
  const profile = options.profile ?? SearchProfiles[options.difficulty];
  const owner = state.currentPlayer;
  const outcomes = rollOutcomes(engine);
  const diagnostics: SearchDiagnostics = {
    difficulty: options.difficulty, nodes: 0, completedTurns: 0, selectiveWidth: 0,
    budgetExhausted: false, rerollResidual: 0, rerollIterations: 0, score: 0,
    tacticalWin: false,
  };
  const leaves = new Map<string, number>();
  const ordering = new Map<string, number>();
  const cache = new Map<string, number>();
  const winning = new Map<string, boolean>();
  let tacticalNodes = 0;
  const tacticalLimit = Math.floor(profile.nodes / 5);
  let tacticalExhausted = false;
  const leaf = (s: GameState, detailed = true): number => {
    // The evaluator probes all faces, so its value is independent of the current throw and phase.
    const key = `${+s.gameOver}/${s.winner}/${armyKey(s)}`;
    const values = detailed ? leaves : ordering;
    let value = values.get(key);
    if (value == null) {
      value = evaluatePosition(engine, s, owner, detailed);
      values.set(key, value);
    }
    return value;
  };
  function* tick(): Work<void> {
    options.signal?.throwIfAborted();
    if (++diagnostics.nodes > profile.nodes) throw new SearchLimit();
    if (diagnostics.nodes % 512 === 0) yield;
  }
  function* candidates(s: GameState, moves = engine.legalMoves(s)): Work<Candidate[]> {
    const result: Candidate[] = [];
    for (const move of moves) {
      yield* tick();
      const clone = s.clone();
      if (!engine.tryApplyMove(clone, move).success) throw new Error("Search received an illegal move.");
      result.push({ move, state: clone, score: leaf(clone, false) });
    }
    const sign = s.currentPlayer === owner ? 1 : -1;
    return result.sort((a, b) => sign * (b.score - a.score));
  }
  function hasWinningTarget(s: GameState): boolean {
    const enemy = s.currentPlayer === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;
    const remaining = s.dice.length - s.currentActiveDie;
    let soldierPlaces = 0;
    let protectedSoldier = false;
    for (const place of s.places) {
      const soldiers = place.pieces.filter(p => p.owner === enemy && p.type === PieceType.Soldier);
      if (soldiers.length) soldierPlaces++;
      if (soldiers.some(p => !p.isActive && !engine.rules.inactive.enterable)) protectedSoldier = true;
      if (place.pieces.some(p => p.owner === enemy && engine.rules.def(p.type).landingEndsGame &&
          (p.isActive || engine.rules.inactive.enterable))) return true;
    }
    return engine.rules.win.opponentSoldiersExhausted &&
      soldierPlaces > 0 && soldierPlaces <= remaining && !protectedSoldier;
  }
  function* canWin(s: GameState, player: PieceOwner): Work<boolean> {
    if (s.gameOver) return s.winner === player;
    if (s.isRollPhase || s.currentPlayer !== player) return false;
    const key = positionKey(s);
    const cached = winning.get(key);
    if (cached != null) return cached;
    for (const move of engine.legalMoves(s)) {
      if (++tacticalNodes > tacticalLimit) throw new TacticalLimit();
      yield* tick();
      const clone = s.clone();
      engine.applyMove(clone, move);
      if (yield* canWin(clone, player)) {
        winning.set(key, true);
        return true;
      }
    }
    winning.set(key, false);
    return false;
  }
  function* kept(s: GameState, turns: number, width: number): Work<number> {
    const clone = s.clone();
    if (engine.canReroll(clone)) engine.applyRerollDecision(clone, RerollDecision.KeepDiceAndProceed);
    return yield* visit(clone, turns - Number(clone.currentPlayer !== s.currentPlayer), width);
  }
  function* diceValues(s: GameState, turns: number, width: number): Work<number[]> {
    const keep: number[] = [];
    for (const outcome of outcomes) {
      const clone = s.clone();
      clone.dice = [...outcome.dice];
      clone.currentActiveDie = 0;
      clone.rerollDecisionMade = false;
      if (clone.isRollPhase) clone.turnPhase++;
      keep.push(yield* kept(clone, turns, width));
    }
    const solved = solveRerolls(engine, outcomes, keep, s.currentPlayer === owner);
    diagnostics.rerollResidual = Math.max(diagnostics.rerollResidual, solved.residual);
    diagnostics.rerollIterations = Math.max(diagnostics.rerollIterations, solved.iterations);
    return solved.values;
  }
  function* visit(s: GameState, turns: number, width: number): Work<number> {
    if (s.gameOver || turns <= 0) return leaf(s);
    const key = `${turns}/${width}/${positionKey(s)}`;
    const cached = cache.get(key);
    if (cached != null) return cached;
    if (!s.isRollPhase && s.currentPlayer !== owner && !tacticalExhausted && hasWinningTarget(s)) {
      try {
        if (yield* canWin(s, s.currentPlayer)) return -WinningScore;
      } catch (error) {
        if (!(error instanceof TacticalLimit)) throw error;
        tacticalExhausted = true;
      }
    }
    let value: number;
    if (s.isRollPhase) {
      const values = yield* diceValues(s, turns, width);
      value = outcomes.reduce((sum, o, i) => sum + o.probability * values[i], 0);
    } else {
      const choices = yield* candidates(s);
      if (!choices.length) {
        const clone = s.clone();
        engine.nextPlayerTurn(clone);
        value = yield* visit(clone, turns - 1, width);
      } else {
        const maximizing = s.currentPlayer === owner;
        value = maximizing ? -WinningScore : WinningScore;
        // All immediate wins are seen before selective ordering can discard a branch.
        if (choices[0].state.gameOver &&
            choices[0].state.winner === s.currentPlayer) return choices[0].score;
        for (const choice of choices.slice(0, width)) {
          const next = yield* visit(choice.state,
            turns - Number(choice.state.currentPlayer !== s.currentPlayer), width);
          value = maximizing ? Math.max(value, next) : Math.min(value, next);
        }
      }
    }
    cache.set(key, value);
    return value;
  }
  let selected: Move | null = null;
  let reroll = RerollDecision.KeepDiceAndProceed;
  function pick(scored: { move: Move; score: number }[]): { move: Move; score: number } {
    const best = Math.max(...scored.map(c => c.score));
    // Exact equality only: a tiny difference in a terminal chance expectation is not a casual tie.
    const tied = scored.filter(c => Math.abs(c.score - best) < 1e-9);
    return tied[options.tieSeed != null ? options.tieSeed % tied.length :
      options.random ? options.random.nextInt(0, tied.length) : 0];
  }
  // Randomness is drawn once, after all completed search layers, never inside speculative branches.
  let finalChoices: { move: Move; score: number }[] = [];
  function* run(): Work<void> {
    if (options.action === "move") {
      const roots = yield* candidates(state, [...(options.moves ?? engine.legalMoves(state))]);
      if (!roots.length) return;
      finalChoices = roots.map(c => ({ move: c.move, score: leaf(c.state) }));
      if (roots[0].state.gameOver && roots[0].state.winner === owner) return;
      if (options.difficulty !== "easy" && hasWinningTarget(state)) {
        try {
          for (const root of roots) {
            if (yield* canWin(root.state, owner)) {
              finalChoices = [{ move: root.move, score: WinningScore }];
              diagnostics.tacticalWin = true;
              diagnostics.completedTurns = 1;
              return;
            }
          }
        } catch (error) {
          if (!(error instanceof TacticalLimit)) throw error;
          tacticalExhausted = true;
        }
      }
      for (const iteration of profile.iterations) {
        const scores: { move: Move; score: number }[] = [];
        for (const root of roots) {
          const score = yield* visit(root.state,
            iteration.turns - Number(root.state.currentPlayer !== owner), iteration.width);
          scores.push({ move: root.move, score });
        }
        finalChoices = scores;
        diagnostics.completedTurns = iteration.turns;
        diagnostics.selectiveWidth = iteration.width;
      }
    } else if (engine.canReroll(state)) {
      // A completed shallow stopping solution is always available before attempting deeper ones.
      for (const iteration of [{ turns: 0, width: 1 }, ...profile.iterations.slice(0, 1)]) {
        const values = yield* diceValues(state, iteration.turns, iteration.width);
        const current = outcomes.findIndex(o => o.dice.join(",") === state.dice.join(","));
        if (current < 0) throw new Error("Current dice are not in the ruleset outcome space.");
        const keep = yield* kept(state, iteration.turns, iteration.width);
        reroll = values[current] > keep + 1e-7 ?
          RerollDecision.RerollActiveDie : RerollDecision.KeepDiceAndProceed;
        diagnostics.score = values[current];
        diagnostics.completedTurns = iteration.turns;
        diagnostics.selectiveWidth = iteration.width;
      }
    }
  }
  const work = run();
  try {
    for (let step = work.next(); !step.done; step = work.next()) {
      await new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(null);
      });
      options.signal?.throwIfAborted();
    }
  } catch (error) {
    if (!(error instanceof SearchLimit)) throw error;
    diagnostics.budgetExhausted = true;
    // Root scoring is bounded by the legal move count, even for an intentionally tiny test budget.
    if (options.action === "move" && !finalChoices.length) {
      finalChoices = (options.moves ?? engine.legalMoves(state)).map(move => {
        const clone = state.clone();
        engine.applyMove(clone, move);
        return { move, score: leaf(clone) };
      });
    }
  }
  if (finalChoices.length) {
    for (const choice of finalChoices) {
      if (Math.abs(choice.score) >= WinningScore) continue;
      const clone = state.clone();
      engine.applyMove(clone, choice.move);
      const key = armyKey(clone);
      choice.score -= 20 * (options.recentPositions?.filter(p => p === key).length ?? 0);
    }
    const best = pick(finalChoices);
    selected = best.move;
    diagnostics.score = best.score;
  }
  return { move: selected, reroll, diagnostics };
};
