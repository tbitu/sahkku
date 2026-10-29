/**
 * Unit tests for the interactive match controller.
 *
 * The controller is the whole interaction model of the 2D client — roll, re-roll decision, piece
 * selection, destination highlighting, move committing, turn hand-over and game over — and it is
 * deliberately DOM-free, so the entire model is verified here headlessly while the browser layer only
 * paints the view model it is handed.
 *
 * Two properties are asserted over and over: **legal actions come from the engine** (`allowedPlaces`,
 * `legalMoves`) and **nothing the UI can do commits an illegal move**.
 *
 * The scripted random source makes every throw deterministic. For the shipped ruleset the die-face
 * table (`dice.faces`) is declared in exactly the `DieFace` enum's order, so a scripted index *is* the
 * `DieFace` value it selects — a script of `[DieFace.Three, DieFace.Zero, DieFace.Zero]` throws a
 * three and two blanks.
 */

import { describe, expect, it } from "vitest";

import {
  DieFace,
  EngineOptions,
  Move,
  PieceOwner,
  PieceType,
  RuleEventKind,
  TurnPhase,
  WinReason,
  type IRandomSource,
  type Piece,
} from "../../src/rules/domain";
import type { RulesEngine } from "../../src/rules/engine";
import { BoardLayout } from "../../src/rules/track";
import { boardGeometry } from "../../src/ui/board";
import { WebMatchController } from "../../src/ui/controller";
import { Board, testEngine } from "../helpers/board";

// ---------------------------------------------------------------------------------- test doubles

describe("explicit match start", () => {
  it("keeps the preview inert until a fresh match is started", () => {
    const engine = testEngine();
    const controller = new WebMatchController(
      engine, new ScriptedRandomSource([DieFace.Three, DieFace.Three, DieFace.Three]),
      new EngineOptions(PieceOwner.P1, true), undefined, { started: false },
    );
    const before = JSON.stringify(controller.state);
    expect(controller.viewModel.phase).toBe("setup");
    expect(controller.viewModel.statusText).toContain("Start game");
    expect(controller.canRoll).toBe(false);
    expect(controller.canHumanAct).toBe(false);
    expect(controller.viewModel.dice.canRoll).toBe(false);
    expect(controller.viewModel.selectablePieceIds).toEqual([]);
    expect(controller.roll()).toBe(false);
    expect(controller.rollAutomated()).toBe(false);
    expect(controller.keepDice()).toBe(false);
    expect(controller.handlePlaceClick(14)).toBe(false);
    expect(JSON.stringify(controller.state)).toBe(before);

    controller.restart();
    expect(controller.viewModel.phase).toBe("roll");
    expect(controller.roll()).toBe(true);
  });
});

/** A die source that returns a fixed sequence of face indices and refuses to invent more. */
class ScriptedRandomSource implements IRandomSource {
  private readonly sequence: number[];
  private index = 0;

  constructor(sequence: readonly number[]) {
    this.sequence = [...sequence];
  }

  nextDieFaceIndex(): number {
    const value = this.sequence[this.index];
    if (value === undefined) {
      throw new Error("The scripted random source ran out of die faces.");
    }
    this.index++;
    return value;
  }
}

/** A controller seated on the shipped ruleset's even-odds setup — the game's normal start position. */
function evenOddsController(faces: readonly number[]): {
  controller: WebMatchController;
  engine: RulesEngine;
} {
  const engine = testEngine();
  const random = new ScriptedRandomSource(faces);
  const controller = new WebMatchController(
    engine,
    random,
    new EngineOptions(PieceOwner.P1, true),
  );
  return { controller, engine };
}

/** A controller seated on the fully-queued (standard) setup: no soldier is loose at the start. */
function standardController(faces: readonly number[]): WebMatchController {
  const engine = testEngine();
  return new WebMatchController(
    engine,
    new ScriptedRandomSource(faces),
    new EngineOptions(PieceOwner.P1, false),
  );
}

