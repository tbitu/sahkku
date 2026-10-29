/**
 * The data-driven ruleset: the 1:1 port of the retired C# `RuleSet` and its reflection-free
 * `RuleSetJson.FromJson` mapper.
 *
 * `SahkkuRules.json` stays the single authoritative specification of the game: the engine only ever
 * consults the primitives this file declares, and `validate()` refuses a ruleset that is incomplete
 * or internally inconsistent.
 *
 * The C# original shipped a hand-written JSON reader to stay IL2CPP/WebGL-safe; here the platform's
 * `JSON.parse` does that job, so only the schema mapping and the validation are ported.
 */

import { DieFace, PieceType, RuleSetException } from "./domain";
import sahkkuRulesJson from "./SahkkuRules.json";

/** Movement pattern ids used by `PieceRules.moves`. */
export const MovePatterns = {
  /** Along the board track in the moving player's forward direction. */
  Forward: "forward",

  /** Opposite to `Forward`. */
  Backward: "backward",

  /** Straight up/down between rows (same x, y ± steps), for pieces that may cross rows. */
  Vertical: "vertical",
} as const;

/** Track leg directions, expressed in board coordinates (the PDF wording: "right"/"left"). */
export const TrackDirections = {
  Right: "right",
  Left: "left",
} as const;

/** Starting-player rules. */
export const StartModes = {
  /** Players throw in turn; the first to roll a sáhkku (X) starts. */
  FirstSahhku: "firstSahhku",

  /** Each player throws the whole set once; the most sáhkku (X) faces start. */
  MostSahhku: "mostSahhku",
} as const;

export interface BoardRules {
  width: number;
  height: number;
  layout: string;
}

/** A leg of the figure-of-eight lap, in board coordinates. */
export interface TrackLegRules {
  /** Board row this leg runs along. */
  row: number;

  /** `TrackDirections.Right` or `TrackDirections.Left`. */
  direction: string;
}

export interface TrackRules {
  legs: TrackLegRules[];
}

/** Per-piece rule primitives selected by the engine. */
export class PieceRules {
  /** Movement patterns from `MovePatterns`. */
  moves: string[];

  /** When true the step count comes from the current die; otherwise it is a single step. */
  movesScaleWithDie: boolean;

  /** Piece starts the game able to be activated (used for queens). */
  startActivatable: boolean;

  /** Activating this piece unlocks the next piece in the activation queue. */
  queuesNextOnActivation: boolean;

  /** Other pieces may not land on this piece when it is owned by the mover. */
  blocksOwnLanding: boolean;

  /** This piece may not land on a piece owned by the mover. */
  cannotLandOnOwnUnits: boolean;

  /** Landing on an opponent's piece of this type removes it and scores a capture. */
  capturable: boolean;

  /** Landing on a piece of this type recruits it to the mover instead of removing it. */
  recruitedWhenLanded: boolean;

  /** Landing on a piece of this type immediately ends the game in the mover's favour. */
  landingEndsGame: boolean;

  /** This piece recruits the neutral king by entering the opponent's home row. */
  recruitsKingOnEnemyHomeRow: boolean;

  constructor(init: {
    moves: string[];
    movesScaleWithDie: boolean;
    startActivatable: boolean;
    queuesNextOnActivation: boolean;
    blocksOwnLanding: boolean;
    cannotLandOnOwnUnits: boolean;
    capturable: boolean;
    recruitedWhenLanded: boolean;
    landingEndsGame: boolean;
    recruitsKingOnEnemyHomeRow: boolean;
  }) {
    this.moves = init.moves;
    this.movesScaleWithDie = init.movesScaleWithDie;
    this.startActivatable = init.startActivatable;
    this.queuesNextOnActivation = init.queuesNextOnActivation;
    this.blocksOwnLanding = init.blocksOwnLanding;
    this.cannotLandOnOwnUnits = init.cannotLandOnOwnUnits;
    this.capturable = init.capturable;
    this.recruitedWhenLanded = init.recruitedWhenLanded;
    this.landingEndsGame = init.landingEndsGame;
    this.recruitsKingOnEnemyHomeRow = init.recruitsKingOnEnemyHomeRow;
  }

