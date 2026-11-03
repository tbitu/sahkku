import { afterEach, describe, expect, it, vi } from "vitest";
import { RandomPlayerAgent } from "../../src/agents/random";
import { translate } from "../../src/locale/i18n";
import { DieFace, EngineOptions, Move, PieceOwner, PieceType, RerollDecision } from "../../src/rules/domain";
import { BotDriver, DiceFeedbackDelayMs, WebMatchController } from "../../src/ui/controller";
import { Board, testEngine } from "../helpers/board";

afterEach(() => vi.useRealTimers());

function match(faces: DieFace[], evenOdds = true, state?: Board["state"]) {
  const engine = testEngine();
  let index = 0;
  const controller = new WebMatchController(
    engine,
    { nextDieFaceIndex: () => {
      const face = faces[index++];
      if (face == null) throw new Error("Scripted dice exhausted.");
      return face;
    } },
    new EngineOptions(PieceOwner.P1, evenOdds),
    state,
    { diceFeedbackDelayMs: DiceFeedbackDelayMs.normal },
  );
  return { controller, engine };
}

describe("unusable dice handover feedback", () => {
  it.each(Object.entries(DiceFeedbackDelayMs))("holds all blanks for the %s delay (%i ms)", (_, delay) => {
    vi.useFakeTimers();
    const { controller } = match([DieFace.Zero, DieFace.Zero, DieFace.Zero]);
    controller.setDiceFeedbackDelay(delay);
    controller.roll();
    expect(controller.state.currentPlayer).toBe(PieceOwner.P2);
    expect(controller.viewModel.dice.feedbackText).toContain("all dice are blank");
    expect(controller.viewModel.dice.feedbackText).toContain("Turn passes to P2");
    expect(controller.viewModel.dice.dice.map(die => die.unusable)).toEqual([true, true, true]);
    expect(controller.viewModel.dice.rolled).toBe(true);
    expect(controller.viewModel.selectablePieceIds).toEqual([]);
    expect(controller.roll()).toBe(false);
    expect(controller.keepDice()).toBe(false);
    expect(controller.canHumanAct).toBe(false);
    vi.advanceTimersByTime(delay - 1);
    expect(controller.showingDiceFeedback).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controller.showingDiceFeedback).toBe(false);
    expect(controller.viewModel.dice.rolled).toBe(false);
    expect(controller.viewModel.dice.canRoll).toBe(true);
  });

  it("marks every remaining die when the required value has no legal move", () => {
    vi.useFakeTimers();
    const { controller } = match([DieFace.Three, DieFace.Two, DieFace.Zero], false);
    controller.roll();
    expect(controller.viewModel.dice.feedbackText).toContain("no legal moves");
    expect(controller.viewModel.dice.dice.map(die => die.unusable)).toEqual([true, true, true]);
    expect(controller.viewModel.dice.dice.map(die => die.face))
      .toEqual([DieFace.Three, DieFace.Two, DieFace.Zero]);
  });

  it("leaves a used die spent and warns only on the unused remainder", () => {
    vi.useFakeTimers();
    const { controller } = match([DieFace.Three, DieFace.Zero, DieFace.Zero]);
    controller.roll();
    expect(controller.showingDiceFeedback).toBe(false);
    controller.commitMove(controller.legalMoves[0]);
    expect(controller.viewModel.dice.dice.map(die => die.spent)).toEqual([true, false, false]);
    expect(controller.viewModel.dice.dice.map(die => die.unusable)).toEqual([false, true, true]);
    expect(controller.viewModel.lastMove).not.toBeNull();
    expect(controller.viewModel.dice.feedbackText).toContain("remaining dice");
  });

  it("waits for the reroll decision and detects a reroll to all blanks", () => {
    vi.useFakeTimers();
    const { controller } = match([DieFace.Sahhku, DieFace.Zero, DieFace.Zero, DieFace.Zero]);
    controller.roll();
    expect(controller.showingDiceFeedback).toBe(false);
    expect(controller.viewModel.dice.canReroll).toBe(true);
    controller.rerollActiveDie();
    expect(controller.viewModel.dice.feedbackText).toContain("all dice are blank");
  });

  it("warns on a blocked nonblank die after a move, without skipping to a playable later die", () => {
    vi.useFakeTimers();
    const board = new Board(testEngine());
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(9, PieceType.Soldier, PieceOwner.P2);
    const { controller } = match([DieFace.Sahhku, DieFace.Three, DieFace.Two], false, board.state);
    controller.roll();
    controller.keepDice();
    expect(controller.commitMove(new Move(soldier.id, 6))).toBe(true);
    expect(controller.viewModel.dice.dice.map(die => die.unusable)).toEqual([false, true, true]);
    expect(controller.viewModel.dice.dice.map(die => die.face))
      .toEqual([DieFace.Sahhku, DieFace.Three, DieFace.Two]);
    expect(controller.viewModel.dice.currentActiveDie).toBe(1);
    expect(controller.viewModel.dice.feedbackText).toContain("no legal moves");
  });

  it("does not cover a winning capture with an unused-dice warning", () => {
    const board = new Board(testEngine());
    const soldier = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(8, PieceType.Queen, PieceOwner.P2, true);
    board.add(30, PieceType.Soldier, PieceOwner.P2, true);
    const { controller } = match([DieFace.Three, DieFace.Zero, DieFace.Zero], false, board.state);
    controller.roll();
    controller.commitMove(new Move(soldier.id, 8));
    expect(controller.viewModel.gameOver).not.toBeNull();
    expect(controller.showingDiceFeedback).toBe(false);
  });

  it("detects unusable dice after keeping a throw with no playable pieces", () => {
    vi.useFakeTimers();
    const board = new Board(testEngine());
    board.add(14, PieceType.Soldier, PieceOwner.P1);
    board.add(30, PieceType.Soldier, PieceOwner.P2);
    const { controller } = match([DieFace.Sahhku, DieFace.Three, DieFace.Zero], false, board.state);
    controller.roll();
    expect(controller.viewModel.dice.canReroll).toBe(true);
    controller.decideReroll(RerollDecision.KeepDiceAndProceed);
    expect(controller.viewModel.dice.feedbackText).toContain("no legal moves");
  });

  it("relocalizes without extending the pause; speed changes apply to the next warning", () => {
    vi.useFakeTimers();
    const { controller } = match([DieFace.Zero, DieFace.Zero, DieFace.Zero]);
    controller.roll();
    vi.advanceTimersByTime(1000);
    controller.setTranslator((key, values) => translate("no", key, values));
    controller.setDiceFeedbackDelay(DiceFeedbackDelayMs.kajsa);
    controller.refresh();
    expect(controller.viewModel.dice.feedbackText).toContain("alle terningene er blanke");
    vi.advanceTimersByTime(600);
    expect(controller.showingDiceFeedback).toBe(false);
  });

  it("clears the pause on restart and cannot clear a later warning with an obsolete timer", () => {
    vi.useFakeTimers();
    const { controller } = match(Array<DieFace>(6).fill(DieFace.Zero));
    controller.roll();
    vi.advanceTimersByTime(800);
    controller.restart();
    expect(controller.showingDiceFeedback).toBe(false);
    controller.roll();
    vi.advanceTimersByTime(800);
    expect(controller.showingDiceFeedback).toBe(true);
    vi.advanceTimersByTime(800);
    expect(controller.showingDiceFeedback).toBe(false);
  });

  it("does not warn when all dice were spent normally", () => {
    const { controller } = match([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();
    for (let index = 0; index < 3; index++) controller.commitMove(controller.legalMoves[0]);
    expect(controller.state.currentPlayer).toBe(PieceOwner.P2);
    expect(controller.showingDiceFeedback).toBe(false);
  });

  it("prevents the next bot from rolling until the warning expires", async () => {
    vi.useFakeTimers();
    const { controller, engine } = match([
      DieFace.Zero, DieFace.Zero, DieFace.Zero, DieFace.Three, DieFace.Three, DieFace.Three,
    ]);
    controller.setHumanPlayers([]);
    const driver = new BotDriver(controller, engine, { thinkDelayMs: 100 });
    driver.setAgents({
      [PieceOwner.P1]: new RandomPlayerAgent(PieceOwner.P1),
      [PieceOwner.P2]: new RandomPlayerAgent(PieceOwner.P2),
    });
    driver.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.showingDiceFeedback).toBe(true);
    expect(await driver.step()).toBe(false);
    await vi.advanceTimersByTimeAsync(1599);
    expect(controller.viewModel.dice.dice.map(die => die.face)).toEqual(Array(3).fill(DieFace.Zero));
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.showingDiceFeedback).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.viewModel.dice.dice.map(die => die.face)).toEqual(Array(3).fill(DieFace.Three));
    driver.stop();
  });
});
