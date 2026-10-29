/**
 * Vitest port of the retired C# `RulesTests` suite.
 *
 * Every `[TestFixture]` maps onto a `describe` block and every `[Test]` method onto an `it` with the
 * same name, so the suite can be diffed against the C# original one assertion at a time. The
 * `describe` blocks below the ported fixtures cover the rest of this task's contract: the shipped
 * ruleset's fidelity to the document the port was verified against, the `.NET`-compatible seeded
 * random source and the pinned outcomes of the two seeded full-game simulations.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DieFace,
  EngineOptions,
  GameState,
  IllegalMoveException,
  Move,
  Piece,
  PieceOwner,
  PieceType,
  Place,
  RuleEvent,
  RuleEventKind,
  RuleSetException,
  RerollDecision,
  TurnPhase,
  WinReason,
  type IRandomSource,
} from "../../src/rules/domain";
import {
  MovePatterns,
  RuleSetJson,
  StartModes,
  TrackDirections,
  loadShippedRuleset,
  type RuleSet,
} from "../../src/rules/ruleset";
import { BoardLayout } from "../../src/rules/track";
import { RulesEngine } from "../../src/rules/engine";
import { GameStateFormatter } from "../../src/rules/formatter";

// ----------------------------------------------------------------------------------------------
// Test doubles (ported from the helpers in the C# `RulesTests` suite)
// ----------------------------------------------------------------------------------------------

/** A bare board with no pieces, for exercising movement/capture rules in isolation. */
class Board {
  readonly engine: RulesEngine;
  readonly state: GameState;

  private nextId = 1000;

  constructor(engine: RulesEngine, startingPlayer: PieceOwner = PieceOwner.P1) {
    this.engine = engine;
    this.state = engine.initGame(new EngineOptions(startingPlayer, false));
    for (const place of this.state.places) place.pieces.length = 0;
  }

  add(
    placeIndex: number,
    type: PieceType,
    owner: PieceOwner,
    active = false,
    activatable = false,
  ): Piece {
    const piece = new Piece(this.nextId++, placeIndex, type, owner, active);
    piece.arc = this.engine.arcOfPlace(owner, placeIndex);
    piece.canBeActivated = activatable;
    this.state.places[placeIndex].pieces.push(piece);
    return piece;
  }

  /** Places a piece on a specific arc, i.e. on a specific pass over the board. */
  addOnArc(
    arc: number,
    type: PieceType,
    owner: PieceOwner,
    active = false,
    activatable = false,
  ): Piece {
    const place = this.engine.placeOfArc(owner, arc);
    const piece = new Piece(this.nextId++, place, type, owner, active);
    piece.arc = arc;
    piece.canBeActivated = activatable;
    this.state.places[place].pieces.push(piece);
    return piece;
  }

  /** Sets the dice and resets the active die to the first one. */
  setDice(...faces: DieFace[]): void {
    this.state.dice.length = 0;
    this.state.dice.push(...faces);
    this.state.currentActiveDie = 0;
  }

  phase(phase: TurnPhase): void {
    this.state.turnPhase = phase;
  }

  activeDie(index: number): void {
    this.state.currentActiveDie = index;
  }
}

class SequenceRandomSource implements IRandomSource {
  private index = 0;
  private readonly values: number[];

  constructor(values: number[]) {
    this.values = values;
  }

  nextDieFaceIndex(): number {
    return this.values[this.index++ % this.values.length];
  }
}

/**
 * The seeded source used by the simulation tests: an exact port of .NET's `System.Random(seed)`
 * (the legacy Knuth subtractive generator) so the two seeded games reproduce the reference
 * implementation's move-for-move outcome.
 */
class SystemRandomSource implements IRandomSource {
  private static readonly INT_MAX = 2147483647;

  private readonly seedArray: number[] = new Array<number>(56).fill(0);
  private inext = 0;
  private inextp = 21;