  has(pattern: string): boolean {
    return this.moves.includes(pattern);
  }
}

export interface PieceSetRules {
  soldier: PieceRules;
  king: PieceRules;
  queen: PieceRules;
}

export interface DieFaceRules {
  id: string;
  steps: number;
}

export interface RerollRules {
  /** Faces that may be thrown again (the sáhkku X in this ruleset). */
  faces: string[];

  /** Re-rolls are only allowed before any die of this throw has been spent. */
  beforeUsingAnyDie: boolean;
}

export interface DiceRules {
  count: number;

  /** Face that can activate a piece. */
  activateFace: string;

  /**
   * The order in which thrown dice must be spent (the PDF: "first use the X's, then the III's,
   * then the II's"). Index 0 is spent first.
   */
  useOrder: string[];

  reroll: RerollRules;
  faces: DieFaceRules[];
}

export interface SoldierActivationRule {
  /**
   * How many home-row lines (negative = towards the rear) from the mover's *source* line the
   * soldier that becomes activatable stands. Soldiers must be activated in queue order, so the
   * piece one line further back is the next one in the queue.
   */
  unlockOffset: number;
}

export interface ActivationRules {
  onMoveInactivePiece: SoldierActivationRule;
}

/** Rules about pieces that have not been activated yet. */
export interface InactiveRules {
  /** False when no piece may be moved onto a line holding an unactivated piece. */
  enterable: boolean;
}

export interface StartRules {
  /** One of `StartModes`. */
  mode: string;
}

export interface RowPlacement {
  row: number;
  placement: string;
}

export interface Placement {
  row: number;
  x: number;
}

export interface KingsPlacement extends Placement {
  owner: string;
}

export interface PerOwnerRow {
  P1: RowPlacement;
  P2: RowPlacement;
}

export interface PerOwnerPlacement {
  P1: Placement;
  P2: Placement;
}

export interface SetupRules {
  soldiers: PerOwnerRow;
  queens: PerOwnerPlacement;
  king: KingsPlacement;
}

/**
 * A starting position. The activation queue always runs from the foremost soldier of the home row
 * towards the rear, so a variant only has to say how many soldiers are already loose.
 */
export interface VariantRules {
  /** Leading soldiers that start activated and one step forward; the next starts activatable. */
  soldiersActive: number;
}

export interface VariantSet {
  standard: VariantRules;
  evenOdds: VariantRules;
}

export interface WinRules {
  /** You win when the opponent has no soldiers left on the board. */
  opponentSoldiersExhausted: boolean;
}

/**
 * A complete, data-driven description of the sáhkku ruleset. Authored in JSON
 * (`src/rules/SahkkuRules.json`) and interpreted by `RulesEngine`.
 */
export class RuleSet {
  id: string | null;
  version: number;
  board: BoardRules;
  track: TrackRules;
  pieces: PieceSetRules;
  dice: DiceRules;
  activation: ActivationRules;
  inactive: InactiveRules;
  start: StartRules;
  setup: SetupRules;
  variants: VariantSet;
  win: WinRules;

  constructor(init: {
    id: string | null;
    version: number;
    board: BoardRules;
    track: TrackRules;
    pieces: PieceSetRules;
    dice: DiceRules;
    activation: ActivationRules;
    inactive: InactiveRules;
    start: StartRules;
    setup: SetupRules;
    variants: VariantSet;
    win: WinRules;
  }) {
    this.id = init.id;
    this.version = init.version;
    this.board = init.board;
    this.track = init.track;
    this.pieces = init.pieces;
    this.dice = init.dice;
    this.activation = init.activation;
    this.inactive = init.inactive;
    this.start = init.start;
    this.setup = init.setup;
    this.variants = init.variants;
    this.win = init.win;
  }

  def(type: PieceType): PieceRules {
    if (type === PieceType.Soldier) return this.pieces.soldier;
    if (type === PieceType.King) return this.pieces.king;
    return this.pieces.queen;
  }

  faceRules(face: DieFace): DieFaceRules {
    const id = RuleSet.faceId(face);
    for (const rule of this.dice.faces) {
      if (rule.id === id) return rule;
    }
    throw new RuleSetException(`Ruleset is missing the '${id}' die face.`);
  }

