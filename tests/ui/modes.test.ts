/**
 * Match-mode, seat, bot-driver and audio-wiring tests (the `REQ_GAME_MODES`, `REQ_AUDIO_SFX` and
 * `REQ_LOCALE_I18N` halves of task 4 that the L1 contract asks for but that `T4_*` does not name).
 *
 * Three properties are asserted over and over, because they are what makes an opponent safe to ship:
 *
 * 1. **Seats are enforced in both directions.** A human click cannot play a bot's turn, and a bot
 *    cannot play a human's — the two kinds of action are gated on which owner is to move.
 * 2. **The engine stays the authority.** A whole bot-vs-bot match is played here and the resulting board
 *    is validated, so no agent path can corrupt the position.
 * 3. **A cue per action, never a pile of them.** The engine's `RuleEvent`s map onto exactly one sound,
 *    the most decisive of the action.
 */

import { describe, expect, it, vi } from "vitest";

import { HeuristicPlayerAgent } from "../../src/agents/heuristic";
import { LlmPlayerAgent } from "../../src/agents/llm";
import { RandomPlayerAgent } from "../../src/agents/random";
import type { SoundName, SoundPlayer } from "../../src/audio/audio";
import { SeededRandomSource } from "../../src/cli/match-runner";
import { translate } from "../../src/locale/i18n";
import {
  DieFace,
  EngineOptions,
  Move,
  PieceOwner,
  PieceType,
  RerollDecision,
  RuleEvent,
  RuleEventKind,
  TurnPhase,
} from "../../src/rules/domain";
import type { RulesEngine } from "../../src/rules/engine";
import {
  BotDriver,
  DefaultMatchSetup,
  GameModes,
  WebMatchController,
  botKindFor,
  createBotAgent,
  engineOptionsFor,
  humanSeatsFor,
  isBotSeat,
  soundForEvents,
  type MatchSetup,
} from "../../src/ui/controller";
import { Board, testEngine } from "../helpers/board";

// ---------------------------------------------------------------------------------- test doubles

/** A `SoundPlayer` that records what it was asked to play, in order. */
class RecordingSounds implements SoundPlayer {
  readonly played: SoundName[] = [];

  play(name: SoundName): boolean {
    this.played.push(name);
    return true;
  }

  get last(): SoundName | undefined {
    return this.played[this.played.length - 1];
  }
}

/**
 * The setup of a mode, with both bot seats on the deterministic agent and a fixed starting player, so a
 * test knows whose turn the first action belongs to. (`startingPlayer: "throw"` is covered separately.)
 */
function setupFor(mode: MatchSetup["mode"]): MatchSetup {
  return { ...DefaultMatchSetup, mode, speed: "fast", startingPlayer: "P1" };
}

function controllerFor(
  engine: RulesEngine,
  random: SeededRandomSource,
  setup: MatchSetup,
  sounds: SoundPlayer | null = null,
  state?: ReturnType<typeof engine.initGame>,
): WebMatchController {
  return new WebMatchController(engine, random, engineOptionsFor(setup), state, {
    humanPlayers: humanSeatsFor(setup),
    sounds,
  });
}

// ---------------------------------------------------------------------------------- setup rules