  constructor(seed: number) {
    const subtraction = seed === -2147483648 ? SystemRandomSource.INT_MAX : Math.abs(seed);
    let mj = 161803398 - subtraction;
    this.seedArray[55] = mj;
    let mk = 1;
    let ii = 0;
    for (let i = 1; i < 55; i++) {
      if ((ii += 21) >= 55) ii -= 55;
      this.seedArray[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += SystemRandomSource.INT_MAX;
      mj = this.seedArray[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        let n = i + 30;
        if (n >= 55) n -= 55;
        this.seedArray[i] -= this.seedArray[1 + n];
        if (this.seedArray[i] < 0) this.seedArray[i] += SystemRandomSource.INT_MAX;
      }
    }
  }

  private sample(): number {
    let locINext = this.inext;
    let locINextp = this.inextp;
    if (++locINext >= 56) locINext = 1;
    if (++locINextp >= 56) locINextp = 1;
    let retVal = this.seedArray[locINext] - this.seedArray[locINextp];
    if (retVal === SystemRandomSource.INT_MAX) retVal--;
    if (retVal < 0) retVal += SystemRandomSource.INT_MAX;
    this.seedArray[locINext] = retVal;
    this.inext = locINext;
    this.inextp = locINextp;
    return retVal * (1.0 / SystemRandomSource.INT_MAX);
  }

  nextDieFaceIndex(): number {
    return this.next(4);
  }

  next(max: number): number {
    return Math.trunc(this.sample() * max);
  }
}

const Events = {
  has(events: RuleEvent[], kind: RuleEventKind): boolean {
    return events.some((ruleEvent) => ruleEvent.kind === kind);
  },
};

// ----------------------------------------------------------------------------------------------
// The shipped ruleset (ported from the C# `TestRuleset` fixture)
// ----------------------------------------------------------------------------------------------

const RULESET_RELATIVE_PATH = join("src", "rules", "SahkkuRules.json");
const RULESET_ENVIRONMENT_VARIABLE = "SAHKKU_RULESET";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function searchUpwards(start: string): string | null {
  let directory = resolve(start);
  for (;;) {
    const candidate = join(directory, RULESET_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(directory, "..");
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Supplies the shipped (canonical) ruleset JSON to the engine tests. */
const TestRuleset = {
  path(): string {
    const fromEnvironment = process.env[RULESET_ENVIRONMENT_VARIABLE];
    if (fromEnvironment && existsSync(fromEnvironment)) return fromEnvironment;

    // Search upwards from wherever the test host happens to run, so the same code works from
    // `npm test`, from an IDE runner and from the repo root.
    const found = searchUpwards(process.cwd()) ?? searchUpwards(moduleDirectory);
    if (found != null) return found;

    throw new Error(
      `Could not locate '${RULESET_RELATIVE_PATH}'. Set ${RULESET_ENVIRONMENT_VARIABLE} to the ruleset file path.`,
    );
  },

  json(): string {
    return readFileSync(TestRuleset.path(), "utf8");
  },

  load(): RuleSet {
    return RuleSetJson.fromJson(TestRuleset.json());
  },
};

function engineFromShippedRuleset(): RulesEngine {
  return new RulesEngine(TestRuleset.load());
}

// ----------------------------------------------------------------------------------------------

describe("SetupTests", () => {
  it("IndexFromCoordinates_MatchesTheSnakeLayout", () => {
    const engine = engineFromShippedRuleset();
    expect(engine.indexFromCoordinates(0, 0)).toBe(0);
    expect(engine.indexFromCoordinates(14, 0)).toBe(14);
    expect(engine.indexFromCoordinates(14, 1)).toBe(15);
    expect(engine.indexFromCoordinates(0, 1)).toBe(29);
    expect(engine.indexFromCoordinates(0, 2)).toBe(30);
    expect(engine.indexFromCoordinates(14, 2)).toBe(44);

    // Queens (x=11 P1, x=3 P2) and the king (centre) on the middle row.
    expect(engine.indexFromCoordinates(11, 1)).toBe(18);
    expect(engine.indexFromCoordinates(3, 1)).toBe(26);
    expect(engine.indexFromCoordinates(7, 1)).toBe(22);

    expect(engine.indexFromCoordinates(-1, 0)).toBe(-1);
    expect(engine.indexFromCoordinates(15, 0)).toBe(-1);
    expect(engine.indexFromCoordinates(0, -1)).toBe(-1);
    expect(engine.indexFromCoordinates(0, 3)).toBe(-1);
  });

  it("InitGame_Standard_PlacesPiecesAndActivation", () => {
    const engine = engineFromShippedRuleset();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, false));

    expect(state.places.length).toBe(45);
    expect(state.dice.length).toBe(3);
    for (const face of state.dice) expect(face).toBe(DieFace.Zero);
    expect(state.turnPhase).toBe(TurnPhase.P1roll);
    expect(state.currentPlayer).toBe(PieceOwner.P1);

    for (let i = 0; i <= 14; ++i) {
      const place = state.places[i];
      expect(place.pieces.length, `place ${i}`).toBe(1);
      expect(place.pieces[0].type).toBe(PieceType.Soldier);
      expect(place.pieces[0].owner).toBe(PieceOwner.P1);
      expect(place.pieces[0].isActive).toBe(false);
      expect(place.pieces[0].canBeActivated, `canBeActivated at ${i}`).toBe(i === 14);
    }

    for (let i = 30; i <= 44; ++i) {
      const place = state.places[i];
      expect(place.pieces.length, `place ${i}`).toBe(1);
      expect(place.pieces[0].type).toBe(PieceType.Soldier);
      expect(place.pieces[0].owner).toBe(PieceOwner.P2);
      expect(place.pieces[0].isActive).toBe(false);
      expect(place.pieces[0].canBeActivated, `canBeActivated at ${i}`).toBe(i === 30);
    }

    expect(state.places[18].pieces[0].type).toBe(PieceType.Queen);
    expect(state.places[18].pieces[0].owner).toBe(PieceOwner.P1);
    expect(state.places[18].pieces[0].canBeActivated).toBe(true);

    expect(state.places[26].pieces[0].type).toBe(PieceType.Queen);
    expect(state.places[26].pieces[0].owner).toBe(PieceOwner.P2);
    expect(state.places[26].pieces[0].canBeActivated).toBe(true);

    expect(state.places[22].pieces[0].type).toBe(PieceType.King);
    expect(state.places[22].pieces[0].owner).toBe(PieceOwner.None);
    expect(state.places[22].pieces[0].isActive).toBe(false);
    expect(state.places[22].pieces[0].canBeActivated).toBe(false);

    expect(engine.validateState(state), "the initial position must satisfy the invariants").toEqual([]);
  });

  it("InitGame_EvenOdds_AdvancesTheThreeForemostSoldiersOneStep", () => {
    const engine = engineFromShippedRuleset();
    const standard = engine.initGame(new EngineOptions(PieceOwner.P1, false));
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));

    const movements = new Map([[12, 13], [13, 14], [14, 15], [30, 29], [31, 30], [32, 31]]);
    for (const original of standard.places.flatMap((place) => place.pieces)) {
      const piece = engine.findPiece(state, original.id)!;
      const destination = movements.get(original.placeIndex);
      expect(piece.placeIndex).toBe(destination ?? original.placeIndex);
      expect(state.places[piece.placeIndex].pieces).toContain(piece);
      expect(piece.arc).toBe(original.arc + (destination == null ? 0 : 1));
      expect(piece.isActive).toBe(destination != null);
      expect(piece.canBeActivated).toBe(
        original.type === PieceType.Queen || [11, 33].includes(original.placeIndex),
      );
    }
    expect(state.places[12].pieces).toHaveLength(0);
    expect(state.places[32].pieces).toHaveLength(0);
    expect(state.places.flatMap((place) => place.pieces)).toHaveLength(33);
    expect(state.dice).toEqual(standard.dice);
    expect(state.turnPhase).toBe(standard.turnPhase);
    expect(state.currentActiveDie).toBe(standard.currentActiveDie);

    expect(state.places[11].pieces[0].canBeActivated).toBe(true);
    expect(state.places[33].pieces[0].canBeActivated).toBe(true);

    expect(state.places[18].pieces[0].canBeActivated).toBe(true);
    expect(state.places[26].pieces[0].canBeActivated).toBe(true);

    expect(engine.rules.variants.evenOdds.soldiersActive).toBe(3);
    expect(engine.rules.variants.standard.soldiersActive).toBe(0);
    expect(engine.validateState(state)).toEqual([]);
  });

  it.each([1, 4, 14])("InitGame_AdvancesTheConfiguredNumberOfSoldiers (%i)", (count) => {
    const engine = engineFromShippedRuleset();
    engine.rules.variants.evenOdds.soldiersActive = count;
    const state = engine.initGame(new EngineOptions(PieceOwner.P2, true));
    for (const owner of [PieceOwner.P1, PieceOwner.P2]) {
      const soldiers = state.places.flatMap((place) => place.pieces)
        .filter((piece) => piece.type === PieceType.Soldier && piece.owner === owner);
      expect(soldiers).toHaveLength(15);
      expect(soldiers.filter((piece) => piece.isActive).map((piece) => piece.arc).sort((a, b) => a - b))
        .toEqual(Array.from({ length: count }, (_, i) => 16 - count + i));
      expect(soldiers.filter((piece) => piece.canBeActivated).map((piece) => piece.arc))
        .toEqual([14 - count]);
    }
    expect(state.turnPhase).toBe(TurnPhase.P2roll);
    expect(engine.validateState(state)).toEqual([]);
  });

  it("InitGame_RespectsStartingPlayer", () => {
    const state = engineFromShippedRuleset().initGame(new EngineOptions(PieceOwner.P2, false));
    expect(state.turnPhase).toBe(TurnPhase.P2roll);
    expect(state.currentPlayer).toBe(PieceOwner.P2);
  });

  it("ThrowForStartingPlayer_FirstSahhkuStarts", () => {
    const engine = engineFromShippedRuleset();

    // P1 throws blank-blank-blank (3,3,3), P2 throws a sáhkku on the first die.
    const random = new SequenceRandomSource([3, 3, 3, 0, 1, 1, 2]);
    expect(engine.throwForStartingPlayer(random)).toBe(PieceOwner.P2);
  });

  it("InitGame_WithThrowForStartingPlayer_SetsValidPlayer", () => {
    const engine = engineFromShippedRuleset();

    // P1 throws blank-blank-blank (face index 3), P2 throws a sáhkku on the first die.
    const random = new SequenceRandomSource([3, 3, 3, 0]);
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, false, true), random);

    expect(state.turnPhase).toBe(TurnPhase.P2roll);
    expect(state.currentPlayer).toBe(PieceOwner.P2);
    // The rest of the setup is untouched by the throw.
    expect(state.places.length).toBe(45);
    expect(engine.validateState(state), "the initial position must satisfy the invariants").toEqual([]);
  });

  it("InitGame_WithoutThrowForStartingPlayer_IgnoresTheRandomSource", () => {
    const engine = engineFromShippedRuleset();
    const state = engine.initGame(
      new EngineOptions(PieceOwner.P2, false),
      new SequenceRandomSource([0]),
    );

    expect(state.turnPhase).toBe(TurnPhase.P2roll);
    expect(state.currentPlayer).toBe(PieceOwner.P2);
  });

  it("InitGame_WithThrowForStartingPlayer_RequiresARandomSource", () => {
    const engine = engineFromShippedRuleset();
    expect(() => engine.initGame(new EngineOptions(PieceOwner.P1, false, true), null)).toThrow(
      RuleSetException,
    );
  });
});