  /** The ruleset face id of a `DieFace`. Identity only; the JSON decides steps and order. */
  static faceId(face: DieFace): string {
    switch (face) {
      case DieFace.Sahhku:
        return "sahhku";
      case DieFace.Three:
        return "three";
      case DieFace.Two:
        return "two";
      default:
        return "zero";
    }
  }

  resolveFace(id: string): DieFace {
    for (let i = 0; i < this.dice.faces.length; ++i) {
      if (this.dice.faces[i].id === id) return i as DieFace;
    }
    throw new RuleSetException(`Unknown die face id '${id}'.`);
  }

  /** Sort key for a face: its position in `dice.useOrder`. Lower is spent first. */
  useOrderOf(face: DieFace): number {
    const id = RuleSet.faceId(face);
    const index = this.dice.useOrder.indexOf(id);
    if (index < 0) {
      throw new RuleSetException(`Die face '${id}' is not listed in 'dice.useOrder'.`);
    }
    return index;
  }

  /** Throws `RuleSetException` if the ruleset is incomplete or inconsistent. */
  validate(): void {
    if (this.board == null) throw new RuleSetException("Ruleset is missing 'board'.");
    if (this.board.width <= 0 || this.board.height <= 0) {
      throw new RuleSetException("'board.width' and 'board.height' must be positive.");
    }
    if (this.board.layout !== "rowMajorSnake") {
      throw new RuleSetException(
        `Unsupported board layout '${this.board.layout}'; expected 'rowMajorSnake'.`,
      );
    }

    this.validateTrack();
    this.validatePieces();
    this.validateDice();

    if (this.activation == null || this.activation.onMoveInactivePiece == null) {
      throw new RuleSetException("Ruleset must define 'activation.onMoveInactivePiece'.");
    }

    if (this.inactive == null) throw new RuleSetException("Ruleset is missing 'inactive'.");

    if (this.start == null) throw new RuleSetException("Ruleset is missing 'start'.");
    if (this.start.mode !== StartModes.FirstSahhku && this.start.mode !== StartModes.MostSahhku) {
      throw new RuleSetException(
        `Unsupported 'start.mode' '${this.start.mode}'; expected '${StartModes.FirstSahhku}' or '${StartModes.MostSahhku}'.`,
      );
    }

    this.validateSetup();
    this.validateVariants();

    if (this.win == null) throw new RuleSetException("Ruleset is missing 'win'.");
    if (!this.win.opponentSoldiersExhausted && !this.hasLandingEndsGamePiece()) {
      throw new RuleSetException(
        "Ruleset defines no way to win: enable 'win.opponentSoldiersExhausted' or 'landingEndsGame' on a piece.",
      );
    }
  }

  private validateTrack(): void {
    if (this.track == null || this.track.legs == null || this.track.legs.length === 0) {
      throw new RuleSetException("Ruleset must define at least one 'track.legs' entry.");
    }

    const covered = new Array<boolean>(this.board.height).fill(false);
    for (let i = 0; i < this.track.legs.length; ++i) {
      const leg = this.track.legs[i];
      if (leg == null) throw new RuleSetException(`'track.legs[${i}]' is null.`);
      if (leg.row < 0 || leg.row >= this.board.height) {
        throw new RuleSetException(`'track.legs[${i}].row' is off the board.`);
      }
      if (leg.direction !== TrackDirections.Right && leg.direction !== TrackDirections.Left) {
        throw new RuleSetException(
          `'track.legs[${i}].direction' must be '${TrackDirections.Right}' or '${TrackDirections.Left}'.`,
        );
      }
      covered[leg.row] = true;
    }

    for (let row = 0; row < this.board.height; ++row) {
      if (!covered[row]) {
        throw new RuleSetException(`'track.legs' never visits board row ${row}.`);
      }
    }

    if (this.track.legs[0].row !== 0 && this.track.legs[0].row !== this.board.height - 1) {
      throw new RuleSetException(
        `'track.legs[0]' must start on a home row (row 0 or row ${this.board.height - 1}).`,
      );
    }

    // Legs must join end-to-end with a bend: consecutive legs share the join column but not the
    // row, and the lap must close.
    for (let i = 0; i < this.track.legs.length; ++i) {
      const from = this.track.legs[i];
      const to = this.track.legs[(i + 1) % this.track.legs.length];
      const endX = from.direction === TrackDirections.Right ? this.board.width - 1 : 0;
      const startX = to.direction === TrackDirections.Right ? 0 : this.board.width - 1;
      if (endX !== startX) {
        throw new RuleSetException(
          `'track.legs[${i}]' ends at x=${endX} but the next leg starts at x=${startX}; legs must join with a bend.`,
        );
      }
      if (from.row === to.row) {
        throw new RuleSetException(
          `'track.legs[${i}]' and the next leg both stay on row ${from.row}; a leg must end by bending onto another row.`,
        );
      }
    }
  }