/** A controller seated on a hand-built position, so a scenario can be set up exactly. */
function controllerOn(
  engine: RulesEngine,
  build: (board: Board) => void,
  faces: readonly number[] = [],
): { controller: WebMatchController; board: Board } {
  const board = new Board(engine, PieceOwner.P1);
  build(board);
  const controller = new WebMatchController(
    engine,
    new ScriptedRandomSource(faces),
    new EngineOptions(PieceOwner.P1, false),
    board.state,
  );
  return { controller, board };
}

/** Every piece on the board with the cell it stands on. */
function locatedPieces(controller: WebMatchController): Array<{ piece: Piece; placeIndex: number }> {
  return controller.state.places.flatMap((place, placeIndex) =>
    place.pieces.map((piece) => ({ piece, placeIndex })),
  );
}

// ---------------------------------------------------------------------------------- board geometry

describe("board geometry (derived from the ruleset, never hardcoded)", () => {
  it("derives the grid, the home rows and the carved cells from the ruleset", () => {
    const engine = testEngine();
    const rules = engine.rules;
    const geometry = boardGeometry(rules);

    expect(geometry.width).toBe(rules.board.width);
    expect(geometry.height).toBe(rules.board.height);
    expect(geometry.rowLabels).toHaveLength(geometry.height);

    // Whose home row is whose comes from the soldier setup, not from a fixed constant.
    expect(geometry.rowLabels[rules.setup.soldiers.P1.row]).toContain("Women");
    expect(geometry.rowLabels[rules.setup.soldiers.P2.row]).toContain("Men");
    expect(geometry.rowLabels[rules.setup.king.row]).toBe("Shared middle row");

    // Both home rows and the shared row they cross are told apart for styling.
    expect(geometry.rowKind[rules.setup.soldiers.P1.row]).toBe("home");
    expect(geometry.rowKind[rules.setup.soldiers.P2.row]).toBe("home");
    expect(geometry.rowKind[rules.setup.king.row]).toBe("middle");
    expect(geometry.rowKind.filter((kind) => kind === "home")).toHaveLength(2);

    const carvingKinds = (x: number, y: number): string[] => {
      const place = BoardLayout.indexFromCoordinates(geometry.width, geometry.height, x, y);
      return (geometry.decorations.get(place) ?? []).map((carving) => carving.kind);
    };

    // The sacred seated pieces carry their own carving...
    expect(carvingKinds(rules.setup.king.x, rules.setup.king.row)).toContain("king");
    expect(carvingKinds(rules.setup.queens.P1.x, rules.setup.queens.P1.row)).toContain("queen");
    expect(carvingKinds(rules.setup.queens.P2.x, rules.setup.queens.P2.row)).toContain("queen");

    // ...and so do the end columns, where the figure-of-eight track turns on every row.
    for (let y = 0; y < geometry.height; ++y) {
      expect(carvingKinds(0, y)).toContain("turning");
      expect(carvingKinds(geometry.width - 1, y)).toContain("turning");
    }
  });
});

// ---------------------------------------------------------------------------------- roll phase

