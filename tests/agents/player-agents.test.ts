/**
 * Vitest port of the retired C# `PlayerAgentTests` suite, plus the small "no interaction"
 * contract the task adds to the human agent.
 *
 * Most `[Test]` cases map onto an `it` of the same name, so the suite can still be diffed against the
 * C# original one assertion at a time; the random agent's re-roll test is the deliberate exception,
 * replaced by `Random_KeepsTheSahhkuOrThrowsItAgainDependingOnItsDraw` and its two source-less
 * companions once the unconditional re-throw it pinned turned out to be the bug. The agents are
 * engine-free (or engine-*aware*, never engine-owned), which is why the same scenarios run headlessly
 * here.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DieFace,
  EngineOptions,
  Move,
  PieceOwner,
  PieceType,
  RerollDecision,
  TurnPhase,
  WinReason,
} from "../../src/rules/domain";
import type { RulesEngine } from "../../src/rules/engine";
import { HeuristicPlayerAgent } from "../../src/agents/heuristic";
import { HumanPlayerAgent } from "../../src/agents/human";
import { RandomPlayerAgent } from "../../src/agents/random";
import type { BotRandomSource, HumanInteraction } from "../../src/agents/types";
import { SeededRandomSource } from "../../src/cli/match-runner";
import { Board, testEngine } from "../helpers/board";

/** Records the ranges it was asked for, so the legacy draw can be pinned. */
class ScriptedBotRandom implements BotRandomSource {
  readonly requests: Array<[number, number]> = [];

  private readonly values: number[];
  private index = 0;

  constructor(...values: number[]) {
    this.values = values;
  }

  nextInt(minimumInclusive: number, maximumExclusive: number): number {
    this.requests.push([minimumInclusive, maximumExclusive]);
    return this.values[this.index++ % this.values.length];
  }
}

class ScriptedHuman implements HumanInteraction {
  moveToReturn: Move | null = null;
  rerollToReturn: RerollDecision = RerollDecision.KeepDiceAndProceed;
  moveRequests = 0;
  rerollRequests = 0;

  requestReroll(): Promise<RerollDecision> {
    this.rerollRequests++;
    return Promise.resolve(this.rerollToReturn);
  }

  requestMove(): Promise<Move> {
    this.moveRequests++;
    return Promise.resolve(this.moveToReturn as Move);
  }
}

/** A board offering player one a choice of moves and the option to re-throw the sáhkku die. */
function boardWithChoices(engine: RulesEngine): Board {
  const board = new Board(engine);
  board.addOnArc(10, PieceType.Soldier, PieceOwner.P1, true);
  board.addOnArc(40, PieceType.Soldier, PieceOwner.P1, true);
  board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
  board.phase(TurnPhase.P1move);
  return board;
}

// ------------------------------------------------------------------ the heuristic bot

