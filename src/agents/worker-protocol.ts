import { GameState, Move } from "../rules/domain";
import { RulesEngine } from "../rules/engine";
import { RuleSetJson } from "../rules/ruleset";
import { searchDecision, type HeuristicDifficulty, type SearchResult } from "./search";

export interface SearchRequest {
  rules: string;
  state: GameState;
  difficulty: HeuristicDifficulty;
  action: "move" | "reroll";
  moves?: readonly Move[];
  tieSeed: number;
  recentPositions?: readonly string[];
}
export type SearchResponse =
  | { ok: true; result: SearchResult }
  | { ok: false; error: string };

/** Rehydrate prototypes lost by structured cloning, including nested pieces and places. */
export function restoreState(raw: GameState): GameState {
  return Object.assign(new GameState(), raw).clone();
}

export async function executeSearchRequest(request: SearchRequest): Promise<SearchResult> {
  return searchDecision(new RulesEngine(RuleSetJson.fromJson(request.rules)), restoreState(request.state), {
    difficulty: request.difficulty, action: request.action,
    moves: request.moves?.map(m => new Move(m.pieceId, m.targetPlaceIndex)),
    tieSeed: request.tieSeed,
    recentPositions: request.recentPositions,
  });
}