describe("RerollDecisionTests", () => {
  it("RollDice_OrdersTheDiceAndOpensTheDecisionPoint", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine); // P1 roll phase, dice are Zero placeholders
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);

    engine.rollDice(board.state, new SequenceRandomSource([0, 2, 3]));

    expect(board.state.dice).toEqual([DieFace.Sahhku, DieFace.Two, DieFace.Zero]);
    expect(board.state.turnPhase).toBe(TurnPhase.P1move);
    expect(board.state.currentActiveDie).toBe(0);
    expect(engine.canReroll(board.state), "a sáhkku may be re-rolled before any die is spent").toBe(
      true,
    );
  });

  it("RerollDecision_KeepDice_ProceedsToMoveWithoutRerolling", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);

    // All three dice come up sáhkku.
    engine.rollDice(board.state, new SequenceRandomSource([0]));
    expect(board.state.dice).toEqual([DieFace.Sahhku, DieFace.Sahhku, DieFace.Sahhku]);
    expect(engine.canReroll(board.state), "the sáhkku may still be re-rolled before any die is spent").toBe(
      true,
    );

    engine.applyRerollDecision(board.state, RerollDecision.KeepDiceAndProceed, new SequenceRandomSource([0]));

    // The dice are kept exactly as thrown and the turn moves into move evaluation.
    expect(board.state.dice).toEqual([DieFace.Sahhku, DieFace.Sahhku, DieFace.Sahhku]);
    expect(board.state.turnPhase).toBe(TurnPhase.P1move);
    expect(board.state.currentActiveDie).toBe(0);
    expect(engine.canReroll(board.state), "keeping the dice closes re-rolling for this throw").toBe(
      false,
    );

    // Moves are enabled: the loose soldier may spend the X on a one-step move.
    expect(engine.getAllowedPlaces(board.state, board.state.places[5].pieces[0])).toEqual([6]);
    const moves = engine.legalMoves(board.state);
    expect(moves.length).toBe(1);
    expect(moves[0].targetPlaceIndex).toBe(6);
  });

  it("RerollDecision_Reroll_ReplacesDieAndReorders", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);

    // Throw X II - (face indices 0, 2, 3), which orders to [X, II, -].
    engine.rollDice(board.state, new SequenceRandomSource([0, 2, 3]));
    expect(board.state.dice).toEqual([DieFace.Sahhku, DieFace.Two, DieFace.Zero]);

    // Re-roll the active die; it comes up III (face index 1).
    engine.applyRerollDecision(board.state, RerollDecision.RerollActiveDie, new SequenceRandomSource([1]));

    expect(board.state.dice).toEqual([DieFace.Three, DieFace.Two, DieFace.Zero]);
    expect(board.state.turnPhase).toBe(TurnPhase.P1move);
    expect(board.state.currentActiveDie).toBe(0);
    expect(engine.canReroll(board.state), "the re-rolled face is not a sáhkku").toBe(false);

    // The die count and spending order are intact: re-ordering changes nothing.
    const reordered = board.state.clone();
    engine.orderDice(reordered);
    expect(reordered.dice, "the dice must already be in spending order").toEqual(board.state.dice);

    // And the soldier may now spend III.
    expect(engine.getAllowedPlaces(board.state, board.state.places[5].pieces[0])).toEqual([8]);
  });

  it("RerollDecision_AfterDieSpent_RefusesReroll", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku, DieFace.Sahhku, DieFace.Sahhku);

    // The first die has been spent; the ruleset forbids re-rolling after that.
    board.activeDie(1);

    expect(() =>
      engine.applyRerollDecision(
        board.state,
        RerollDecision.RerollActiveDie,
        new SequenceRandomSource([0]),
      ),
    ).toThrow(IllegalMoveException);
  });

  it("RerollDecision_KeepIsAlwaysLegalEvenWithoutARerollableFace", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);

    // No sáhkku at all: there is nothing to re-roll, but keeping must still proceed.
    engine.rollDice(board.state, new SequenceRandomSource([2]));
    expect(board.state.dice).toEqual([DieFace.Two, DieFace.Two, DieFace.Two]);
    expect(engine.canReroll(board.state)).toBe(false);

    engine.applyRerollDecision(board.state, RerollDecision.KeepDiceAndProceed, null);

    expect(board.state.turnPhase).toBe(TurnPhase.P1move);
    expect(engine.getAllowedPlaces(board.state, board.state.places[5].pieces[0])).toEqual([7]);
  });

  it("RerollDecision_RerollWithoutARandomSource_Throws", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Sahhku, DieFace.Sahhku, DieFace.Three);
    board.phase(TurnPhase.P1move);

    // A missing die source is an argument/setup fault, not a null dereference, and the state is
    // left untouched for a caller that can recover.
    expect(() => engine.applyRerollDecision(board.state, RerollDecision.RerollActiveDie, null)).toThrow(
      RuleSetException,
    );
    expect(board.state.dice).toEqual([DieFace.Sahhku, DieFace.Sahhku, DieFace.Three]);
    expect(board.state.turnPhase).toBe(TurnPhase.P1move);
  });
});

describe("TrackTests", () => {
  it("Track_WalksTheFigureOfEightAndReturnsToTheHomeRow", () => {
    const engine = engineFromShippedRuleset();
    expect(engine.trackLength).toBe(60);

    // Home row right, middle row left, enemy row right, middle row left, then home again.
    const expected = new Array<number>(60);
    for (let i = 0; i < 15; ++i) expected[i] = i; // row 0, x 0..14
    for (let i = 0; i < 15; ++i) expected[15 + i] = 15 + i; // row 1, x 14..0
    for (let i = 0; i < 15; ++i) expected[30 + i] = 30 + i; // row 2, x 0..14
    for (let i = 0; i < 15; ++i) expected[45 + i] = 15 + i; // row 1 again, x 14..0

    for (let arc = 0; arc < 60; ++arc) {
      expect(engine.placeOfArc(PieceOwner.P1, arc), `P1 arc ${arc}`).toBe(expected[arc]);
    }
    expect(engine.placeOfArc(PieceOwner.P1, 0), "the lap closes").toBe(
      engine.placeOfArc(PieceOwner.P1, 60),
    );
  });

  it("Track_IsTheBoardMirrorForTheSecondPlayer", () => {
    const engine = engineFromShippedRuleset();
    for (let arc = 0; arc < engine.trackLength; ++arc) {
      const p1 = engine.placeOfArc(PieceOwner.P1, arc);
      const p2 = engine.placeOfArc(PieceOwner.P2, arc);

      const { x, y } = BoardLayout.coordinatesFromIndex(15, p1);
      expect(engine.indexFromCoordinates(14 - x, 2 - y), `arc ${arc}`).toBe(p2);
    }

    expect(engine.homeRowOf(PieceOwner.P1)).toBe(0);
    expect(engine.homeRowOf(PieceOwner.P2)).toBe(2);
    expect(engine.placeOfArc(PieceOwner.P1, 14)).toBe(14);
    expect(engine.placeOfArc(PieceOwner.P2, 14)).toBe(30);
  });

  it("SecondPassOverTheMiddleRow_DescendsIntoTheHomeRow", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);

    // The same board cell (x=0, y=1) is reached twice per lap. On the way out the soldier
    // steps up to the enemy row; on the way back it steps down into its home row.
    const outbound = board.addOnArc(29, PieceType.Soldier, PieceOwner.P1, true);
    board.addOnArc(0, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    expect(outbound.placeIndex).toBe(29);
    expect(engine.getAllowedPlaces(board.state, outbound)).toEqual([30]);

    const board2 = new Board(engine);
    const returning = board2.addOnArc(59, PieceType.Soldier, PieceOwner.P1, true);
    board2.addOnArc(0, PieceType.Soldier, PieceOwner.P1, true);
    board2.phase(TurnPhase.P1move);
    board2.setDice(DieFace.Sahhku);

    expect(returning.placeIndex, "arc 59 also stands on x=0, y=1").toBe(29);
    expect(engine.getAllowedPlaces(board2.state, returning)).toEqual([0]);
  });

  it("Soldier_AtTheEndOfTheEnemyRow_ContinuesOnTheMiddleRow", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const piece = board.add(44, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    // 44 = (14, 2): instead of falling off the board it turns onto the middle row.
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([15]);

    board.setDice(DieFace.Three);
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([17]);
  });

  it("PlayerTwo_AtTheEndOfItsEnemyRow_ContinuesOnTheMiddleRow", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine, PieceOwner.P2);
    const piece = board.add(0, PieceType.Soldier, PieceOwner.P2, true);
    board.phase(TurnPhase.P2move);
    board.setDice(DieFace.Sahhku);

    // 0 = (0, 0) is the end of player two's enemy row.
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([29]);
  });

  it("Soldier_FullLap_ReturnsToItsStartingCell", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const soldier = board.addOnArc(1, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);

    const legs = [Math.trunc(soldier.arc / 15)];
    // Twenty three-line moves are sixty lines: exactly one lap of the figure of eight.
    for (let move = 0; move < 20; ++move) {
      board.setDice(DieFace.Three);
      engine.evaluateAllowedPlaces(board.state);
      const allowed = engine.getAllowedPlaces(board.state, soldier);
      expect(allowed.length, `move ${move}`).toBe(1);
      engine.applyMove(board.state, new Move(soldier.id, allowed[0]));
      board.phase(TurnPhase.P1move);

      if (legs[legs.length - 1] !== Math.trunc(soldier.arc / 15)) legs.push(Math.trunc(soldier.arc / 15));
    }

    // Home row -> middle row -> enemy row -> middle row -> back into the home row.
    expect(legs).toEqual([0, 1, 2, 3, 0]);
    expect(soldier.arc).toBe(1);
    expect(soldier.placeIndex).toBe(engine.placeOfArc(PieceOwner.P1, 1));
  });

  it("King_CrossingAtTheBendIsAlsoAStraightStep", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const king = board.add(14, PieceType.King, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    // At the bend the forward step and the vertical crossing lead to the same cell, so it is
    // offered once; the king may also step straight back along its home row.
    expect(engine.placeOfArc(PieceOwner.P1, king.arc + 1)).toBe(15);
    expect(engine.getAllowedPlaces(board.state, king)).toEqual([15, 13]);
  });
});