describe("WebMatchController: throw and move phases", () => {
  it("starts in player one's roll phase with the dice still to be thrown", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    const view = controller.viewModel;

    expect(view.phase).toBe("roll");
    expect(view.currentPlayer).toBe(PieceOwner.P1);
    expect(view.dice.rolled).toBe(false);
    expect(view.dice.canRoll).toBe(true);
    expect(view.dice.canReroll).toBe(false);
    expect(view.dice.dice).toHaveLength(3);
    expect(view.gameOver).toBeNull();
  });

  it("derives the board grid from the ruleset rather than hardcoding it", () => {
    const { controller, engine } = evenOddsController([]);
    const view = controller.viewModel;

    expect(view.boardWidth).toBe(engine.rules.board.width);
    expect(view.boardHeight).toBe(engine.rules.board.height);
    expect(view.cells).toHaveLength(view.boardWidth * view.boardHeight);

    // Cells carry their real board coordinates, not their grid slot.
    for (const cell of view.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThan(view.boardWidth);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeLessThan(view.boardHeight);
    }
  });

  it("throws the dice into the ruleset's spending order and opens the move phase", () => {
    const { controller } = evenOddsController([DieFace.Zero, DieFace.Three, DieFace.Zero]);

    expect(controller.roll()).toBe(true);

    const view = controller.viewModel;
    expect(view.phase).toBe("move");
    expect(view.dice.rolled).toBe(true);
    expect(view.dice.canRoll).toBe(false);
    expect(view.dice.canReroll).toBe(false);
    expect(view.dice.dice.map((die) => die.face)).toEqual([
      DieFace.Three,
      DieFace.Zero,
      DieFace.Zero,
    ]);
    expect(view.dice.dice.map((die) => die.active)).toEqual([true, false, false]);
    expect(view.dice.dice.map((die) => die.spent)).toEqual([false, false, false]);
    expect(view.dice.orderText).toBe("Spending die 1 of 3.");
    expect(view.statusText.length).toBeGreaterThan(0);
  });

  it("hands the turn over when the throw leaves the player with no legal move", () => {
    // The standard setup keeps every soldier seated and only a sáhkku can activate one, so a three
    // is unplayable and the ruleset forbids skipping it: the turn must pass on.
    const controller = standardController([DieFace.Three, DieFace.Zero, DieFace.Zero]);

    expect(controller.roll()).toBe(true);

    const view = controller.viewModel;
    expect(view.currentPlayer).toBe(PieceOwner.P2);
    expect(view.phase).toBe("roll");
    expect(view.dice.rolled).toBe(false);
    expect(view.dice.canRoll).toBe(true);
  });

  it("ignores clicks and selection while the dice have not been thrown", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    const anyPiece = locatedPieces(controller)[0]!.piece;

    expect(controller.selectPiece(anyPiece.id)).toBe(false);
    expect(controller.handlePlaceClick(anyPiece.placeIndex)).toBe(false);
    expect(controller.commitMove(new Move(anyPiece.id, anyPiece.placeIndex))).toBe(false);
    expect(controller.viewModel.selectedPieceId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------- selection

describe("WebMatchController: piece selection and highlighting", () => {
  it.each([PieceType.King, PieceType.Soldier])("moves shared piece type %i after cycling without spending dice", (movingType) => {
    const engine = testEngine();
    const { controller, board } = controllerOn(engine, (position) => {
      position.add(22, PieceType.King, PieceOwner.P2, true);
      position.add(19, PieceType.Soldier, PieceOwner.P1, true);
      position.add(40, PieceType.Soldier, PieceOwner.P2, true);
      position.setDice(DieFace.Three, DieFace.Three, DieFace.Three);
      position.phase(TurnPhase.P1move);
    });
    const soldier = board.state.places[19].pieces[0];
    expect(controller.selectPiece(soldier.id)).toBe(true);
    expect(controller.handlePlaceClick(22)).toBe(true);
    const king = board.state.places[22].pieces[0];
    expect(king.type).toBe(PieceType.King);
    expect(king.owner).toBe(PieceOwner.P1);
    const before = JSON.stringify(controller.state);

    for (const piece of [king, soldier, king, soldier]) {
      expect(controller.handlePlaceClick(22)).toBe(true);
      expect(controller.viewModel.selectedPieceId).toBe(piece.id);
      expect(controller.viewModel.highlightedPlaces).toEqual(piece.allowedPlaces);
      expect(JSON.stringify(controller.state)).toBe(before);
    }
    if (movingType === PieceType.King) controller.handlePlaceClick(22);
    const moving = movingType === PieceType.King ? king : soldier;
    const remaining = movingType === PieceType.King ? soldier : king;
    expect(controller.viewModel.selectedPieceId).toBe(moving.id);
    const target = controller.viewModel.highlightedPlaces[0]!;
    expect(controller.handlePlaceClick(target)).toBe(true);
    expect(board.state.places[22].pieces).toEqual([remaining]);
    expect(moving.placeIndex).toBe(target);
    expect(board.state.currentActiveDie).toBe(2);
  });

  it("cycles ordinary soldier stacks and wraps to the first piece", () => {
    const engine = testEngine();
    const { controller, board } = controllerOn(engine, (position) => {
      position.add(19, PieceType.Soldier, PieceOwner.P1, true);
      position.add(19, PieceType.Soldier, PieceOwner.P1, true);
      position.add(40, PieceType.Soldier, PieceOwner.P2, true);
      position.setDice(DieFace.Three, DieFace.Three, DieFace.Three);
      position.phase(TurnPhase.P1move);
    });
    const [first, second] = board.state.places[19].pieces;
    for (const piece of [first, second, first]) {
      expect(controller.handlePlaceClick(19)).toBe(true);
      expect(controller.viewModel.selectedPieceId).toBe(piece.id);
    }
    expect(board.state.currentActiveDie).toBe(0);
  });

  it("skips a blocked soldier when only the shared king can move", () => {
    const engine = testEngine();
    const { controller, board } = controllerOn(engine, (position) => {
      position.add(19, PieceType.King, PieceOwner.P1, true);
      position.add(19, PieceType.Soldier, PieceOwner.P1, true);
      position.add(22, PieceType.Soldier, PieceOwner.P2);
      position.setDice(DieFace.Three, DieFace.Three, DieFace.Three);
      position.phase(TurnPhase.P1move);
    });
    const [king, soldier] = board.state.places[19].pieces;
    expect(soldier.allowedPlaces).toEqual([]);
    for (let click = 0; click < 3; click++) {
      expect(controller.handlePlaceClick(19)).toBe(true);
      expect(controller.viewModel.selectedPieceId).toBe(king.id);
    }
    expect(board.state.currentActiveDie).toBe(0);
  });

  it("selects the soldier when the king sharing its cell is blocked", () => {
    const engine = testEngine();
    const { controller, board } = controllerOn(engine, (position) => {
      position.add(22, PieceType.King, PieceOwner.P1, true);
      position.add(22, PieceType.Soldier, PieceOwner.P1, true);
      position.add(25, PieceType.Soldier, PieceOwner.P1, true);
      position.add(19, PieceType.Soldier, PieceOwner.P1);
      position.add(40, PieceType.Soldier, PieceOwner.P2, true);
      position.setDice(DieFace.Three, DieFace.Three, DieFace.Three);
      position.phase(TurnPhase.P1move);
    });
    const [king, soldier] = board.state.places[22].pieces;
    expect(king.allowedPlaces).toEqual([]);
    expect(controller.handlePlaceClick(22)).toBe(true);
    expect(controller.viewModel.selectedPieceId).toBe(soldier.id);
    expect(controller.handlePlaceClick(25)).toBe(true);
    expect(board.state.places[22].pieces).toEqual([king]);
    expect(soldier.placeIndex).toBe(25);
  });

  it("marks every mobile piece of the player to move as selectable", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();

    const view = controller.viewModel;
    expect(view.selectablePieceIds.length).toBeGreaterThan(0);

    for (const { piece } of locatedPieces(controller)) {
      const selectable = view.selectablePieceIds.includes(piece.id);
      if (selectable) {
        expect(piece.owner).toBe(PieceOwner.P1);
        expect(piece.allowedPlaces.length).toBeGreaterThan(0);
      }
    }
  });

  it("highlights every legal destination of the selected piece (T3_SELECT_HIGHLIGHT)", () => {
    const { controller, engine } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();

    const pieceId = controller.viewModel.selectablePieceIds[0]!;
    expect(controller.selectPiece(pieceId)).toBe(true);

    const view = controller.viewModel;
    expect(view.selectedPieceId).toBe(pieceId);
    expect(view.highlightedPlaces.length).toBeGreaterThan(0);

    // The highlights are exactly the engine's legal destinations, and the board agrees with them.
    const piece = locatedPieces(controller).find((entry) => entry.piece.id === pieceId)!.piece;
    expect([...view.highlightedPlaces].sort()).toEqual([...engine.getAllowedPlaces(controller.state, piece)].sort());

    const highlightedCells = view.cells.filter((cell) => cell.highlight);
    expect(highlightedCells.map((cell) => cell.placeIndex).sort()).toEqual(
      [...view.highlightedPlaces].sort(),
    );
    expect(view.cells.find((cell) => cell.placeIndex === piece.placeIndex)?.pieces.some((token) => token.selected)).toBe(true);
  });

  it("exposes exactly the engine's legal moves for the player to move", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();

    const pieceId = controller.viewModel.selectablePieceIds[0]!;
    controller.selectPiece(pieceId);

    const destinations = controller.legalMoves
      .filter((move) => move.pieceId === pieceId)
      .map((move) => move.targetPlaceIndex);
    expect(destinations.length).toBeGreaterThan(0);
    expect([...destinations].sort()).toEqual([...controller.viewModel.highlightedPlaces].sort());

    for (const move of controller.legalMoves) {
      expect(controller.state.places[move.targetPlaceIndex]).toBeDefined();
    }
  });

  it("refuses to select a piece that is not the player to move's", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();

    const opponent = locatedPieces(controller).find(
      (entry) => entry.piece.owner === PieceOwner.P2,
    )!.piece;
    expect(controller.selectPiece(opponent.id)).toBe(false);
    expect(controller.viewModel.selectedPieceId).toBeNull();
  });

  it("shifts the selection when another selectable piece is clicked", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();

    const selectable = controller.viewModel.selectablePieceIds;
    expect(selectable.length).toBeGreaterThan(1);

    const first = selectable[0]!;
    expect(controller.selectPiece(first)).toBe(true);
    const destinations = new Set(controller.viewModel.highlightedPlaces);

    // Pick a second selectable piece standing somewhere that is not one of the first one's targets,
    // so the click shifts the selection instead of committing a move.
    const second = selectable.find((id) => {
      const located = locatedPieces(controller).find((entry) => entry.piece.id === id)!;
      return id !== first && !destinations.has(located.placeIndex);
    })!;
    const secondCell = locatedPieces(controller).find((entry) => entry.piece.id === second)!.placeIndex;

    expect(controller.handlePlaceClick(secondCell)).toBe(true);
    expect(controller.viewModel.selectedPieceId).toBe(second);
  });

  it("cancels the selection when a harmless cell is clicked, without touching the board", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();

    const pieceId = controller.viewModel.selectablePieceIds[0]!;
    controller.selectPiece(pieceId);

    const view = controller.viewModel;
    const destinations = new Set(view.highlightedPlaces);
    const occupancy = view.cells.map((cell) => cell.pieces.length);
    const emptyCell = view.cells.find(
      (cell) => cell.pieces.length === 0 && !destinations.has(cell.placeIndex),
    )!;

    expect(controller.handlePlaceClick(emptyCell.placeIndex)).toBe(true);
    expect(controller.viewModel.selectedPieceId).toBeNull();
    expect(controller.viewModel.highlightedPlaces).toEqual([]);
    expect(controller.viewModel.cells.map((cell) => cell.pieces.length)).toEqual(occupancy);
  });

  it("reports every piece of a stack so the board can badge the count", () => {
    const engine = testEngine();
    const { controller } = controllerOn(engine, (board) => {
      board.addOnArc(4, PieceType.Soldier, PieceOwner.P1, true);
      board.addOnArc(4, PieceType.Soldier, PieceOwner.P1, true);
      board.setDice(DieFace.Two);
      board.phase(TurnPhase.P1move);
    });

    const stacked = controller.viewModel.cells.find((cell) => cell.pieces.length > 1);
    expect(stacked).toBeDefined();
    expect(stacked!.pieces).toHaveLength(2);
    expect(stacked!.pieces.every((token) => token.owner === PieceOwner.P1)).toBe(true);
  });});