  private validatePieces(): void {
    if (this.pieces == null || this.pieces.soldier == null || this.pieces.queen == null || this.pieces.king == null) {
      throw new RuleSetException("Ruleset must define 'soldier', 'queen' and 'king' pieces.");
    }
    this.validatePiece("soldier", this.pieces.soldier);
    this.validatePiece("queen", this.pieces.queen);
    this.validatePiece("king", this.pieces.king);
  }

  private validatePiece(name: string, piece: PieceRules): void {
    if (piece.moves == null || piece.moves.length === 0) {
      throw new RuleSetException(`Piece '${name}' must declare at least one movement pattern.`);
    }
    for (const move of piece.moves) {
      if (
        move !== MovePatterns.Forward &&
        move !== MovePatterns.Backward &&
        move !== MovePatterns.Vertical
      ) {
        throw new RuleSetException(`Piece '${name}' has unknown movement pattern '${move}'.`);
      }
    }

    if (piece.recruitedWhenLanded && piece.capturable) {
      throw new RuleSetException(
        `Piece '${name}' cannot be both 'capturable' and 'recruitedWhenLanded'.`,
      );
    }
    if (piece.landingEndsGame && !piece.capturable) {
      throw new RuleSetException(
        `Piece '${name}' declares 'landingEndsGame' but is not 'capturable', so the ending can never happen.`,
      );
    }
    if (piece.recruitsKingOnEnemyHomeRow && piece.recruitedWhenLanded) {
      throw new RuleSetException(
        `Piece '${name}' cannot recruit the king both by landing and by entering the enemy home row.`,
      );
    }
  }

  private validateDice(): void {
    if (this.dice == null) throw new RuleSetException("Ruleset is missing 'dice'.");
    if (this.dice.count <= 0) throw new RuleSetException("'dice.count' must be positive.");
    if (this.dice.faces == null || this.dice.faces.length !== 4) {
      throw new RuleSetException(
        "A four-sided sáhkku die needs exactly 4 faces (sahhku, three, two, zero).",
      );
    }

    const expected = ["sahhku", "three", "two", "zero"];
    for (const id of expected) {
      const face = this.findFace(id);
      if (face == null) {
        throw new RuleSetException(`Die face '${id}' must be declared exactly once in 'dice.faces'.`);
      }
      if (face.steps < 0) {
        throw new RuleSetException(`'dice.faces[${id}].steps' must not be negative.`);
      }
    }
    if (this.dice.faces.length !== expected.length) {
      throw new RuleSetException("'dice.faces' must declare the four sáhkku faces exactly once each.");
    }

    if (this.dice.useOrder == null || this.dice.useOrder.length !== expected.length) {
      throw new RuleSetException(
        "'dice.useOrder' must list the four sáhkku faces in the order they are spent.",
      );
    }
    for (const id of expected) {
      if (!this.dice.useOrder.includes(id)) {
        throw new RuleSetException(`'dice.useOrder' must list '${id}' exactly once.`);
      }
    }

    if (!this.dice.activateFace) throw new RuleSetException("'dice.activateFace' is required.");
    this.resolveFace(this.dice.activateFace);

    if (this.dice.reroll == null) throw new RuleSetException("Ruleset is missing 'dice.reroll'.");
    if (this.dice.reroll.faces == null || this.dice.reroll.faces.length === 0) {
      throw new RuleSetException("'dice.reroll.faces' must list at least one re-rollable face.");
    }
    for (const face of this.dice.reroll.faces) {
      this.resolveFace(face);
    }
  }