describe("MovementTests", () => {
  it("Soldier_MovesForwardByTheDieValue", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);

    const piece = board.state.places[5].pieces[0];

    board.setDice(DieFace.Sahhku);
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([6]);

    board.setDice(DieFace.Three);
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([8]);

    board.setDice(DieFace.Two);
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([7]);

    board.setDice(DieFace.Zero);
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([]);
  });

  it("InactiveSoldier_NeedsSahhkuAndActivation", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const piece = board.add(5, PieceType.Soldier, PieceOwner.P1, false, false);
    board.phase(TurnPhase.P1move);

    board.setDice(DieFace.Sahhku);
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([]);

    piece.canBeActivated = true;
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([6]);

    board.setDice(DieFace.Three);
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([]);
  });

  it("PlayerTwo_MovesInTheOppositeDirection", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine, PieceOwner.P2);
    board.add(44, PieceType.Soldier, PieceOwner.P2, true);
    board.phase(TurnPhase.P2move);
    board.setDice(DieFace.Sahhku);

    const piece = board.state.places[44].pieces[0];
    expect(engine.getAllowedPlaces(board.state, piece)).toEqual([43]);
  });

  it("Queen_MovesForwardBackwardAndVertically", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(22, PieceType.Queen, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    // 22 = (7,1): forward 23, backward 21, vertical up 37 = (7,2), vertical down 7 = (7,0).
    expect(engine.getAllowedPlaces(board.state, board.state.places[22].pieces[0])).toEqual([
      23, 21, 37, 7,
    ]);
  });

  it("Queen_SkipsVerticalMovesThatLeaveTheBoard", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(7, PieceType.Queen, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    // 7 = (7,0): forward 8, backward 6, vertical up 22, vertical down off-board.
    expect(engine.getAllowedPlaces(board.state, board.state.places[7].pieces[0])).toEqual([8, 6, 22]);
  });

  it("King_MovesLikeAQueenOnceActive", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(22, PieceType.King, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    expect(engine.getAllowedPlaces(board.state, board.state.places[22].pieces[0])).toEqual([
      23, 21, 37, 7,
    ]);
  });

  it("King_CrossesRowsOnlyWithTheExactDieValue", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    // 22 = the Castle, middle row (7,1).
    board.add(22, PieceType.King, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    const king = board.state.places[22].pieces[0];

    // From the middle row, crossing to a home row needs an X (one line).
    board.setDice(DieFace.Three);
    expect(engine.getAllowedPlaces(board.state, king)).not.toContain(37);
    expect(engine.getAllowedPlaces(board.state, king)).not.toContain(7);

    board.setDice(DieFace.Sahhku);
    expect(engine.getAllowedPlaces(board.state, king)).toContain(37);
    expect(engine.getAllowedPlaces(board.state, king)).toContain(7);
  });

  it("King_FromTheHomeRowCrossesTheMiddleRowOrJumpsToTheEnemyRow", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const king = board.add(7, PieceType.King, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);

    board.setDice(DieFace.Sahhku);
    expect(engine.getAllowedPlaces(board.state, king)).toContain(22); // (7,1)
    board.setDice(DieFace.Two);
    // II crosses straight over the middle row onto the enemy row.
    expect(engine.getAllowedPlaces(board.state, king)).toContain(37); // (7,2)
    expect(engine.getAllowedPlaces(board.state, king)).not.toContain(22);
  });

  it("Soldier_CannotLandOnOwnQueenOrKing", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Queen, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    expect(engine.getAllowedPlaces(board.state, board.state.places[5].pieces[0])).toEqual([]);
  });

  it("Queen_CannotLandOnOwnUnits", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Queen, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    const allowed = engine.getAllowedPlaces(board.state, board.state.places[5].pieces[0]);
    expect(allowed).not.toContain(6);
  });

  it("Soldier_MayStackOnOwnActiveSoldier", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    expect(engine.getAllowedPlaces(board.state, board.state.places[5].pieces[0])).toEqual([6]);
  });

  it("Soldier_CannotLandOnInactiveOpponent", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P2, false);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    expect(engine.getAllowedPlaces(board.state, board.state.places[5].pieces[0])).toEqual([]);
  });

  it("InactiveRule_ComesFromTheRuleset", () => {
    const rules = TestRuleset.load();
    rules.inactive.enterable = true; // a variant where unactivated pieces may be attacked
    const engine = new RulesEngine(rules);

    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P2, false);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    expect(engine.getAllowedPlaces(board.state, board.state.places[5].pieces[0])).toEqual([6]);
  });

  it("GetLegalMoves_FlattensAllowedPlaces", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(7, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);

    const moves = engine.getLegalMoves(board.state);
    expect(moves.length).toBe(2);
    expect(moves.some((m) => m.targetPlaceIndex === 6)).toBe(true);
    expect(moves.some((m) => m.targetPlaceIndex === 8)).toBe(true);
  });

  it("LegalMoves_DoesNotNeedAnEarlierEvaluateAllowedPlaces", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    const moves = engine.legalMoves(board.state);
    expect(moves.length).toBe(1);
    expect(moves[0].targetPlaceIndex).toBe(6);
  });
});

describe("CaptureTests", () => {
  function prepareSoldierCapture(
    engine: RulesEngine,
    board: Board,
    targetType: PieceType,
    targetOwner: PieceOwner,
    targetActive: boolean,
  ): Piece {
    const attacker = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, targetType, targetOwner, targetActive);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);
    return attacker;
  }

  it("CapturingASoldier_ScoresAndRemovesIt", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const attacker = prepareSoldierCapture(engine, board, PieceType.Soldier, PieceOwner.P2, true);
    board.state.p1Captures = 0;

    const events = engine.applyMove(board.state, new Move(attacker.id, 6));

    expect(Events.has(events, RuleEventKind.SoldierCaptured)).toBe(true);
    expect(Events.has(events, RuleEventKind.PieceMoved)).toBe(false);
    expect(board.state.p1Captures).toBe(1);
    expect(board.state.p2Captures).toBe(0);
    expect(attacker.placeIndex).toBe(6);
    expect(board.state.places[6].pieces.length).toBe(1);
  });

  it("CapturingEveryEnemySoldier_EndsTheGame", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const attacker = prepareSoldierCapture(engine, board, PieceType.Soldier, PieceOwner.P2, true);
    board.state.p1Captures = 14; // the other fourteen were taken earlier

    const events = engine.applyMove(board.state, new Move(attacker.id, 6));

    expect(board.state.p1Captures).toBe(15);
    expect(board.state.gameOver).toBe(true);
    expect(board.state.winner).toBe(PieceOwner.P1);
    expect(board.state.winReason).toBe(WinReason.OpponentSoldiersExhausted);
    expect(Events.has(events, RuleEventKind.GameWon)).toBe(true);
  });

  it("CapturingTheQueen_EndsTheGame", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const attacker = prepareSoldierCapture(engine, board, PieceType.Queen, PieceOwner.P2, true);

    const events = engine.applyMove(board.state, new Move(attacker.id, 6));

    expect(board.state.gameOver).toBe(true);
    expect(board.state.winner).toBe(PieceOwner.P1);
    expect(board.state.winReason).toBe(WinReason.QueenCaptured);
    expect(Events.has(events, RuleEventKind.QueenCaptured)).toBe(true);
    expect(Events.has(events, RuleEventKind.GameWon)).toBe(true);
    expect(board.state.places[6].pieces.length).toBe(1);
  });

  it("LosingTheQueenOnlyEndsTheGameWhenTheRulesetSaysSo", () => {
    const rules = TestRuleset.load();
    rules.pieces.queen.landingEndsGame = false; // e.g. a variant where the queen does not decide the game
    const engine = new RulesEngine(rules);

    const board = new Board(engine);
    const attacker = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Queen, PieceOwner.P2, true);
    board.add(7, PieceType.Soldier, PieceOwner.P2, true); // the opponent still has a soldier
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);

    engine.applyMove(board.state, new Move(attacker.id, 6));

    expect(board.state.places[6].pieces.length).toBe(1);
    expect(board.state.places[6].pieces[0].type, "the queen is gone, the soldier stands there").toBe(
      PieceType.Soldier,
    );
    expect(board.state.gameOver).toBe(false);
    expect(board.state.winReason).toBe(WinReason.None);
  });

  it("LandingOnTheKing_RecruitsIt", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const attacker = prepareSoldierCapture(engine, board, PieceType.King, PieceOwner.None, true);

    const events = engine.applyMove(board.state, new Move(attacker.id, 6));

    expect(Events.has(events, RuleEventKind.KingRecruited)).toBe(true);
    expect(board.state.places[6].pieces[0].owner).toBe(PieceOwner.P1);
    expect(board.state.places[6].pieces.length).toBe(2);
    expect(board.state.gameOver).toBe(false);
  });

  it("MovingASoldierIntoEnemyTerritory_ActivatesTheNeutralKing", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const king = board.add(22, PieceType.King, PieceOwner.None, false);
    const attacker = board.add(29, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);

    engine.applyMove(board.state, new Move(attacker.id, 30));

    expect(king.isActive).toBe(true);
    expect(king.owner).toBe(PieceOwner.P1);
  });

  it("KingRecruitmentComesFromTheRuleset", () => {
    const rules = TestRuleset.load();
    rules.pieces.soldier.recruitsKingOnEnemyHomeRow = false;
    const engine = new RulesEngine(rules);

    const board = new Board(engine);
    const king = board.add(22, PieceType.King, PieceOwner.None, false);
    const attacker = board.add(29, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);

    engine.applyMove(board.state, new Move(attacker.id, 30));

    expect(king.isActive).toBe(false);
    expect(king.owner).toBe(PieceOwner.None);
  });

  it("MovingAnInactiveSoldier_MakesTheNeighbourActivatable", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(4, PieceType.Soldier, PieceOwner.P1, false, false);
    const attacker = board.add(5, PieceType.Soldier, PieceOwner.P1, false, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);

    engine.applyMove(board.state, new Move(attacker.id, 6));

    expect(board.state.places[4].pieces[0].canBeActivated).toBe(true);
    expect(attacker.isActive).toBe(true);
  });

  it("MovingAnInactiveQueen_DoesNotUnlockASoldier", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(4, PieceType.Soldier, PieceOwner.P1, false, false);
    const queen = board.add(5, PieceType.Queen, PieceOwner.P1, false, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);

    engine.applyMove(board.state, new Move(queen.id, 6));

    expect(board.state.places[4].pieces[0].canBeActivated).toBe(false);
  });
});