// ---------------------------------------------------------------------------------- moving

describe("WebMatchController: committing moves (T3_MOVE_APPLICATION)", () => {
  it("applies the move when a highlighted destination cell is clicked", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();

    const pieceId = controller.viewModel.selectablePieceIds[0]!;
    controller.selectPiece(pieceId);

    const before = locatedPieces(controller).find((entry) => entry.piece.id === pieceId)!;
    const destination = controller.viewModel.highlightedPlaces[0]!;

    expect(controller.handlePlaceClick(destination)).toBe(true);

    const after = locatedPieces(controller).find((entry) => entry.piece.id === pieceId)!;
    expect(after.placeIndex).toBe(destination);
    expect(after.placeIndex).not.toBe(before.placeIndex);
    expect(after.piece.isActive).toBe(true);
    expect(controller.state.places[before.placeIndex]!.pieces.some((p) => p.id === pieceId)).toBe(false);
    expect(controller.viewModel.selectedPieceId).toBeNull();
    expect(controller.viewModel.highlightedPlaces).toEqual([]);
    expect(controller.viewModel.events.map((event) => event.kind)).toContain(RuleEventKind.PieceMoved);
  });

  it("advances the spending-order indicator after each spent die", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();
    expect(controller.viewModel.dice.currentActiveDie).toBe(0);

    const pieceId = controller.viewModel.selectablePieceIds[0]!;
    controller.selectPiece(pieceId);
    expect(controller.handlePlaceClick(controller.viewModel.highlightedPlaces[0]!)).toBe(true);

    const view = controller.viewModel;
    expect(view.phase).toBe("move");
    expect(view.dice.currentActiveDie).toBe(1);
    expect(view.dice.dice.map((die) => die.active)).toEqual([false, true, false]);
    expect(view.dice.dice.map((die) => die.spent)).toEqual([true, false, false]);
    expect(view.dice.orderText).toBe("Spending die 2 of 3.");
  });

  it("never commits a move the engine has not confirmed legal", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    controller.roll();

    const pieceId = controller.viewModel.selectablePieceIds[0]!;
    expect(controller.selectPiece(pieceId)).toBe(true);
    expect(controller.viewModel.highlightedPlaces).not.toContain(0);
    expect(controller.viewModel.highlightedPlaces.length).toBeGreaterThan(0);

    const occupancy = controller.viewModel.cells.map((cell) => cell.pieces.length);
    expect(controller.commitMove(new Move(pieceId, 0))).toBe(false);
    expect(controller.viewModel.cells.map((cell) => cell.pieces.length)).toEqual(occupancy);
    expect(controller.state.currentActiveDie).toBe(0);
  });
});