describe("match setup: what a mode implies", () => {
  it("turns the variant and the starting-player choice into engine options", () => {
    const evenOdds = engineOptionsFor({ ...DefaultMatchSetup, variant: "evenOdds", startingPlayer: "throw" });
    expect(evenOdds.evenOdds).toBe(true);
    expect(evenOdds.startingPlayer).toBe(PieceOwner.P1);
    expect(evenOdds.throwForStartingPlayer).toBe(true);

    const standard = engineOptionsFor({
      ...DefaultMatchSetup,
      variant: "standard",
      startingPlayer: "P2",
    });
    expect(standard.evenOdds).toBe(false);
    expect(standard.startingPlayer).toBe(PieceOwner.P2);
    expect(standard.throwForStartingPlayer).toBe(false);
  });

  it("seats humans and bots per mode", () => {
    const singlePlayer = setupFor(GameModes.humanVsBot);
    expect(isBotSeat(singlePlayer, PieceOwner.P1)).toBe(false);
    expect(isBotSeat(singlePlayer, PieceOwner.P2)).toBe(true);
    expect(humanSeatsFor(singlePlayer)).toEqual([PieceOwner.P1]);

    const hotseat = setupFor(GameModes.hotseat2p);
    expect(isBotSeat(hotseat, PieceOwner.P1)).toBe(false);
    expect(isBotSeat(hotseat, PieceOwner.P2)).toBe(false);
    expect(humanSeatsFor(hotseat)).toEqual([PieceOwner.P1, PieceOwner.P2]);

    const spectator = setupFor(GameModes.botVsBot);
    expect(humanSeatsFor(spectator)).toEqual([]);
  });

  it("lets each side be a different kind of bot", () => {
    const setup: MatchSetup = {
      ...DefaultMatchSetup,
      mode: GameModes.botVsBot,
      bots: { p1: "random", p2: "llm" },
    };
    expect(botKindFor(setup, PieceOwner.P1)).toBe("random");
    expect(botKindFor(setup, PieceOwner.P2)).toBe("llm");
  });

  it("builds the agent each bot kind names", () => {
    const engine = testEngine();

    expect(createBotAgent("heuristic", PieceOwner.P1, engine)).toBeInstanceOf(HeuristicPlayerAgent);
    expect(createBotAgent("random", PieceOwner.P2, engine)).toBeInstanceOf(RandomPlayerAgent);
    expect(createBotAgent("llm", PieceOwner.P2, engine)).toBeInstanceOf(LlmPlayerAgent);
    expect(createBotAgent("heuristic", PieceOwner.P2, engine).owner).toBe(PieceOwner.P2);
    expect(createBotAgent("heuristic", PieceOwner.P2, engine).name).toBe("Heuristic (medium)");

    // An unknown kind degrades to the heuristic instead of leaving the seat empty.
    expect(createBotAgent("nonsense" as never, PieceOwner.P1, engine)).toBeInstanceOf(
      HeuristicPlayerAgent,
    );
  });
});

// ---------------------------------------------------------------------------------- seats