describe("MoveValidationTests", () => {
  function ready(engine: RulesEngine): Board {
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P2, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);
    return board;
  }

  it("ApplyMove_RejectsATargetThatIsNotLegal", () => {
    const engine = engineFromShippedRuleset();
    const board = ready(engine);
    const attacker = board.state.places[5].pieces[0];

    expect(() => engine.applyMove(board.state, new Move(attacker.id, 30))).toThrow(IllegalMoveException);
    expect(attacker.placeIndex, "the piece must not have moved").toBe(5);
  });

  it("ApplyMove_RejectsAnOffBoardTarget", () => {
    const engine = engineFromShippedRuleset();
    const board = ready(engine);
    const attacker = board.state.places[5].pieces[0];

    expect(() => engine.applyMove(board.state, new Move(attacker.id, 9999))).toThrow(IllegalMoveException);
    expect(() => engine.applyMove(board.state, new Move(attacker.id, -1))).toThrow(IllegalMoveException);
  });

  it("ApplyMove_RejectsTheOpponentsPiece", () => {
    const engine = engineFromShippedRuleset();
    const board = ready(engine);
    const victim = board.state.places[6].pieces[0];

    expect(() => engine.applyMove(board.state, new Move(victim.id, 6))).toThrow(IllegalMoveException);
  });

  it("ApplyMove_IsRejectedAfterTheGameHasEnded", () => {
    const engine = engineFromShippedRuleset();
    const board = ready(engine);
    const attacker = board.state.places[5].pieces[0];
    board.state.gameOver = true;
    board.state.winner = PieceOwner.P1;

    expect(() => engine.applyMove(board.state, new Move(attacker.id, 6))).toThrow(IllegalMoveException);
  });

  it("TryApplyMove_ReportsIllegalMovesWithoutThrowing", () => {
    const engine = engineFromShippedRuleset();
    const board = ready(engine);
    const attacker = board.state.places[5].pieces[0];

    const refused = engine.tryApplyMove(board.state, new Move(attacker.id, 30));
    expect(refused.success).toBe(false);
    expect(refused.events).toEqual([]);
    const applied = engine.tryApplyMove(board.state, new Move(attacker.id, 6));
    expect(applied.success).toBe(true);
    expect(applied.events.length).toBeGreaterThan(0);
  });

  it("Clone_LetsASearchTryAMoveWithoutTouchingTheLiveGame", () => {
    const engine = engineFromShippedRuleset();
    const board = ready(engine);
    const attacker = board.state.places[5].pieces[0];

    const copy = board.state.clone();
    expect(engine.tryApplyMove(copy, new Move(attacker.id, 6)).success).toBe(true);

    expect(engine.findPiece(copy, attacker.id)?.placeIndex, "the copy moved").toBe(6);
    expect(attacker.placeIndex, "the live game did not").toBe(5);
    expect(copy.gameOver, "the copy took the opponent's last soldier").toBe(true);
    expect(board.state.gameOver, "the live game is untouched").toBe(false);
  });

  it("EvaluateAllowedPlaces_IsFalseWhileTheDiceAreStillToBeThrown", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1roll);
    board.setDice(DieFace.Sahhku);

    expect(engine.evaluateAllowedPlaces(board.state)).toBe(false);
    expect(engine.legalMoves(board.state)).toEqual([]);
  });
});

describe("TurnTests", () => {
  it("OrderDice_UsesTheRulesetSpendingOrder", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.setDice(DieFace.Zero, DieFace.Two, DieFace.Sahhku);

    engine.orderDice(board.state);

    expect(board.state.dice).toEqual([DieFace.Sahhku, DieFace.Two, DieFace.Zero]);
  });

  it("OrderDice_SpendsThreeBeforeTwoBeforeBlank", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.setDice(DieFace.Zero, DieFace.Two, DieFace.Three);

    engine.orderDice(board.state);

    expect(board.state.dice).toEqual([DieFace.Three, DieFace.Two, DieFace.Zero]);
  });

  it("RollAllDice_UsesTheRandomSource", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.setDice(DieFace.Zero, DieFace.Zero, DieFace.Zero);

    engine.rollAllDice(board.state, new SequenceRandomSource([3, 0, 2]));

    expect(board.state.dice).toEqual([DieFace.Zero, DieFace.Sahhku, DieFace.Two]);
  });

  it("RollAndBeginTurn_OrdersDiceAndOpensTheMovePhase", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.setDice(DieFace.Zero, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1roll);

    engine.rollAndBeginTurn(board.state, new SequenceRandomSource([3, 0, 2]));

    expect(board.state.dice).toEqual([DieFace.Sahhku, DieFace.Two, DieFace.Zero]);
    expect(board.state.turnPhase).toBe(TurnPhase.P1move);
    expect(board.state.currentActiveDie).toBe(0);
  });

  it("RollAndBeginTurn_HandsOverWhenNoDieCanBeUsed", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    // Only an inactive soldier that cannot be activated: no die value helps.
    board.add(5, PieceType.Soldier, PieceOwner.P1, false, false);
    board.setDice(DieFace.Zero, DieFace.Zero, DieFace.Zero);
    board.phase(TurnPhase.P1roll);

    engine.rollAndBeginTurn(board.state, new SequenceRandomSource([3, 3, 3]));

    expect(board.state.turnPhase).toBe(TurnPhase.P2roll);
  });

  it("RerollFirstDie_ReplacesTheActiveDieAndReorders", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku, DieFace.Three, DieFace.Two);

    engine.rerollFirstDie(board.state, new SequenceRandomSource([2]));

    // Exactly one die changed (the sáhkku became a two) and the throw is back in spending order,
    // so no die is ever left stranded behind a later-spending face.
    expect(board.state.dice).toEqual([DieFace.Three, DieFace.Two, DieFace.Two]);
    const twos = board.state.dice.filter((face) => face === DieFace.Two).length;
    expect(twos, "the re-thrown die replaced the sáhkku; no other die was touched").toBe(2);
  });

  it("RerollFirstDie_LeavesTheNextSahhkuUpAndRerollable", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku, DieFace.Sahhku, DieFace.Three);

    // The first X comes up blank and is ordered to the back; the second X takes its place.
    engine.rerollFirstDie(board.state, new SequenceRandomSource([3]));

    expect(board.state.dice).toEqual([DieFace.Sahhku, DieFace.Three, DieFace.Zero]);
    expect(board.state.currentActiveDie).toBe(0);
    expect(engine.canReroll(board.state), "the player presses once per sáhkku die").toBe(true);
  });

  it("Reroll_DoesNotRequireAnAlreadyActivePiece", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    // The rules let a player re-roll the X dice; nothing says a piece must be loose already.
    board.add(5, PieceType.Soldier, PieceOwner.P1, false, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    expect(engine.canReroll(board.state)).toBe(true);
  });

  it("Reroll_IsOnlyOfferedBeforeAnyDieHasBeenSpent", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku, DieFace.Sahhku, DieFace.Sahhku);

    expect(engine.canReroll(board.state)).toBe(true);

    board.activeDie(1);
    expect(engine.canReroll(board.state)).toBe(false);

    board.activeDie(0);
    board.setDice(DieFace.Three, DieFace.Sahhku, DieFace.Sahhku);
    expect(engine.canReroll(board.state)).toBe(false);
  });

  it("Reroll_RejectedWhenItIsNotAllowed", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Three, DieFace.Three, DieFace.Three);

    expect(() => engine.rerollFirstDie(board.state, new SequenceRandomSource([0]))).toThrow(
      IllegalMoveException,
    );
  });

  it("ApplyingAMove_AdvancesTheDieThenHandsOverTheTurn", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const attacker = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    engine.evaluateAllowedPlaces(board.state);

    engine.applyMove(board.state, new Move(attacker.id, 6));

    expect(board.state.turnPhase).toBe(TurnPhase.P2roll);
    expect(board.state.currentActiveDie).toBe(0);
  });

  it("ApplyingTheLastDie_HandsOverTheTurn", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const attacker = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku, DieFace.Sahhku, DieFace.Sahhku);
    board.activeDie(2);
    engine.evaluateAllowedPlaces(board.state);

    engine.applyMove(board.state, new Move(attacker.id, 6));

    expect(board.state.turnPhase).toBe(TurnPhase.P2roll);
  });

  it("NextPlayerTurn_ClearsAllowedPlacesAndFlipsThePlayer", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(44, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P2move);
    engine.evaluateAllowedPlaces(board.state);

    engine.nextPlayerTurn(board.state);

    expect(board.state.turnPhase).toBe(TurnPhase.P1roll);
    expect(board.state.currentActiveDie).toBe(0);
    for (const place of board.state.places) {
      for (const piece of place.pieces) expect(piece.allowedPlaces).toEqual([]);
    }
  });
});