  private validateSetup(): void {
    if (this.setup == null) throw new RuleSetException("Ruleset is missing 'setup'.");
    this.validateRow("setup.soldiers.P1", this.setup.soldiers == null ? null : this.setup.soldiers.P1);
    this.validateRow("setup.soldiers.P2", this.setup.soldiers == null ? null : this.setup.soldiers.P2);
    this.validatePlacement("setup.queens.P1", this.setup.queens == null ? null : this.setup.queens.P1);
    this.validatePlacement("setup.queens.P2", this.setup.queens == null ? null : this.setup.queens.P2);
    this.validatePlacement("setup.king", this.setup.king);

    if (this.setup.soldiers.P1.row === this.setup.soldiers.P2.row) {
      throw new RuleSetException("'setup.soldiers.P1.row' and 'setup.soldiers.P2.row' must differ.");
    }

    const taken = new Map<number, string>();
    this.markRow(taken, "setup.soldiers.P1", this.setup.soldiers.P1.row);
    this.markRow(taken, "setup.soldiers.P2", this.setup.soldiers.P2.row);
    this.markPlacement(taken, "setup.queens.P1", this.setup.queens.P1);
    this.markPlacement(taken, "setup.queens.P2", this.setup.queens.P2);
    this.markPlacement(taken, "setup.king", this.setup.king);
  }

  private validateVariants(): void {
    if (this.variants == null) throw new RuleSetException("Ruleset is missing 'variants'.");
    if (this.variants.standard == null) {
      throw new RuleSetException("Ruleset must define a 'standard' variant.");
    }
    if (this.variants.evenOdds == null) {
      throw new RuleSetException("Ruleset must define an 'evenOdds' variant.");
    }
    this.validateVariant("standard", this.variants.standard);
    this.validateVariant("evenOdds", this.variants.evenOdds);
  }

  private validateVariant(name: string, variant: VariantRules): void {
    if (variant.soldiersActive < 0 || variant.soldiersActive >= this.board.width) {
      throw new RuleSetException(
        `'variants.${name}.soldiersActive' must be between 0 and ${this.board.width - 1} (at least one soldier must still be waiting to be activated).`,
      );
    }
  }

  private hasLandingEndsGamePiece(): boolean {
    return (
      this.pieces.soldier.landingEndsGame ||
      this.pieces.queen.landingEndsGame ||
      this.pieces.king.landingEndsGame
    );
  }

  private findFace(id: string): DieFaceRules | null {
    for (const face of this.dice.faces) {
      if (face != null && face.id === id) return face;
    }
    return null;
  }

  private validateRow(path: string, placement: RowPlacement | null): void {
    if (placement == null) throw new RuleSetException(`'${path}' is required.`);
    if (placement.placement !== "all") {
      throw new RuleSetException(`'${path}.placement' must be 'all'.`);
    }
    if (placement.row < 0 || placement.row >= this.board.height) {
      throw new RuleSetException(`'${path}.row' is off the board.`);
    }
  }

  private validatePlacement(path: string, placement: Placement | null): void {
    if (placement == null) throw new RuleSetException(`'${path}' is required.`);
    if (placement.row < 0 || placement.row >= this.board.height) {
      throw new RuleSetException(`'${path}.row' is off the board.`);
    }
    if (placement.x < 0 || placement.x >= this.board.width) {
      throw new RuleSetException(`'${path}.x' is off the board.`);
    }
  }

  private markPlacement(taken: Map<number, string>, path: string, placement: Placement): void {
    this.mark(taken, path, placement.x, placement.row);
  }

  private markRow(taken: Map<number, string>, path: string, row: number): void {
    for (let x = 0; x < this.board.width; ++x) this.mark(taken, path, x, row);
  }

  private mark(taken: Map<number, string>, path: string, x: number, row: number): void {
    // The snake layout lives in `track.ts`; importing it here would be a cycle, and the mapping is
    // two lines long, so it is inlined exactly as `BoardLayout.indexFromCoordinates` computes it.
    const y = row;
    const i = y % 2 === 1 ? this.board.width - 1 - x : x;
    const place = y * this.board.width + i;
    const other = taken.get(place);
    if (other !== undefined) {
      throw new RuleSetException(`'${path}' overlaps '${other}' at x=${x}, y=${y}.`);
    }
    taken.set(place, path);
  }
}