describe("PlayerAgentTests", () => {
  it("Heuristic_KeepsTheSahhkuWhenItCanActivateAPiece", () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(0, PieceType.Soldier, PieceOwner.P1, false, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    expect(engine.canReroll(board.state), "a sáhkku in the move phase offers a re-roll").toBe(true);
    expect(HeuristicPlayerAgent.chooseReroll(engine, board.state)).toBe(
      RerollDecision.KeepDiceAndProceed,
    );
  });

  it("Heuristic_ThrowsTheSahhkuAgainWhenNothingIsWaiting", () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    expect(engine.canReroll(board.state)).toBe(true);
    expect(HeuristicPlayerAgent.chooseReroll(engine, board.state)).toBe(
      RerollDecision.RerollActiveDie,
    );
  });

  it("Heuristic_TakesTheEnemyQueenOverAnythingElse", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const queenArc = 20;
    const queenPlace = engine.placeOfArc(PieceOwner.P1, queenArc);

    board.addOnArc(19, PieceType.Soldier, PieceOwner.P1, true);
    board.addOnArc(40, PieceType.Soldier, PieceOwner.P1, true); // could simply advance
    board.add(queenPlace, PieceType.Queen, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    const legalMoves = engine.legalMoves(board.state);
    expect(legalMoves.length, "the fixture has to offer a choice").toBeGreaterThan(1);

    const chosen = HeuristicPlayerAgent.chooseMove(engine, board.state, legalMoves) as Move;
    expect(chosen.targetPlaceIndex).toBe(queenPlace);
    expect(engine.isLegalMove(board.state, chosen)).toBe(true);
  });

  it("Heuristic_CapturesASoldierRatherThanAdvancing", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const victimPlace = engine.placeOfArc(PieceOwner.P1, 21);

    board.addOnArc(20, PieceType.Soldier, PieceOwner.P1, true);
    board.addOnArc(40, PieceType.Soldier, PieceOwner.P1, true);
    board.add(victimPlace, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    const chosen = HeuristicPlayerAgent.chooseMove(engine, board.state, engine.legalMoves(board.state));
    expect((chosen as Move).targetPlaceIndex).toBe(victimPlace);
  });

  it("Heuristic_PrefersActivatingAPieceOverASimpleAdvance", () => {
    const engine = testEngine();
    const board = new Board(engine);

    board.add(0, PieceType.Soldier, PieceOwner.P1, false, true);
    board.addOnArc(40, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    const chosen = HeuristicPlayerAgent.chooseMove(engine, board.state, engine.legalMoves(board.state));
    const moved = engine.findPiece(board.state, (chosen as Move).pieceId);
    expect(moved?.arc, "the waiting soldier is the one that should be activated").toBe(0);
  });

  it.each([PieceOwner.P1, PieceOwner.P2])(
    "Heuristic_DoesNotAdvanceASafeQueenIntoCaptureForOwner_%s",
    (owner) => {
      const engine = testEngine();
      const board = new Board(engine, owner);
      const opponent = owner === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;
      const queen = board.addOnArc(20, PieceType.Queen, owner, true);
      const soldier = board.addOnArc(5, PieceType.Soldier, owner, true);
      const attacker = board.add(engine.placeOfArc(owner, 24), PieceType.Soldier, opponent, true);
      board.setDice(DieFace.Sahhku);
      board.phase(owner === PieceOwner.P1 ? TurnPhase.P1move : TurnPhase.P2move);
      const risky = new Move(queen.id, engine.placeOfArc(owner, 21));
      const safe = new Move(soldier.id, engine.placeOfArc(owner, 6));
      const snapshot = board.state.clone();

      expect(engine.isLegalMove(board.state, risky)).toBe(true);
      expect(engine.isLegalMove(board.state, safe)).toBe(true);
      expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [risky, safe])).toBe(safe);
      expect(board.state).toEqual(snapshot);

      engine.applyMove(board.state, risky);
      board.setDice(DieFace.Three);
      board.phase(opponent === PieceOwner.P1 ? TurnPhase.P1move : TurnPhase.P2move);
      engine.applyMove(board.state, new Move(attacker.id, risky.targetPlaceIndex));
      expect(board.state.gameOver).toBe(true);
      expect(board.state.winner).toBe(opponent);
      expect(board.state.winReason).toBe(WinReason.QueenCaptured);
    },
  );

  it("Heuristic_DoesNotActivateTheQueenForANonWinningCaptureThatExposesIt", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const queen = board.add(20, PieceType.Queen, PieceOwner.P1, false, true);
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(21, PieceType.Soldier, PieceOwner.P2, true);
    board.add(24, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const risky = new Move(queen.id, 21);
    const safe = new Move(soldier.id, 6);

    expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [risky, safe])).toBe(safe);
    const clone = board.state.clone();
    const outcome = engine.tryApplyMove(clone, risky);
    expect(outcome.success).toBe(true);
    expect(clone.p1Captures).toBe(1);
    expect(clone.gameOver).toBe(false);
  });

  it("Heuristic_CanStillActivateTheQueenWhenItIsSafe", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const queen = board.add(20, PieceType.Queen, PieceOwner.P1, false, true);
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(24, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const activation = new Move(queen.id, 19);
    const advance = new Move(soldier.id, 6);

    expect(engine.isLegalMove(board.state, activation)).toBe(true);
    expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [advance, activation])).toBe(activation);
  });

  it("Heuristic_DoesNotAddAnotherThreatWhenTheQueenIsAlreadyThreatened", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const queen = board.add(20, PieceType.Queen, PieceOwner.P1, true);
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(23, PieceType.Soldier, PieceOwner.P2, true);
    board.add(24, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const moreThreatened = new Move(queen.id, 21);
    const unchanged = new Move(soldier.id, 6);

    expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [moreThreatened, unchanged])).toBe(unchanged);
  });

  it("Heuristic_RetreatsToSafetyRatherThanTakingASoldier", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const queen = board.add(20, PieceType.Queen, PieceOwner.P1, true);
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(23, PieceType.Soldier, PieceOwner.P2, true);
    board.add(6, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const capture = new Move(soldier.id, 6);
    const retreat = new Move(queen.id, 19);

    expect(engine.isLegalMove(board.state, retreat)).toBe(true);
    expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [capture, retreat])).toBe(retreat);
  });

  it.each([PieceOwner.P1, PieceOwner.P2])(
    "Heuristic_PrefersTheHomeRowOverAnOtherwiseSafeAdvanceForOwner_%s",
    (owner) => {
      const engine = testEngine();
      const board = new Board(engine, owner);
      const queen = board.addOnArc(20, PieceType.Queen, owner, true);
      board.setDice(DieFace.Sahhku);
      board.phase(owner === PieceOwner.P1 ? TurnPhase.P1move : TurnPhase.P2move);
      const advance = new Move(queen.id, engine.placeOfArc(owner, 21));
      const home = new Move(queen.id, engine.placeOfArc(owner, 9));

      expect(engine.isLegalMove(board.state, advance)).toBe(true);
      expect(engine.isLegalMove(board.state, home)).toBe(true);
      expect(board.state.places[home.targetPlaceIndex].y).toBe(engine.homeRowOf(owner));
      expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [advance, home])).toBe(home);
    },
  );

  it("Heuristic_DoesNotLetTheHomeRowPreferenceOverrideASafeCapture", () => {
    const engine = testEngine();
    const board = new Board(engine);
    const queen = board.add(20, PieceType.Queen, PieceOwner.P1, true);
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P2, true);
    board.add(40, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const home = new Move(queen.id, 9);
    const capture = new Move(soldier.id, 6);

    expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [home, capture])).toBe(capture);
  });

  it.each([PieceOwner.P1, PieceOwner.P2])(
    "Heuristic_DoesNotTreatAnExposedHomeRowAsSafeForOwner_%s",
    (owner) => {
      const engine = testEngine();
      const board = new Board(engine, owner);
      const opponent = owner === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;
      const queen = board.addOnArc(20, PieceType.Queen, owner, true);
      board.add(engine.placeOfArc(owner, 10), PieceType.Soldier, opponent, true);
      board.setDice(DieFace.Sahhku);
      board.phase(owner === PieceOwner.P1 ? TurnPhase.P1move : TurnPhase.P2move);
      const home = new Move(queen.id, engine.placeOfArc(owner, 9));
      const safe = new Move(queen.id, engine.placeOfArc(owner, 21));

      expect(engine.isLegalMove(board.state, home)).toBe(true);
      expect(engine.isLegalMove(board.state, safe)).toBe(true);
      expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [home, safe])).toBe(safe);
    },
  );

  it.each([
    [PieceType.Queen, WinReason.QueenCaptured],
    [PieceType.Soldier, WinReason.OpponentSoldiersExhausted],
  ])("Heuristic_TakesAnImmediateWinDespiteQueenExposure_%s", (victimType, reason) => {
    const engine = testEngine();
    const board = new Board(engine);
    const queen = board.add(20, PieceType.Queen, PieceOwner.P1, true);
    board.add(21, victimType, PieceOwner.P2, true);
    board.add(23, PieceType.King, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const win = new Move(queen.id, 21);
    const retreat = new Move(queen.id, 9);

    expect(engine.isLegalMove(board.state, retreat)).toBe(true);
    expect(HeuristicPlayerAgent.chooseMove(engine, board.state, [retreat, win])).toBe(win);
    engine.applyMove(board.state, win);
    expect(board.state.gameOver).toBe(true);
    expect(board.state.winner).toBe(PieceOwner.P1);
    expect(board.state.winReason).toBe(reason);
  });

  it("Heuristic_PlaysAWholeMatchWithoutBreakingTheRules", () => {
    const engine = testEngine();
    const random = new SeededRandomSource(20260919);
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true), random);

    for (let halfMove = 0; halfMove < 20000 && !state.gameOver; halfMove++) {
      if (state.isRollPhase) engine.rollDice(state, random);

      for (let attempt = 0; attempt < 32 && !state.gameOver && engine.canReroll(state); attempt++) {
        const decision = HeuristicPlayerAgent.chooseReroll(engine, state);
        engine.applyRerollDecision(
          state,
          decision,
          decision === RerollDecision.RerollActiveDie ? random : null,
        );
      }
      if (state.gameOver) break;

      while (!state.gameOver && !state.isRollPhase) {
        const legalMoves = engine.legalMoves(state);
        if (legalMoves.length === 0) {
          engine.nextPlayerTurn(state);
          break;
        }

        const move = HeuristicPlayerAgent.chooseMove(engine, state, legalMoves) as Move;
        expect(engine.isLegalMove(state, move), "the heuristic only proposes legal moves").toBe(true);
        engine.applyMove(state, move);
        expect(engine.validateState(state), "the state stays sound after every move").toEqual([]);
      }
    }

    expect(state.gameOver, "the heuristic bots have to be able to finish a game").toBe(true);
  });

  // ------------------------------------------------------------------ the other agents

  it("Random_KeepsTheLegacyDrawAndStaysLegal", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.addOnArc(10, PieceType.Soldier, PieceOwner.P1, true);
    board.addOnArc(40, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    const legalMoves = engine.legalMoves(board.state);
    const random = new ScriptedBotRandom(1, 3);
    const agent = new RandomPlayerAgent(PieceOwner.P1, "Random", random);

    const chosen = await agent.decideMove(board.state, legalMoves);

    expect(engine.isLegalMove(board.state, chosen as Move)).toBe(true);
    expect(random.requests.length, "one draw for the piece, one for the move index").toBe(2);
    expect(random.requests[0][0]).toBe(0);
    expect(random.requests[1][1], "the move index is still drawn from [0, 4) and clamped").toBe(4);
  });

  it("Random_KeepsTheSahhkuOrThrowsItAgainDependingOnItsDraw", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    expect(engine.canReroll(board.state), "a sáhkku in the move phase offers a re-roll").toBe(true);

    // A zero draw keeps the dice, which is the only way the CPU can ever spend a sáhkku on activating a
    // queued piece; a one draws the re-throw. Both halves have to be reachable, and each has to be one
    // coin flip taken from the injected source over the contracted `[0, 2)` range: these two scripts
    // would answer identically for a wider draw (a one-in-four keep, say) or for a `Math.random` flip,
    // so the requested range is pinned here rather than assumed.
    const keepingDraw = new ScriptedBotRandom(0);
    const keeping = new RandomPlayerAgent(PieceOwner.P1, "Random", keepingDraw);
    expect(await keeping.decideReroll(board.state)).toBe(RerollDecision.KeepDiceAndProceed);
    expect(keepingDraw.requests, "one coin flip, drawn from the bot's own [0, 2) range").toEqual([
      [0, 2],
    ]);

    const rethrowingDraw = new ScriptedBotRandom(1);
    const rethrowing = new RandomPlayerAgent(PieceOwner.P1, "Random", rethrowingDraw);
    expect(await rethrowing.decideReroll(board.state)).toBe(RerollDecision.RerollActiveDie);
    expect(rethrowingDraw.requests, "one coin flip, drawn from the bot's own [0, 2) range").toEqual([
      [0, 2],
    ]);
  });

  it("Random_WithoutASourceDrawsTheRerollFromMathRandom", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    // The missing-data rule for this decision: with no bot stream the CPU still decides by chance
    // instead of freezing on one answer, and it is `Math.random` that is consulted. The stub therefore
    // sits on the half-way point the rule names rather than merely bracketing it — the largest double
    // below it still keeps the dice, the half-way draw itself already re-throws — because a stubbed
    // 0.25 against 0.75 passes unchanged for a shifted threshold (`< 0.6`, `<= 0.5`) and so would pin
    // the odds only loosely.
    const largestDrawBelowTheHalfwayPoint = 0.5 - Number.EPSILON / 4; // 0.49999999999999994
    const agent = new RandomPlayerAgent(PieceOwner.P1);
    const random = vi.spyOn(Math, "random");

    try {
      random.mockReturnValue(largestDrawBelowTheHalfwayPoint);
      expect(await agent.decideReroll(board.state)).toBe(RerollDecision.KeepDiceAndProceed);

      random.mockReturnValue(0.5);
      expect(await agent.decideReroll(board.state)).toBe(RerollDecision.RerollActiveDie);
      expect(random).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });

  it("Random_WithoutASourceKeepsTheFirstLegalMove", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);
    const agent = new RandomPlayerAgent(PieceOwner.P1);

    // The other half of the missing-data story, and the reason `decideReroll` documents its fallback as
    // its own: a source-less `decideMove` answers without drawing at all, so nothing here may consult
    // `Math.random`.
    const random = vi.spyOn(Math, "random");

    try {
      expect(legalMoves.length, "the fixture has to offer a choice").toBeGreaterThan(1);
      expect(await agent.decideMove(board.state, legalMoves)).toBe(legalMoves[0]);
      expect(await agent.decideMove(board.state, [])).toBeNull();
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it("Human_DelegatesBothDecisionsToTheInteraction", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.addOnArc(10, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1move);

    const legalMoves = engine.legalMoves(board.state);
    const interaction = new ScriptedHuman();
    interaction.moveToReturn = legalMoves[0];
    interaction.rerollToReturn = RerollDecision.RerollActiveDie;
    const agent = new HumanPlayerAgent(PieceOwner.P1, "Player 1", interaction);

    expect(agent.owner).toBe(PieceOwner.P1);
    expect(agent.name).toBe("Player 1");
    expect(await agent.decideReroll(board.state)).toBe(RerollDecision.RerollActiveDie);
    expect((await agent.decideMove(board.state, legalMoves))?.targetPlaceIndex).toBe(
      legalMoves[0].targetPlaceIndex,
    );
    expect(interaction.rerollRequests).toBe(1);
    expect(interaction.moveRequests).toBe(1);
  });

  it("Human_WithoutAnInteractionKeepsTheDiceAndOffersNoMove", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const agent = new HumanPlayerAgent(PieceOwner.P1);

    expect(agent.name).toBe("Human");
    expect(await agent.decideReroll(board.state)).toBe(RerollDecision.KeepDiceAndProceed);
    expect(await agent.decideMove(board.state, engine.legalMoves(board.state))).toBeNull();
  });

  it("Agents_DoNotDecideWhenThereIsNothingToDecide", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.phase(TurnPhase.P1move);

    const random = new RandomPlayerAgent(PieceOwner.P1, "Random", new ScriptedBotRandom(0));
    const heuristic = new HeuristicPlayerAgent(PieceOwner.P1, "Heuristic", engine);

    expect(await random.decideMove(board.state, [])).toBeNull();
    expect(await heuristic.decideMove(board.state, [])).toBeNull();
  });
});