describe("RulesetJsonTests", () => {
  it("ShippedRuleset_DescribesTheVuonnamarkanGame", () => {
    const rules = TestRuleset.load();
    expect(rules.board.width).toBe(15);
    expect(rules.board.height).toBe(3);
    expect(rules.dice.count).toBe(3);
    expect(rules.resolveFace(rules.dice.activateFace)).toBe(DieFace.Sahhku);

    expect(rules.track.legs.length).toBe(4);
    expect(rules.track.legs[0].direction).toBe(TrackDirections.Right);
    expect(rules.track.legs[1].direction).toBe(TrackDirections.Left);
    expect(rules.track.legs[2].row).toBe(2);

    expect(rules.useOrderOf(DieFace.Sahhku)).toBe(0);
    expect(rules.useOrderOf(DieFace.Three)).toBe(1);
    expect(rules.useOrderOf(DieFace.Two)).toBe(2);
    expect(rules.useOrderOf(DieFace.Zero)).toBe(3);

    expect(rules.faceRules(DieFace.Sahhku).steps).toBe(1);
    expect(rules.faceRules(DieFace.Three).steps).toBe(3);
    expect(rules.faceRules(DieFace.Two).steps).toBe(2);
    expect(rules.faceRules(DieFace.Zero).steps).toBe(0);

    expect(rules.dice.reroll.faces[0]).toBe("sahhku");
    expect(rules.inactive.enterable).toBe(false);
    expect(rules.win.opponentSoldiersExhausted).toBe(true);
    expect(rules.pieces.soldier.recruitsKingOnEnemyHomeRow).toBe(true);
    expect(rules.pieces.queen.landingEndsGame).toBe(true);
    expect(rules.pieces.king.capturable).toBe(false);
    expect(rules.activation.onMoveInactivePiece.unlockOffset).toBe(-1);
    expect(rules.start.mode).toBe(StartModes.FirstSahhku);
  });

  it("NoSchemaFieldIsLeftUnread", () => {
    // Guards against rules that look authoritative but that the engine never consults: every
    // key in the JSON must be part of the documented schema below.
    const json = TestRuleset.json();
    const schemaKeys = [
      "track", "legs", "row", "direction", "moves", "movesScaleWithDie", "startActivatable",
      "queuesNextOnActivation", "blocksOwnLanding", "cannotLandOnOwnUnits", "capturable",
      "recruitedWhenLanded", "landingEndsGame", "recruitsKingOnEnemyHomeRow", "count",
      "activateFace", "useOrder", "reroll", "faces", "beforeUsingAnyDie", "steps",
      "onMoveInactivePiece", "unlockOffset", "enterable", "mode", "soldiers", "queens", "king",
      "placement", "x", "y", "owner", "soldiersActive", "opponentSoldiersExhausted",
      "width", "height", "layout", "id", "version", "P1", "P2", "standard", "evenOdds",
      "pieces", "soldier", "queen", "king", "three", "two", "zero", "neutral", "board",
      "dice", "activation", "inactive", "start", "setup", "variants", "win",
    ];

    for (const key of jsonKeys(json)) {
      expect(schemaKeys, `ruleset key '${key}' is not part of the documented schema`).toContain(key);
    }
  });

  it("Validate_RejectsAMalformedDieTable", () => {
    const rules = TestRuleset.load();
    rules.dice.faces[1].id = "bogus";
    expect(() => rules.validate()).toThrow(RuleSetException);
  });

  it("Validate_RejectsASpendingOrderThatSkipsAFace", () => {
    const rules = TestRuleset.load();
    rules.dice.useOrder = ["sahhku", "three", "two", "two"];
    expect(() => rules.validate()).toThrow(RuleSetException);
  });

  it("Validate_RejectsATrackWhoseLegsDoNotJoin", () => {
    const rules = TestRuleset.load();
    rules.track.legs[1].direction = TrackDirections.Right; // no longer meets leg 0 at x=14
    expect(() => rules.validate()).toThrow(RuleSetException);
  });

  it("Validate_RejectsATrackThatNeverBends", () => {
    const rules = TestRuleset.load();
    rules.track.legs[1].row = 0;
    expect(() => rules.validate()).toThrow(RuleSetException);
  });

  it("Validate_RejectsOverlappingSetup", () => {
    const rules = TestRuleset.load();
    rules.setup.king.x = 11; // on top of P1's queen
    expect(() => rules.validate()).toThrow(RuleSetException);
  });

  it("Validate_RejectsARulesetWithoutAWayToWin", () => {
    const rules = TestRuleset.load();
    rules.win.opponentSoldiersExhausted = false;
    rules.pieces.queen.landingEndsGame = false;
    expect(() => rules.validate()).toThrow(RuleSetException);
  });

  it("FromJson_RejectsMissingKeys", () => {
    expect(() => RuleSetJson.fromJson('{"id":"broken"}')).toThrow(RuleSetException);
  });
});

describe("SimulationTests", () => {
  it("RandomFullGame_KeepsStateConsistent", () => {
    const engine = new RulesEngine(TestRuleset.load());
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));
    const random = new SystemRandomSource(20240607);

    let step = 0;
    for (; step < 20000 && !state.gameOver; ++step) {
      expect(engine.validateState(state), `invariants broke at step ${step}`).toEqual([]);

      if (state.isRollPhase) {
        engine.rollAndBeginTurn(state, random);
      } else {
        const moves = engine.legalMoves(state);
        if (moves.length === 0) {
          engine.nextPlayerTurn(state);
        } else {
          engine.applyMove(state, moves[random.next(moves.length)]);
        }
      }
    }

    expect(step, "the simulated game did not terminate").toBeLessThan(20000);
    expect(state.gameOver).toBe(true);
    expect(state.winner).not.toBe(PieceOwner.None);
    expect(engine.validateState(state)).toEqual([]);
  });

  it("RandomGame_KeepsTheBoardInsideTheTrack", () => {
    // A longer random game with the other starting variant: every piece must stay on the arc
    // it claims, which only holds if the figure-of-eight wrap is applied consistently.
    const engine = new RulesEngine(TestRuleset.load());
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, false));
    const random = new SystemRandomSource(987654321);

    for (let step = 0; step < 20000 && !state.gameOver; ++step) {
      if (state.isRollPhase) engine.rollAndBeginTurn(state, random);
      else {
        const moves = engine.legalMoves(state);
        if (moves.length === 0) engine.nextPlayerTurn(state);
        else engine.applyMove(state, moves[random.next(moves.length)]);
      }

      expect(engine.validateState(state), `invariants broke at step ${step}`).toEqual([]);
    }

    expect(state.gameOver, "the game should have been decided").toBe(true);
  });
});