// ----------------------------------------------------------------------------------------------
// JSON mapping (ported from the retired C# JSON reader)
// ----------------------------------------------------------------------------------------------

/** Maps the ruleset JSON onto `RuleSet` (explicit, reflection-free). */
export class RuleSetJson {
  static fromJson(json: string): RuleSet {
    let root: unknown;
    try {
      root = JSON.parse(json);
    } catch (error) {
      throw new RuleSetException(`Ruleset JSON could not be parsed: ${(error as Error).message}`);
    }

    const ruleset = new RuleSet({
      id: root !== null && typeof root === "object" && "id" in (root as object)
        ? asStringOrNull((root as Record<string, unknown>)["id"])
        : null,
      version:
        root !== null && typeof root === "object" && "version" in (root as object)
          ? asInt((root as Record<string, unknown>)["version"], "version")
          : 0,
      board: parseBoard(require(root, "board")),
      track: parseTrack(require(root, "track")),
      pieces: parsePieces(require(root, "pieces")),
      dice: parseDice(require(root, "dice")),
      activation: parseActivation(require(root, "activation")),
      inactive: parseInactive(require(root, "inactive")),
      start: parseStart(require(root, "start")),
      setup: parseSetup(require(root, "setup")),
      variants: parseVariants(require(root, "variants")),
      win: parseWin(require(root, "win")),
    });
    ruleset.validate();
    return ruleset;
  }
}

// ----------------------------------------------------------------------------------------------
// The shipped ruleset
// ----------------------------------------------------------------------------------------------

/**
 * The shipped ruleset, imported so the engine, the browser bundle and the tests all read the very
 * same file: `src/rules/SahkkuRules.json` is the single authoritative document, and the test suite
 * pins its sha256 so a change to it is always a deliberate edit.
 */
export const shippedRulesetJson = sahkkuRulesJson as unknown as Record<string, unknown>;

/** A fresh, mutable `RuleSet` parsed from the shipped JSON. */
export function loadShippedRuleset(): RuleSet {
  return RuleSetJson.fromJson(JSON.stringify(sahkkuRulesJson));
}

// ----------------------------------------------------------------------------------------------
// Schema readers
// ----------------------------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `JsonValue.Require(key)`: missing keys (and explicit nulls) are a broken ruleset. */
function require(container: unknown, key: string): unknown {
  if (!isObject(container)) {
    throw new RuleSetException(`Expected a JSON object while reading '${key}'.`);
  }
  const value = container[key];
  if (value === undefined || value === null) {
    throw new RuleSetException(`Missing required ruleset key '${key}'.`);
  }
  return value;
}

function asString(value: unknown, key = "value"): string {
  if (typeof value !== "string") {
    throw new RuleSetException(`Expected a string for '${key}' but found ${typeof value}.`);
  }
  return value;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBool(value: unknown, key = "value"): boolean {
  if (typeof value !== "boolean") {
    throw new RuleSetException(`Expected a boolean for '${key}' but found ${typeof value}.`);
  }
  return value;
}

function asInt(value: unknown, key = "value"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RuleSetException(`Expected a number for '${key}' but found ${typeof value}.`);
  }
  return Math.trunc(value);
}

/** `JsonValue.Items()`: anything that is not an array reads as an empty list, which validation rejects. */
function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseStringArray(value: unknown): string[] {
  return items(value).map((item) => asString(item));
}

function parseBoard(value: unknown): BoardRules {
  return {
    width: asInt(require(value, "width"), "width"),
    height: asInt(require(value, "height"), "height"),
    layout: asString(require(value, "layout"), "layout"),
  };
}

function parseTrack(value: unknown): TrackRules {
  const legs = items(require(value, "legs"));
  return {
    legs: legs.map((leg) => ({
      row: asInt(require(leg, "row"), "row"),
      direction: asString(require(leg, "direction"), "direction"),
    })),
  };
}