// ---------------------------------------------------------------------------------- reroll

describe("WebMatchController: the re-roll decision", () => {
  it("offers the re-roll while a re-rollable face is showing before any die has been spent", () => {
    const { controller, engine } = evenOddsController([DieFace.Sahhku, DieFace.Zero, DieFace.Zero]);

    controller.roll();

    const view = controller.viewModel;
    expect(view.dice.rolled).toBe(true);
    expect(view.dice.canReroll).toBe(true);
    expect(view.dice.dice[0]!.face).toBe(DieFace.Sahhku);
    expect(view.dice.dice[0]!.active).toBe(true);
    expect(view.dice.canRoll).toBe(false);

    // The hint names the face the ruleset allows to be re-thrown rather than a fixed one.
    expect(view.statusText).toContain(engine.rules.dice.reroll.faces[0]!);
  });

  it("re-throws the active die and closes the decision when the new face is not re-rollable", () => {
    const { controller } = evenOddsController([
      DieFace.Sahhku,
      DieFace.Zero,
      DieFace.Zero,
      DieFace.Three,
    ]);
    controller.roll();
    expect(controller.viewModel.dice.canReroll).toBe(true);

    expect(controller.rerollActiveDie()).toBe(true);

    const view = controller.viewModel;
    expect(view.dice.canReroll).toBe(false);
    expect(view.dice.dice.map((die) => die.face)).toEqual([
      DieFace.Three,
      DieFace.Zero,
      DieFace.Zero,
    ]);
    expect(view.dice.dice[0]!.active).toBe(true);
    expect(view.selectablePieceIds.length).toBeGreaterThan(0);
  });

  it("keeps the dice and opens the moves when the player answers keep", () => {
    const { controller } = evenOddsController([DieFace.Sahhku, DieFace.Three, DieFace.Zero]);
    controller.roll();
    expect(controller.viewModel.dice.canReroll).toBe(true);

    expect(controller.keepDice()).toBe(true);

    const view = controller.viewModel;
    expect(view.dice.canReroll).toBe(false);
    expect(view.dice.dice.map((die) => die.face)).toEqual([
      DieFace.Sahhku,
      DieFace.Three,
      DieFace.Zero,
    ]);
    expect(view.selectablePieceIds.length).toBeGreaterThan(0);
  });

  it("refuses to re-throw a die the ruleset has closed", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Zero, DieFace.Zero]);
    controller.roll();
    expect(controller.viewModel.dice.canReroll).toBe(false);

    expect(controller.rerollActiveDie()).toBe(false);
    expect(controller.viewModel.dice.dice.map((die) => die.face)).toEqual([
      DieFace.Three,
      DieFace.Zero,
      DieFace.Zero,
    ]);
  });

  it("ignores a re-roll answer outside the move phase", () => {
    const { controller } = evenOddsController([DieFace.Sahhku, DieFace.Three, DieFace.Zero]);

    expect(controller.keepDice()).toBe(false);
    expect(controller.rerollActiveDie()).toBe(false);
    expect(controller.viewModel.dice.rolled).toBe(false);
  });
});

