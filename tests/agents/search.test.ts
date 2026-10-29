import { describe, expect, it, vi } from "vitest";
import {
  DieFace, EngineOptions, Move, PieceOwner, PieceType, RerollDecision, TurnPhase,
} from "../../src/rules/domain";
import { evaluatePosition, PositionScoreLimit, WinningScore } from "../../src/agents/evaluation";
import {
  armyKey, difficultyFor, positionKey, rollOutcomes, searchDecision, solveRerolls,
} from "../../src/agents/search";
import { HeuristicPlayerAgent } from "../../src/agents/heuristic";
import { executeSearchRequest, restoreState } from "../../src/agents/worker-protocol";
import { Board, testEngine } from "../helpers/board";

describe("whole-game evaluation", () => {
  it("is owner-symmetric, values activation and soldier material, and never mutates the state", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1);
    board.add(40, PieceType.Soldier, PieceOwner.P2);
    const snapshot = board.state.clone();
    const baseline = evaluatePosition(engine, board.state, PieceOwner.P1);
    expect(baseline + evaluatePosition(engine, board.state, PieceOwner.P2)).toBe(0);
    expect(board.state).toEqual(snapshot);
    soldier.canBeActivated = true;
    expect(evaluatePosition(engine, board.state, PieceOwner.P1)).toBeGreaterThan(baseline);
    soldier.isActive = true;
    expect(evaluatePosition(engine, board.state, PieceOwner.P1)).toBeGreaterThan(baseline + 30);
    board.add(7, PieceType.Soldier, PieceOwner.P1);
    expect(evaluatePosition(engine, board.state, PieceOwner.P1)).toBeGreaterThan(baseline + 500);
  });

  it("values king control but recognizes that the king can be recruited away", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const king = board.add(20, PieceType.King, PieceOwner.P1, true);
    const controlled = evaluatePosition(engine, board.state, PieceOwner.P1);
    board.add(23, PieceType.Soldier, PieceOwner.P2, true);
    const exposed = evaluatePosition(engine, board.state, PieceOwner.P1);
    king.owner = PieceOwner.P2;
    expect(exposed).toBeLessThan(controlled - 500);
    expect(evaluatePosition(engine, board.state, PieceOwner.P1)).toBeLessThan(exposed);
  });

  it("orders terminal results outside every finite positional score", () => {
    const engine = testEngine();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));
    expect(Math.abs(evaluatePosition(engine, state, PieceOwner.P1))).toBeLessThanOrEqual(PositionScoreLimit);
    state.gameOver = true;
    state.winner = PieceOwner.P1;
    expect(evaluatePosition(engine, state, PieceOwner.P1)).toBe(WinningScore);
    expect(evaluatePosition(engine, state, PieceOwner.P2)).toBe(-WinningScore);
  });
});

describe("dice chance and rerolls", () => {
  it("aggregates the 64 throws with exact multiplicities, not uniform sorted outcomes", () => {
    const outcomes = rollOutcomes(testEngine());
    expect(outcomes).toHaveLength(20);
    expect(outcomes.reduce((sum, o) => sum + o.probability, 0)).toBe(1);
    expect(outcomes.find(o => o.dice.every(f => f === DieFace.Three))?.probability).toBe(1 / 64);
    expect(outcomes.find(o => o.dice.join() === [DieFace.Sahhku, DieFace.Three, DieFace.Two].join())
      ?.probability).toBe(6 / 64);
  });

  it("solves repeat rerolls as optimal stopping for maximizing and minimizing players", () => {
    const engine = testEngine();
    const outcomes = rollOutcomes(engine);
    const keep = outcomes.map(o => o.dice.includes(DieFace.Sahhku) ? 0 : 100);
    const solved = solveRerolls(engine, outcomes, keep, true);
    expect(solved.residual).toBeLessThan(1e-7);
    expect(solved.values.every(v => Math.abs(v - 100) < 1e-6)).toBe(true);
    const minimized = solveRerolls(engine, outcomes, keep.map(v => -v), false);
    expect(minimized.values.every(v => Math.abs(v + 100) < 1e-6)).toBe(true);
  });
});