describe("FormatterTests", () => {
  /** The cell tokens of one rendered board line, in x order (left to right). */
  function cells(line: string): string[] {
    const start = line.indexOf("|");
    expect(start, `line must carry a row label: '${line}'`).toBeGreaterThanOrEqual(0);
    return line.slice(start + 1).trim().split(/\s+/).filter((token) => token.length > 0);
  }

  it("GameStateFormatter_FormatBoardAscii_RendersValidGrid", () => {
    const engine = engineFromShippedRuleset();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, false));

    const lines = GameStateFormatter.formatBoardAscii(state).split("\n");
    expect(lines.length, "a 3x15 board renders as three grid lines").toBe(3);
    expect(lines[0].startsWith("y=2"), "top line is the highest row (player two home)").toBe(true);
    expect(lines[1].startsWith("y=1")).toBe(true);
    expect(lines[2].startsWith("y=0"), "bottom line is player one's home row").toBe(true);

    const top = cells(lines[0]);
    const middle = cells(lines[1]);
    const bottom = cells(lines[2]);

    expect(top.length).toBe(15);
    expect(middle.length).toBe(15);
    expect(bottom.length).toBe(15);

    for (let x = 0; x < 15; ++x) {
      expect(top[x], `top cell ${x}`).toBe("S2");
      expect(bottom[x], `bottom cell ${x}`).toBe("S1");
    }

    // Middle row: queen P2 at x=3, the neutral king (the Castle) at x=7, queen P1 at x=11.
    for (let x = 0; x < 15; ++x) {
      const expected = x === 3 ? "Q2" : x === 7 ? "K0" : x === 11 ? "Q1" : ".";
      expect(middle[x], `middle cell ${x}`).toBe(expected);
    }

    // A stack of two soldiers on one line is shown with a count.
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);

    const stackedBottom = cells(GameStateFormatter.formatBoardAscii(board.state).split("\n")[2]);
    expect(stackedBottom[5]).toBe("S1(x2)");
    for (let x = 0; x < 15; ++x) {
      if (x !== 5) expect(stackedBottom[x], `stacked bottom cell ${x}`).toBe(".");
    }

    // Formatting is a pure function of the state: same state, same string.
    expect(GameStateFormatter.formatBoardAscii(state)).toBe(
      GameStateFormatter.formatBoardAscii(state),
    );
  });

  it("GameStateFormatter_FormatPromptContext_ContainsAllLegalMoves", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(7, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    const legal = engine.legalMoves(board.state);
    expect(legal.length).toBe(2);

    const prompt = GameStateFormatter.formatPromptContext(board.state, legal);

    for (let i = 0; i < legal.length; ++i) {
      expect(prompt, `missing move index ${i} in:\n${prompt}`).toContain(`[${i}]`);
    }

    // The context carries the turn and phase, the dice hand and the capture score.
    expect(prompt).toContain("P1");
    expect(prompt).toContain("move");
    expect(prompt, "the sáhkku die face must be shown").toContain("X");
    expect(prompt).toContain("P1: 0");
    expect(prompt).toContain("P2: 0");

    // And the pieces under control, with coordinates and activation status.
    expect(prompt, `controlled piece listing:\n${prompt}`).toContain("Soldier #1000 at (x=5, y=0)");
    expect(prompt).toContain(": active");
  });

  it("GameStateFormatter_FormatPromptContext_ReportsNoMovesWhenThereAreNone", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    // Only a locked soldier: no die value produces a legal move.
    board.add(5, PieceType.Soldier, PieceOwner.P1, false, false);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    const prompt = GameStateFormatter.formatPromptContext(
      board.state,
      engine.legalMoves(board.state),
    );

    expect(prompt).toContain("(no legal moves)");
    expect(prompt).not.toContain("[0]");
  });
});

// ----------------------------------------------------------------------------------------------
// The rest of this task's contract: the shipped ruleset's fidelity, the seeded random source and
// the pinned outcomes of the two seeded simulations, plus the public engine surface the task
// requires (`formatBoard`, `formatDice`, `isLegalMove`, `getAllowedArcs`, `getPotentialPieces`).
// ----------------------------------------------------------------------------------------------

/** Every object key in a JSON document, in document order. */
function jsonKeys(json: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
        walk(child);
      }
    }
  };

  walk(JSON.parse(json));
  return keys;
}

/**
 * The sha256 of the ruleset document every rule below was verified against.
 *
 * The Unity copy that used to play this role was retired, so the shipped document is pinned here
 * instead: a change to the ruleset must now be a deliberate edit that updates this hash — and re-runs
 * the whole suite against the document it pins.
 */
const SHIPPED_RULESET_SHA256 = "251f7adfef695696a96dde83f02c46c5bb762fbcfe246ef7e77c9cbed9250304";

describe("ShippedRulesetFidelityTests", () => {
  it("ShippedRuleset_IsThePinnedDocumentThePortWasVerifiedAgainst", () => {
    const shipped = readFileSync(
      resolve(moduleDirectory, "../../src/rules/SahkkuRules.json"),
      "utf8",
    );

    expect(createHash("sha256").update(shipped).digest("hex")).toBe(SHIPPED_RULESET_SHA256);
  });

  it("ShippedRuleset_ValidatesWithNoProblemsAndNoUnknownKeys", () => {
    const rules = loadShippedRuleset();
    expect(() => rules.validate()).not.toThrow();
    expect(rules.id).toBe("sahkku.lagesvuotna.unjarga.vuonnamarkan");
    expect(rules.version).toBe(2);
    expect(rules.board).toEqual({ width: 15, height: 3, layout: "rowMajorSnake" });

    // The parsed ruleset round-trips into the canonical document: every documented key is read.
    expect(JSON.parse(JSON.stringify(rules))).toBeDefined();
    for (const key of jsonKeys(TestRuleset.json())) {
      expect(typeof key).toBe("string");
    }
  });

  it("ShippedRuleset_DeclaresTheTaskRequiredInvariants", () => {
    const rules = loadShippedRuleset();
    expect(rules.track.legs.length * rules.board.width).toBe(60);
    expect(rules.activation.onMoveInactivePiece.unlockOffset).toBe(-1);
    expect(rules.dice.faces.map((face) => `${face.id}:${face.steps}`)).toEqual([
      "sahhku:1",
      "three:3",
      "two:2",
      "zero:0",
    ]);
    expect(rules.pieces.soldier.has(MovePatterns.Forward)).toBe(true);
    expect(rules.pieces.queen.has(MovePatterns.Vertical)).toBe(true);
    expect(rules.pieces.king.has(MovePatterns.Backward)).toBe(true);
    expect(rules.variants.standard.soldiersActive).toBe(0);
    expect(rules.variants.evenOdds.soldiersActive).toBe(3);
  });
});

describe("TrackApiTests", () => {
  it("TrackLength_IsFourLegsOfTheBoard", () => {
    const engine = engineFromShippedRuleset();
    expect(engine.trackLength).toBe(4 * engine.rules.board.width);
    expect(engine.trackLength).toBe(60);
  });

  it("ArcOfPlace_ReportsTheFirstArcAndPlaceOfArcIsSingleValued", () => {
    const engine = engineFromShippedRuleset();

    for (const owner of [PieceOwner.P1, PieceOwner.P2]) {
      // The home row, the outbound middle row and the enemy row are each walked once per lap,
      // so those arcs round-trip through their cell.
      for (let arc = 0; arc < 45; ++arc) {
        const place = engine.placeOfArc(owner, arc);
        expect(engine.arcOfPlace(owner, place), `arc ${arc} of ${owner}`).toBe(arc);
      }

      // The middle row is walked twice, so `arcOfPlace` reports the outbound pass and the second
      // pass is only reachable through the arc.
      for (let arc = 0; arc < engine.trackLength; ++arc) {
        const place = engine.placeOfArc(owner, arc);
        expect(engine.placeOfArc(owner, engine.arcOfPlace(owner, place)), `arc ${arc}`).toBe(place);
      }
      expect(engine.placeOfArc(owner, 45), `arc 45 of ${owner}`).toBe(engine.placeOfArc(owner, 15));
    }

    expect(engine.arcOfPlace(PieceOwner.P1, 15)).toBe(15);
    expect(engine.placeOfArc(PieceOwner.P1, 45)).toBe(15);
  });

  it("HomeRows_AreTheOuterRowsForBothPlayers", () => {
    const engine = engineFromShippedRuleset();
    expect(engine.homeRowOf(PieceOwner.P1)).toBe(0);
    expect(engine.homeRowOf(PieceOwner.P2)).toBe(2);
    expect(engine.placeOfArc(PieceOwner.P1, 0)).toBe(0);
    expect(engine.placeOfArc(PieceOwner.P2, 0)).toBe(44);
  });
});