describe("WebMatchController: the two kinds of seat", () => {
  it("keeps both seats human by default, so the headless table behaves like a hotseat", () => {
    const engine = testEngine();
    const controller = new WebMatchController(
      engine,
      new SeededRandomSource(7),
      new EngineOptions(PieceOwner.P1, true),
    );

    expect(controller.seats).toEqual([PieceOwner.P1, PieceOwner.P2]);
    expect(controller.awaitsHuman).toBe(true);
    expect(controller.canHumanAct).toBe(true);
    expect(controller.roll()).toBe(true);
    expect(controller.rollAutomated()).toBe(false);
  });

  it("refuses the human's actions on a bot's turn, and the bot's on a human's", () => {
    const engine = testEngine();
    const setup = setupFor(GameModes.humanVsBot);
    const controller = controllerFor(engine, new SeededRandomSource(11), setup);

    // Player one is the human's seat.
    expect(controller.awaitsHuman).toBe(true);
    expect(controller.rollAutomated()).toBe(false);
    expect(controller.roll()).toBe(true);

    // Push the turn over to the bot's seat without it having to think.
    while (!controller.state.gameOver && controller.awaitsHuman) {
      if (controller.state.isRollPhase) expect(controller.roll()).toBe(true);
      else {
        const move = controller.legalMoves[0]!;
        expect(controller.commitMove(move)).toBe(true);
      }
    }

    expect(controller.state.gameOver).toBe(false);
    expect(controller.awaitsHuman).toBe(false);
    expect(controller.canHumanAct).toBe(false);

    // Every human entry point is a no-op for this seat...
    expect(controller.roll()).toBe(false);
    expect(controller.decideReroll(1)).toBe(false);
    expect(controller.commitMove(controller.legalMoves[0] ?? new Move(0, 0))).toBe(false);
    for (const piece of controller.state.places.flatMap((place) => place.pieces)) {
      expect(controller.selectPiece(piece.id)).toBe(false);
      expect(controller.handlePlaceClick(piece.placeIndex)).toBe(false);
    }

    // ...and the view model says so, so the board offers nothing to click.
    const view = controller.viewModel;
    expect(view.humanTurn).toBe(false);
    expect(view.dice.canRoll).toBe(false);
    expect(view.dice.canReroll).toBe(false);
    expect(view.selectablePieceIds).toEqual([]);
    expect(view.cells.every((cell) => cell.pieces.every((piece) => !piece.selectable))).toBe(true);
    expect(view.statusText).toBe(translate("en", "status.thinking", { player: view.currentPlayerLabel }));

    // The bot's own entry points are the ones that work here.
    expect(controller.rollAutomated()).toBe(true);
  });

  it("swaps seats at runtime and repaints", () => {
    const engine = testEngine();
    const controller = controllerFor(engine, new SeededRandomSource(3), setupFor(GameModes.hotseat2p));

    const seen: boolean[] = [];
    controller.subscribe((view) => {
      seen.push(view.humanTurn);
    });

    controller.setHumanPlayers([PieceOwner.P2]);
    expect(controller.seats).toEqual([PieceOwner.P2]);
    expect(controller.awaitsHuman).toBe(false);
    expect(seen).toContain(false);

    // The turn is still player one's roll phase, so nothing was handed over by the seat change.
    expect(controller.state.isRollPhase).toBe(true);
    expect(controller.state.currentPlayer).toBe(PieceOwner.P1);
  });

  it("ignores a hand-over for a seat that does not exist", () => {
    const engine = testEngine();
    const controller = controllerFor(engine, new SeededRandomSource(5), setupFor(GameModes.hotseat2p));
    controller.setHumanPlayers([PieceOwner.None]);
    expect(controller.seats).toEqual([]);
    expect(controller.canHumanAct).toBe(false);
    expect(controller.roll()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------- bot driver

describe("BotDriver: the automated seats", () => {
  it("does nothing while the seat to move is a human's", async () => {
    const engine = testEngine();
    const setup = setupFor(GameModes.humanVsBot);
    const controller = controllerFor(engine, new SeededRandomSource(13), setup);
    const driver = new BotDriver(controller, engine, { thinkDelayMs: 0 });

    driver.setAgents({
      [PieceOwner.P1]: createBotAgent("heuristic", PieceOwner.P1, engine),
      [PieceOwner.P2]: createBotAgent("heuristic", PieceOwner.P2, engine),
    });

    const before = controller.state;
    await expect(driver.step()).resolves.toBe(false);
    expect(controller.state).toBe(before);
    expect(driver.agentFor(PieceOwner.P1)).not.toBeNull();
  });

  it("plays a bot-vs-bot match to a decisive end without a single human action", async () => {
    const engine = testEngine();
    const random = new SeededRandomSource(20260929);
    const setup = setupFor(GameModes.botVsBot);
    const controller = controllerFor(engine, random, setup);
    const driver = new BotDriver(controller, engine, { thinkDelayMs: 0 });

    driver.setAgents({
      [PieceOwner.P1]: createBotAgent("easy", PieceOwner.P1, engine),
      [PieceOwner.P2]: createBotAgent("easy", PieceOwner.P2, engine),
    });

    const turns: PieceOwner[] = [];
    let steps = 0;
    while (!controller.state.gameOver && steps < 20000) {
      expect(await driver.step()).toBe(true);
      turns.push(controller.state.currentPlayer);
      steps++;
    }

    expect(controller.state.gameOver).toBe(true);
    expect(controller.state.winner).not.toBe(PieceOwner.None);
    expect(engine.validateState(controller.state)).toEqual([]);
    expect(turns.length).toBeGreaterThan(0);

    // The seat to move was always the automated one, so no human action was ever legal.
    expect(controller.seats).toEqual([]);
    expect(controller.roll()).toBe(false);

    // The driver reports the finished match instead of playing on.
    await expect(driver.step()).resolves.toBe(false);

    const view = controller.viewModel;
    expect(view.phase).toBe("gameover");
    expect(view.gameOver).not.toBeNull();
    expect(view.eventMessages.length).toBeGreaterThan(0);
  });

  it("drives the same match through its own subscription when started", async () => {
    const engine = testEngine();
    const setup = setupFor(GameModes.botVsBot);
    const controller = controllerFor(engine, new SeededRandomSource(4242), setup);
    const driver = new BotDriver(controller, engine, { thinkDelayMs: 0 });

    driver.setAgents({
      [PieceOwner.P1]: createBotAgent("easy", PieceOwner.P1, engine),
      [PieceOwner.P2]: createBotAgent("easy", PieceOwner.P2, engine),
    });

    expect(driver.running).toBe(false);
    driver.start();
    expect(driver.running).toBe(true);

    // The driver paces itself with timers, so this waits for it like a spectator would.
    const deadline = Date.now() + 20000;
    while (!controller.state.gameOver && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    driver.stop();
    expect(driver.running).toBe(false);
    expect(controller.state.gameOver, "two heuristics finish a match").toBe(true);
    expect(engine.validateState(controller.state)).toEqual([]);
  }, 30000);

  it("survives an agent that rejects every decision", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = testEngine();
    const setup = setupFor(GameModes.botVsBot);
    const controller = controllerFor(engine, new SeededRandomSource(17), setup);
    const driver = new BotDriver(controller, engine, { thinkDelayMs: 0 });

    const refusing = {
      owner: PieceOwner.P1,
      name: "Refusing",
      decideReroll: () => Promise.reject(new Error("no")),
      decideMove: () => Promise.reject(new Error("no")),
    };
    driver.setAgents({
      [PieceOwner.P1]: refusing,
      // The other seat plays normally, so the match still has to reach its end.
      [PieceOwner.P2]: createBotAgent("easy", PieceOwner.P2, engine),
    });

    // The bot throws, then asks for a move and is rejected: the driver never rejects, it plays the
    // emergency heuristic instead of freezing the table.
    expect(await driver.step()).toBe(true);
    expect(controller.state.isRollPhase).toBe(false);

    let steps = 0;
    while (!controller.state.gameOver && steps < 5000) {
      expect(await driver.step()).toBe(true);
      steps++;
    }
    expect(controller.state.gameOver).toBe(true);
    expect(engine.validateState(controller.state)).toEqual([]);
    expect(reported).toHaveBeenCalled();
    reported.mockRestore();
  });

  it("aborts replaced agents and discards their late decisions", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(40, PieceType.Soldier, PieceOwner.P2, true);
    board.state.p1Captures = engine.rules.board.width - 1;
    board.state.p2Captures = engine.rules.board.width - 1;
    board.setDice(DieFace.Three);
    board.phase(TurnPhase.P1move);
    const controller = new WebMatchController(
      engine, new SeededRandomSource(1), new EngineOptions(PieceOwner.P1, true),
      board.state, { humanPlayers: [] },
    );
    const thinking: boolean[] = [];
    const driver = new BotDriver(controller, engine, {
      thinkDelayMs: 0, onThinkingChange: active => thinking.push(active),
    });
    const old = createBotAgent("easy", PieceOwner.P1, engine);
    let finish!: (move: Move) => void;
    const delayed = new Promise<Move>(resolve => { finish = resolve; });
    let signal: AbortSignal | undefined;
    old.decideMove = (_state, _moves, cancellation) => {
      signal = cancellation;
      return delayed;
    };
    driver.setAgents({ [PieceOwner.P1]: old });
    const before = controller.state.clone();
    const pending = driver.step();
    expect(thinking.at(-1)).toBe(true);
    driver.setAgents({ [PieceOwner.P1]: createBotAgent("easy", PieceOwner.P1, engine) });
    expect(thinking.at(-1)).toBe(false);
    expect(signal?.aborted).toBe(true);
    finish(engine.legalMoves(before)[0]);
    expect(await pending).toBe(false);
    expect(controller.state).toEqual(before);
    expect(await driver.step()).toBe(true);
    expect(thinking.slice(-2)).toEqual([true, false]);
    expect(engine.validateState(controller.state)).toEqual([]);
  });

  it("reports actual reroll thinking and clears it when stopped", async () => {
    const engine = testEngine();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(40, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Sahhku);
    board.phase(TurnPhase.P1move);
    const controller = new WebMatchController(
      engine, new SeededRandomSource(1), new EngineOptions(PieceOwner.P1, true),
      board.state, { humanPlayers: [] },
    );
    const thinking: boolean[] = [];
    const driver = new BotDriver(controller, engine, {
      thinkDelayMs: 0, onThinkingChange: active => thinking.push(active),
    });
    const agent = createBotAgent("easy", PieceOwner.P1, engine);
    let finish!: (decision: RerollDecision) => void;
    agent.decideReroll = () => new Promise(resolve => { finish = resolve; });
    driver.setAgents({ [PieceOwner.P1]: agent });
    const before = controller.state.clone();
    const pending = driver.step();
    expect(thinking.at(-1)).toBe(true);
    driver.stop();
    expect(thinking.at(-1)).toBe(false);
    finish(RerollDecision.KeepDiceAndProceed);
    expect(await pending).toBe(false);
    expect(controller.state).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------- audio wiring

describe("sound on committed actions", () => {
  it("maps every rule event onto one cue, most decisive first", () => {
    const event = (kind: RuleEventKind): RuleEvent =>
      new RuleEvent(kind, PieceType.Soldier, PieceOwner.P1, PieceOwner.P1);

    expect(soundForEvents([])).toBeNull();
    expect(soundForEvents([event(RuleEventKind.PieceMoved)])).toBe("move");
    expect(soundForEvents([event(RuleEventKind.SoldierCaptured)])).toBe("capture");
    expect(soundForEvents([event(RuleEventKind.KingRecruited)])).toBe("recruit");
    expect(soundForEvents([event(RuleEventKind.QueenCaptured)])).toBe("capture");
    expect(soundForEvents([event(RuleEventKind.GameWon)])).toBe("victory");

    // A capture is also a move; a win beats everything else in the same action.
    expect(
      soundForEvents([event(RuleEventKind.PieceMoved), event(RuleEventKind.SoldierCaptured)]),
    ).toBe("capture");
    expect(
      soundForEvents([
        event(RuleEventKind.PieceMoved),
        event(RuleEventKind.SoldierCaptured),
        event(RuleEventKind.GameWon),
      ]),
    ).toBe("victory");
  });

  it("plays a cue for the throw, the pick-up and the move", () => {
    const engine = testEngine();
    const sounds = new RecordingSounds();
    // A lone soldier on an empty board: the three cannot capture anything, so the cue is a plain move.
    const board = new Board(engine, PieceOwner.P1);
    board.addOnArc(20, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Three);
    board.phase(TurnPhase.P1move);

    const controller = new WebMatchController(engine, new SeededRandomSource(1), engineOptionsFor(DefaultMatchSetup), board.state, {
      humanPlayers: [PieceOwner.P1],
      sounds,
    });

    const soldier = board.state.places.flatMap((place) => place.pieces)[0]!;
    expect(controller.selectPiece(soldier.id)).toBe(true);
    expect(sounds.played).toEqual(["select"]);

    const destination = controller.viewModel.highlightedPlaces[0]!;
    expect(controller.handlePlaceClick(destination)).toBe(true);
    expect(sounds.last).toBe("move");
    expect(sounds.played).toHaveLength(2);

    // Nothing is played for a click that means nothing.
    controller.clearSelection();
    const playedSoFar = sounds.played.length;
    expect(controller.handlePlaceClick(-1)).toBe(false);
    expect(sounds.played).toHaveLength(playedSoFar);
  });

  it("plays the rattle on a throw and the fanfare on the winning move", () => {
    const engine = testEngine();
    const sounds = new RecordingSounds();
    const controller = new WebMatchController(
      engine,
      new SeededRandomSource(1),
      new EngineOptions(PieceOwner.P1, false),
      undefined,
      { humanPlayers: [PieceOwner.P1], sounds },
    );

    expect(controller.roll()).toBe(true);
    expect(sounds.played).toEqual(["roll"]);

    // A huntsman three steps short of player two's only soldier: the three captures it and wins.
    const finisher = new Board(engine, PieceOwner.P1);
    finisher.addOnArc(37, PieceType.Soldier, PieceOwner.P1, true);
    finisher.addOnArc(4, PieceType.Soldier, PieceOwner.P2, true);
    finisher.setDice(DieFace.Three);
    finisher.phase(TurnPhase.P1move);
    const winning = new RecordingSounds();
    const endgame = new WebMatchController(
      engine,
      new SeededRandomSource(2),
      new EngineOptions(PieceOwner.P1, false),
      finisher.state,
      { humanPlayers: [PieceOwner.P1], sounds: winning },
    );

    const hunter = finisher.state.places.flatMap((place) => place.pieces).find(
      (piece) => piece.owner === PieceOwner.P1,
    )!;
    expect(endgame.selectPiece(hunter.id)).toBe(true);
    expect(endgame.handlePlaceClick(endgame.viewModel.highlightedPlaces[0]!)).toBe(true);

    expect(endgame.state.gameOver).toBe(true);
    // One action, one cue: the fanfare replaces the capture and the move it also was.
    expect(winning.played).toEqual(["select", "victory"]);
  });

  it("is silent when no player was injected", () => {
    const engine = testEngine();
    const controller = new WebMatchController(
      engine,
      new SeededRandomSource(1),
      new EngineOptions(PieceOwner.P1, true),
    );
    expect(() => controller.roll()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------- localization

describe("the view model speaks the active language", () => {
  const se = (key: string, params?: Record<string, string | number>): string =>
    translate("se", key, params);

  it("labels the sides, the dice and the piece names in North Sámi", () => {
    const engine = testEngine();
    const controller = new WebMatchController(
      engine,
      new SeededRandomSource(1),
      new EngineOptions(PieceOwner.P1, true),
      undefined,
      { translate: se },
    );

    const view = controller.viewModel;
    expect(view.currentPlayerLabel).toBe("P1 · Nisut");
    expect(view.statusText).toBe(se("status.rollPrompt", { player: "P1 · Nisut" }));
    expect(view.dice.rollLabel).toBe("Bálkke birccuid");
    expect(view.dice.orderText).toBe(se("status.diceUnrolled"));

    expect(controller.roll()).toBe(true);
    const rolled = controller.viewModel;
    expect(rolled.dice.orderText).toBe(se("status.diceOrder", { die: 1, total: 3 }));
    expect(rolled.dice.rerollLabel).toBe("Bálkke ođđasit");
    expect(rolled.dice.keepLabel).toBe("Doala ja sirdde");
  });

  it("translates the event banner and the game-over card", () => {
    const engine = testEngine();
    const board = new Board(engine, PieceOwner.P1);
    board.addOnArc(37, PieceType.Soldier, PieceOwner.P1, true);
    board.addOnArc(4, PieceType.Soldier, PieceOwner.P2, true);
    board.setDice(DieFace.Three);
    board.phase(TurnPhase.P1move);

    const controller = new WebMatchController(
      engine,
      new SeededRandomSource(1),
      new EngineOptions(PieceOwner.P1, false),
      board.state,
      { translate: se },
    );

    const hunter = board.state.places.flatMap((place) => place.pieces)[0]!;
    expect(controller.selectPiece(hunter.id)).toBe(true);
    expect(controller.handlePlaceClick(controller.viewModel.highlightedPlaces[0]!)).toBe(true);

    const view = controller.viewModel;
    // The capture and the win are two events, both in the active language.
    expect(view.eventMessages[0]).toBe("P1 · Nisut gávnnai sotnjeha");
    expect(view.eventMessages).toContain(se("events.gameWon", { player: "P1 · Nisut" }));
    expect(view.gameOver!.winnerLabel).toBe("P1 · Nisut");
    expect(view.gameOver!.reasonLabel).toBe(se("win.reason.soldiersExhausted"));
    expect(view.statusText).toBe(
      se("status.gameOver", {
        player: "P1 · Nisut",
        reason: se("win.reason.soldiersExhausted"),
      }),
    );
  });

  it("re-letters the snapshot when the language changes mid-match", () => {
    const engine = testEngine();
    const controller = new WebMatchController(
      engine,
      new SeededRandomSource(1),
      new EngineOptions(PieceOwner.P1, true),
    );

    expect(controller.viewModel.currentPlayerLabel).toBe("P1 · Women");

    const seen: string[] = [];
    controller.subscribe((view) => {
      seen.push(view.statusText);
    });
    controller.setTranslator(se);

    expect(controller.viewModel.currentPlayerLabel).toBe("P1 · Nisut");
    expect(seen).toContain(se("status.rollPrompt", { player: "P1 · Nisut" }));
  });
});