function parsePieces(value: unknown): PieceSetRules {
  return {
    soldier: parsePiece(require(value, "soldier")),
    king: parsePiece(require(value, "king")),
    queen: parsePiece(require(value, "queen")),
  };
}

function parsePiece(value: unknown): PieceRules {
  return new PieceRules({
    moves: parseStringArray(require(value, "moves")),
    movesScaleWithDie: asBool(require(value, "movesScaleWithDie"), "movesScaleWithDie"),
    startActivatable: asBool(require(value, "startActivatable"), "startActivatable"),
    queuesNextOnActivation: asBool(
      require(value, "queuesNextOnActivation"),
      "queuesNextOnActivation",
    ),
    blocksOwnLanding: asBool(require(value, "blocksOwnLanding"), "blocksOwnLanding"),
    cannotLandOnOwnUnits: asBool(require(value, "cannotLandOnOwnUnits"), "cannotLandOnOwnUnits"),
    capturable: asBool(require(value, "capturable"), "capturable"),
    recruitedWhenLanded: asBool(require(value, "recruitedWhenLanded"), "recruitedWhenLanded"),
    landingEndsGame: asBool(require(value, "landingEndsGame"), "landingEndsGame"),
    recruitsKingOnEnemyHomeRow: asBool(
      require(value, "recruitsKingOnEnemyHomeRow"),
      "recruitsKingOnEnemyHomeRow",
    ),
  });
}

function parseDice(value: unknown): DiceRules {
  const faces = items(require(value, "faces")).map((face) => ({
    id: asString(require(face, "id"), "id"),
    steps: asInt(require(face, "steps"), "steps"),
  }));
  return {
    count: asInt(require(value, "count"), "count"),
    activateFace: asString(require(value, "activateFace"), "activateFace"),
    useOrder: parseStringArray(require(value, "useOrder")),
    reroll: parseReroll(require(value, "reroll")),
    faces,
  };
}

function parseReroll(value: unknown): RerollRules {
  return {
    faces: parseStringArray(require(value, "faces")),
    beforeUsingAnyDie: asBool(require(value, "beforeUsingAnyDie"), "beforeUsingAnyDie"),
  };
}

function parseActivation(value: unknown): ActivationRules {
  const rule = require(value, "onMoveInactivePiece");
  return {
    onMoveInactivePiece: {
      unlockOffset: asInt(require(rule, "unlockOffset"), "unlockOffset"),
    },
  };
}

function parseInactive(value: unknown): InactiveRules {
  return { enterable: asBool(require(value, "enterable"), "enterable") };
}

function parseStart(value: unknown): StartRules {
  return { mode: asString(require(value, "mode"), "mode") };
}

function parseSetup(value: unknown): SetupRules {
  const soldiers = require(value, "soldiers");
  const queens = require(value, "queens");
  const king = require(value, "king");
  return {
    soldiers: {
      P1: parseRow(require(soldiers, "P1")),
      P2: parseRow(require(soldiers, "P2")),
    },
    queens: {
      P1: parsePlacement(require(queens, "P1")),
      P2: parsePlacement(require(queens, "P2")),
    },
    king: {
      row: asInt(require(king, "row"), "row"),
      x: asInt(require(king, "x"), "x"),
      owner: asString(require(king, "owner"), "owner"),
    },
  };
}

function parseRow(value: unknown): RowPlacement {
  return {
    row: asInt(require(value, "row"), "row"),
    placement: asString(require(value, "placement"), "placement"),
  };
}

function parsePlacement(value: unknown): Placement {
  return {
    row: asInt(require(value, "row"), "row"),
    x: asInt(require(value, "x"), "x"),
  };
}

function parseVariants(value: unknown): VariantSet {
  return {
    standard: parseVariant(require(value, "standard")),
    evenOdds: parseVariant(require(value, "evenOdds")),
  };
}

function parseVariant(value: unknown): VariantRules {
  return { soldiersActive: asInt(require(value, "soldiersActive"), "soldiersActive") };
}

function parseWin(value: unknown): WinRules {
  return {
    opponentSoldiersExhausted: asBool(
      require(value, "opponentSoldiersExhausted"),
      "opponentSoldiersExhausted",
    ),
  };
}
