import { HeuristicPlayerAgent } from "../../src/agents/heuristic";
import type { GameState, Move, PieceOwner } from "../../src/rules/domain";
import type { RulesEngine } from "../../src/rules/engine";
import type { PlayerAgent } from "../../src/agents/types";

/** Frozen synchronous policy for historical runner regressions, not a selectable difficulty. */
export class LegacyHeuristicAgent implements PlayerAgent {
  readonly name: string;
  constructor(readonly owner: PieceOwner, name: string | null, private readonly engine: RulesEngine) {
    this.name = name ?? "Legacy heuristic";
  }
  async decideMove(state: GameState, moves: readonly Move[]) {
    return HeuristicPlayerAgent.chooseMove(this.engine, state, moves);
  }
  async decideReroll(state: GameState) {
    return HeuristicPlayerAgent.chooseReroll(this.engine, state);
  }
}