describe("difficulty search", () => {
  it.each(["easy", "medium", "hard"] as const)("takes an immediate soldier-exhaustion win at %s", async difficulty => {
    const engine = testEngine();
    const board = new Board(engine);
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P2, true);
    board.add(20, PieceType.Queen, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const snapshot = board.state.clone();
    const winning = board.state.clone();
    engine.applyMove(winning, new Move(soldier.id, 6));
    const result = await searchDecision(engine, board.state, {
      action: "move", difficulty, recentPositions: Array(100).fill(armyKey(winning)),
    });
    expect(result.move).toEqual(new Move(soldier.id, 6));
    expect(result.diagnostics.score).toBe(WinningScore);
    expect(board.state).toEqual(snapshot);
  });

  it.each([
    [PieceOwner.P1, [DieFace.Three, DieFace.Two]],
    [PieceOwner.P2, [DieFace.Three, DieFace.Two]],
    [PieceOwner.P1, [DieFace.Three, DieFace.Three, DieFace.Two]],
    [PieceOwner.P2, [DieFace.Three, DieFace.Three, DieFace.Two]],
  ] as const)("plans a multi-die royal capture for owner %s with dice %s", async (owner, dice) => {
    const engine = testEngine();
    const enemy = owner === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;
    const board = new Board(engine, owner);
    const soldier = board.addOnArc(16, PieceType.Soldier, owner, true);
    board.addOnArc(35, PieceType.Soldier, owner, true);
    board.add(engine.placeOfArc(owner, dice.length === 2 ? 21 : 24), PieceType.Queen, enemy, true);
    board.addOnArc(5, PieceType.Soldier, enemy, true);
    board.setDice(...dice);
    board.phase(owner === PieceOwner.P1 ? TurnPhase.P1move : TurnPhase.P2move);
    const result = await searchDecision(engine, board.state, { action: "move", difficulty: "medium" });
    expect(result.move).toEqual(new Move(soldier.id, engine.placeOfArc(owner, 19)));
    engine.applyMove(board.state, result.move!);
    for (let i = 1; i < dice.length; i++) {
      const finish = await searchDecision(engine, board.state, { action: "move", difficulty: "medium" });
      engine.applyMove(board.state, finish.move!);
    }
    expect(board.state.gameOver).toBe(true);
    expect(board.state.winner).toBe(owner);
  });

  it("recognizes king recruitment as an ownership swing, not captured material", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    const recruiter = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    const capturer = board.add(10, PieceType.Soldier, PieceOwner.P1, true);
    const king = board.add(8, PieceType.King, PieceOwner.P2, true);
    board.add(13, PieceType.Soldier, PieceOwner.P2, true);
    board.add(40, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Three);
    board.phase(TurnPhase.P1move);
    const result = await searchDecision(engine, board.state, {
      action: "move", difficulty: "easy", moves: [new Move(recruiter.id, 8), new Move(capturer.id, 13)],
    });
    expect(result.move).toEqual(new Move(recruiter.id, 8));
    engine.applyMove(board.state, result.move!);
    expect(king.owner).toBe(PieceOwner.P1);
    expect(board.state.gameOver).toBe(false);
  });

  it.each(["medium", "hard"] as const)("keeps the winning die rather than rerolling at %s", async difficulty => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);
    expect(engine.canReroll(board.state)).toBe(true);
    const result = await searchDecision(engine, board.state, { action: "reroll", difficulty });
    expect(result.reroll).toBe(RerollDecision.KeepDiceAndProceed);
    expect(result.diagnostics.score).toBe(WinningScore);
    expect(result.diagnostics.completedTurns).toBe(1);
  });

  it("Medium refuses a material gain that exposes its queen to a multi-die attack", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    const queen = board.add(18, PieceType.Queen, PieceOwner.P1, true);
    board.add(19, PieceType.Soldier, PieceOwner.P2, true);
    board.add(24, PieceType.Soldier, PieceOwner.P2, true);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const capture = new Move(queen.id, 19);
    const retreat = new Move(queen.id, 11);
    const easy = await searchDecision(engine, board.state, {
      action: "move", difficulty: "easy", moves: [capture, retreat],
    });
    const medium = await searchDecision(engine, board.state, {
      action: "move", difficulty: "medium", moves: [capture, retreat],
    });
    expect(easy.move).toEqual(capture);
    expect(medium.move).toEqual(retreat);
    expect(medium.diagnostics.completedTurns).toBe(2);
  });

  it("matches exhaustive current-turn evaluation when selective pruning is disabled", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(9, PieceType.Soldier, PieceOwner.P1, false, true);
    board.add(24, PieceType.King, PieceOwner.P2, true);
    board.add(41, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Three, DieFace.Two);
    board.phase(TurnPhase.P1move);
    const exhaustive = (state: typeof board.state): number => {
      if (state.gameOver || state.isRollPhase || state.currentPlayer !== PieceOwner.P1) {
        return evaluatePosition(engine, state, PieceOwner.P1);
      }
      const moves = engine.legalMoves(state);
      if (!moves.length) return evaluatePosition(engine, state, PieceOwner.P1);
      return Math.max(...moves.map(move => {
        const clone = state.clone();
        engine.applyMove(clone, move);
        return exhaustive(clone);
      }));
    };
    const expected = exhaustive(board.state);
    const actual = await searchDecision(engine, board.state, {
      action: "move", difficulty: "medium",
      profile: { nodes: 10000, iterations: [{ turns: 1, width: Infinity }] },
    });
    expect(actual.diagnostics.budgetExhausted).toBe(false);
    expect(actual.diagnostics.score).toBe(expected);
  });

  it("keeps a completed legal result when its deterministic work budget is exhausted", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Queen, PieceOwner.P1, true);
    board.add(40, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Three, DieFace.Two);
    board.phase(TurnPhase.P1move);
    const result = await searchDecision(engine, board.state, {
      action: "move", difficulty: "hard", profile: { nodes: 1, iterations: [{ turns: 3, width: 3 }] },
    });
    expect(result.diagnostics.budgetExhausted).toBe(true);
    expect(result.diagnostics.completedTurns).toBe(0);
    expect(engine.isLegalMove(board.state, result.move!)).toBe(true);
  });

  it("distinguishes every search-relevant state and round trips worker prototypes", () => {
    const engine = testEngine();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));
    const restored = restoreState(structuredClone(state));
    expect(restored).toEqual(state);
    expect(restored.clone()).toEqual(state);
    const key = positionKey(state);
    restored.rerollDecisionMade = true;
    expect(positionKey(restored)).not.toBe(key);
    restored.rerollDecisionMade = false;
    restored.places.flatMap(p => p.pieces)[0].arc++;
    expect(positionKey(restored)).not.toBe(key);
  });

  it("uses the same core for a serialized custom ruleset and direct execution", async () => {
    const engine = testEngine();
    engine.rules.pieces.queen.landingEndsGame = false;
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(40, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Two);
    board.phase(TurnPhase.P1move);
    const next = board.state.clone();
    engine.applyMove(next, engine.legalMoves(next)[0]);
    const recentPositions = [armyKey(next)];
    const direct = await searchDecision(engine, board.state, {
      difficulty: "medium", action: "move", tieSeed: 7, recentPositions,
    });
    const worker = await executeSearchRequest({
      rules: JSON.stringify(engine.rules), state: structuredClone(board.state),
      difficulty: "medium", action: "move", tieSeed: 7, recentPositions,
    });
    expect(worker).toEqual(direct);
  });

  it("yields during a long direct search and aborts without mutating the board", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    for (const place of [0, 2, 4, 6, 8, 10]) board.add(place, PieceType.Soldier, PieceOwner.P1, true);
    for (const place of [30, 32, 34, 36, 38, 40]) board.add(place, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Three, DieFace.Three, DieFace.Two);
    board.phase(TurnPhase.P1move);
    const snapshot = board.state.clone();
    const applied = vi.spyOn(engine, "tryApplyMove");
    const abort = new AbortController();
    const pending = searchDecision(engine, board.state, {
      action: "move", difficulty: "hard", signal: abort.signal,
      profile: { nodes: 100_000, iterations: [{ turns: 3, width: 6 }] },
    });
    expect(applied.mock.calls.length).toBe(511);
    abort.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(board.state).toEqual(snapshot);
    applied.mockRestore();
  });

  it("honors aborts, resolves the legacy alias and reports executor failures", async () => {
    expect(difficultyFor("heuristic")).toBe("medium");
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Two);
    board.phase(TurnPhase.P1move);
    const abort = new AbortController();
    abort.abort();
    await expect(searchDecision(engine, board.state, {
      difficulty: "hard", action: "move", signal: abort.signal,
    })).rejects.toHaveProperty("name", "AbortError");
    const messages: string[] = [];
    const agent = new HeuristicPlayerAgent(PieceOwner.P1, null, engine, {
      executor: async () => { throw new Error("worker unavailable"); },
      log: message => messages.push(message),
    });
    expect(await agent.decideMove(board.state, engine.legalMoves(board.state))).not.toBeNull();
    expect(messages[0]).toContain("search failed");
    expect(agent.lastSearch).toBeNull();
  });
});