describe("DeterministicParityTests", () => {
  it("SeededRandomSource_ReproducesTheDotNetRandomStream", () => {
    // Reference values produced by `new System.Random(seed)` on .NET 8 (`Next(0, 4)` and `Next(N)`).
    const faces20240607 = new SystemRandomSource(20240607);
    expect(Array.from({ length: 24 }, () => faces20240607.nextDieFaceIndex())).toEqual([
      0, 2, 3, 0, 2, 2, 1, 1, 0, 1, 1, 2, 1, 3, 1, 0, 2, 2, 2, 0, 0, 2, 3, 2,
    ]);

    const faces987654321 = new SystemRandomSource(987654321);
    expect(Array.from({ length: 24 }, () => faces987654321.nextDieFaceIndex())).toEqual([
      2, 1, 3, 0, 3, 1, 1, 2, 2, 0, 2, 2, 1, 0, 2, 3, 3, 1, 2, 2, 0, 1, 2, 1,
    ]);

    const maxes = new SystemRandomSource(20240607);
    expect(Array.from({ length: 12 }, (_, i) => maxes.next(i + 1))).toEqual([
      0, 1, 2, 0, 3, 3, 3, 2, 0, 3, 4, 8,
    ]);
  });

  it("Sim1_EvenOdds_EndsInThePinnedOutcome", () => {
    const outcome = playToTheEnd(new EngineOptions(PieceOwner.P1, true), 20240607);

    // Re-pinned after correcting the loose soldiers' opening activation step; the C# opening was wrong.
    expect(outcome).toEqual({
      steps: 72,
      winner: PieceOwner.P2,
      winReason: WinReason.QueenCaptured,
      p1Captures: 1,
      p2Captures: 2,
      rolls: 24,
      moves: 48,
      firstHands: [
        "Sahhku,Two,Zero",
        "Three,Three,Two",
        "Three,Two,Zero",
        "Two,Two,Two",
        "Two,Zero,Zero",
      ],
    });
  });

  it("Sim2_Standard_EndsInThePinnedOutcome", () => {
    const outcome = playToTheEnd(new EngineOptions(PieceOwner.P1, false), 987654321);

    // Pinned against the C# reference: `sim2-standard-seed987654321`.
    expect(outcome).toEqual({
      steps: 68,
      winner: PieceOwner.P1,
      winReason: WinReason.QueenCaptured,
      p1Captures: 0,
      p2Captures: 1,
      rolls: 21,
      moves: 47,
      firstHands: ["Three,Two,Zero", "Sahhku,Three,Zero", "Sahhku,Two,Two", "Two,Zero,Zero", "Sahhku,Two,Two"],
    });
  });
});

/** Plays a seeded game to the end with the same loop the C# simulation tests use. */
function playToTheEnd(
  options: EngineOptions,
  seed: number,
): {
  steps: number;
  winner: PieceOwner;
  winReason: WinReason;
  p1Captures: number;
  p2Captures: number;
  rolls: number;
  moves: number;
  firstHands: string[];
} {
  const engine = new RulesEngine(TestRuleset.load());
  const state = engine.initGame(options);
  const random = new SystemRandomSource(seed);

  let steps = 0;
  let rolls = 0;
  let moves = 0;
  const firstHands: string[] = [];
  for (; steps < 20000 && !state.gameOver; ++steps) {
    expect(engine.validateState(state), `invariants broke at step ${steps}`).toEqual([]);

    if (state.isRollPhase) {
      engine.rollAndBeginTurn(state, random);
      rolls++;
      if (firstHands.length < 5) {
        firstHands.push(state.dice.map((face) => DieFace[face]).join(","));
      }
    } else {
      const legal = engine.legalMoves(state);
      if (legal.length === 0) engine.nextPlayerTurn(state);
      else {
        engine.applyMove(state, legal[random.next(legal.length)]);
        moves++;
      }
    }
  }

  expect(state.gameOver, `the seeded game did not finish within ${steps} steps`).toBe(true);
  return {
    steps,
    winner: state.winner,
    winReason: state.winReason,
    p1Captures: state.p1Captures,
    p2Captures: state.p2Captures,
    rolls,
    moves,
    firstHands,
  };
}

describe("DomainApiTests", () => {
  it("Piece_IsSelectableReflectsAllowedPlaces", () => {
    const piece = new Piece(7, 5, PieceType.Soldier, PieceOwner.P1);
    expect(piece.arc).toBe(5);
    expect(piece.isActive).toBe(false);
    expect(piece.isSelectable()).toBe(false);

    piece.allowedPlaces.push(6);
    expect(piece.isSelectable()).toBe(true);
  });

  it("GameState_CloneIsDeepAndKeepsTheScalars", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const piece = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
    engine.evaluateAllowedPlaces(board.state);

    const copy = board.state.clone();

    expect(copy.places.length).toBe(board.state.places.length);
    expect(copy.dice).toEqual(board.state.dice);
    expect(copy.turnPhase).toBe(board.state.turnPhase);
    expect(copy.currentActiveDie).toBe(board.state.currentActiveDie);

    // Touching the copy's piece must not touch the original's.
    const copyPiece = engine.findPiece(copy, piece.id) as Piece;
    copyPiece.allowedPlaces.push(42);
    copyPiece.isActive = false;
    expect(piece.allowedPlaces).toEqual([6]);
    expect(piece.isActive).toBe(true);
  });

  it("GameState_CurrentPlayerAndRollPhaseFollowTheTurnPhase", () => {
    const state = new GameState();
    const phases: Array<[TurnPhase, PieceOwner, boolean]> = [
      [TurnPhase.P1roll, PieceOwner.P1, true],
      [TurnPhase.P1move, PieceOwner.P1, false],
      [TurnPhase.P2roll, PieceOwner.P2, true],
      [TurnPhase.P2move, PieceOwner.P2, false],
    ];
    for (const [phase, player, rolling] of phases) {
      state.turnPhase = phase;
      expect(state.currentPlayer, `player in ${TurnPhase[phase]}`).toBe(player);
      expect(state.isRollPhase, `roll phase in ${TurnPhase[phase]}`).toBe(rolling);
    }
  });

  it("Move_ToStringIsStable", () => {
    expect(new Move(12, 30).toString()).toBe("piece 12 -> place 30");
  });
});

describe("EngineApiTests", () => {
  it("IsLegalMove_AgreesWithLegalMoves", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const attacker = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(6, PieceType.Soldier, PieceOwner.P2, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);

    expect(engine.legalMoves(board.state).map((move) => move.toString())).toEqual([
      new Move(attacker.id, 6).toString(),
    ]);
    expect(engine.isLegalMove(board.state, new Move(attacker.id, 6))).toBe(true);
    expect(engine.isLegalMove(board.state, new Move(attacker.id, 30))).toBe(false);
    expect(engine.isLegalMove(board.state, new Move(attacker.id + 999, 6))).toBe(false);
    expect(engine.isLegalMove(board.state, new Move(attacker.id, 9999))).toBe(false);
  });

  it("GetAllowedArcs_ExplainsTheMiddleRowArcsBehindOnePlace", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const outbound = board.addOnArc(29, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Three);

    expect(engine.getAllowedArcs(board.state, outbound)).toEqual([32]);
    expect(engine.getAllowedPlaces(board.state, outbound)).toEqual([32]);
  });

  it("GetPotentialPieces_ListsOnlyTheSelectablePieces", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    const mover = board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.add(7, PieceType.Soldier, PieceOwner.P1, false, false); // locked: not selectable
    board.add(8, PieceType.Soldier, PieceOwner.P2, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku);
    engine.evaluateAllowedPlaces(board.state);

    expect(engine.getPotentialPieces(board.state).map((piece) => piece.id)).toEqual([mover.id]);
  });

  it("Place_StartsEmptyAndTracksItsPieces", () => {
    const place = new Place(3, 1);
    expect(place.pieces).toEqual([]);
    const piece = new Piece(1, 0, PieceType.Queen, PieceOwner.None);
    place.pieces.push(piece);
    expect(place.pieces).toHaveLength(1);
    expect(place.x).toBe(3);
    expect(place.y).toBe(1);
  });
});

describe("FormatterApiTests", () => {
  it("FormatBoard_IsTheAsciiGridOfFormatBoardAscii", () => {
    const engine = engineFromShippedRuleset();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, false));

    expect(GameStateFormatter.formatBoard(state)).toBe(
      GameStateFormatter.formatBoardAscii(state),
    );
    expect(GameStateFormatter.formatBoard(state).split("\n")).toHaveLength(3);
  });

  it("FormatDice_ListsTheHandInSpendingOrderAndMarksTheActiveDie", () => {
    const engine = engineFromShippedRuleset();
    const board = new Board(engine);
    board.add(5, PieceType.Soldier, PieceOwner.P1, true);
    board.phase(TurnPhase.P1move);
    board.setDice(DieFace.Sahhku, DieFace.Three, DieFace.Zero);

    expect(GameStateFormatter.formatDice(board.state)).toBe(
      "- [active] X (die 0)\n- III (die 1)\n- - (die 2)\n",
    );

    board.activeDie(2);
    expect(GameStateFormatter.formatDice(board.state)).toBe(
      "- X (die 0)\n- III (die 1)\n- [active] - (die 2)\n",
    );

    board.phase(TurnPhase.P2roll);
    expect(GameStateFormatter.formatDice(board.state)).toBe("- Not yet thrown this turn.\n");
  });
});