// ---------------------------------------------------------------------------------- game over

describe("WebMatchController: rule events and game over", () => {
  it("reports the capture, the win and the modal payload when the last enemy soldier falls", () => {
    const engine = testEngine();
    // A huntsman three steps short of player two's only active soldier: the three captures it and
    // exhausts player two's soldiers, which is a win.
    const { controller, board } = controllerOn(engine, (position) => {
      position.addOnArc(37, PieceType.Soldier, PieceOwner.P1, true);
      position.addOnArc(4, PieceType.Soldier, PieceOwner.P2, true);
      position.setDice(DieFace.Three);
      position.phase(TurnPhase.P1move);
    });

    const hunter = board.state.places
      .flatMap((place) => place.pieces)
      .find((piece) => piece.owner === PieceOwner.P1)!;
    expect(hunter.allowedPlaces).toHaveLength(1);

    expect(controller.selectPiece(hunter.id)).toBe(true);
    const destination = controller.viewModel.highlightedPlaces[0]!;
    expect(controller.handlePlaceClick(destination)).toBe(true);

    const view = controller.viewModel;
    expect(controller.state.gameOver).toBe(true);
    expect(view.phase).toBe("gameover");
    expect(view.gameOver).not.toBeNull();
    expect(view.gameOver!.winner).toBe(PieceOwner.P1);
    expect(view.gameOver!.reason).toBe(WinReason.OpponentSoldiersExhausted);
    expect(view.gameOver!.winnerLabel).toContain("P1");
    expect(view.eventMessages).toContain("P1 · Women captured a soldier");
    expect(view.eventMessages.some((message) => message.includes("wins"))).toBe(true);
    expect(view.dice.canRoll).toBe(false);
    expect(view.dice.canReroll).toBe(false);

    // A finished match ignores every further interaction.
    expect(controller.roll()).toBe(false);
    expect(controller.selectPiece(hunter.id)).toBe(false);
    expect(controller.handlePlaceClick(destination)).toBe(false);
    expect(controller.viewModel.selectedPieceId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------- housekeeping

describe("WebMatchController: subscriptions and reset", () => {
  it("notifies subscribers on every change and stops after unsubscribe", () => {
    const { controller } = evenOddsController([DieFace.Three, DieFace.Three, DieFace.Three]);
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications++;
    });

    controller.clearSelection(); // nothing is selected: not a change
    expect(notifications).toBe(0);

    controller.roll();
    expect(notifications).toBe(1);

    const pieceId = controller.viewModel.selectablePieceIds[0]!;
    controller.selectPiece(pieceId);
    expect(notifications).toBe(2);

    unsubscribe();
    controller.handlePlaceClick(controller.viewModel.highlightedPlaces[0]!);
    expect(notifications).toBe(2);
  });

  it("deals a completely fresh match on reset", () => {
    const { controller } = evenOddsController([
      DieFace.Three,
      DieFace.Three,
      DieFace.Three,
      DieFace.Two,
      DieFace.Two,
      DieFace.Two,
    ]);
    controller.roll();
    const previous = controller.state;
    expect(controller.viewModel.phase).toBe("move");

    controller.resetMatch();

    const view = controller.viewModel;
    expect(controller.state).not.toBe(previous);
    expect(view.phase).toBe("roll");
    expect(view.currentPlayer).toBe(PieceOwner.P1);
    expect(view.dice.rolled).toBe(false);
    expect(view.selectedPieceId).toBeNull();
    expect(view.eventMessages).toEqual([]);
    expect(view.gameOver).toBeNull();
  });
});
