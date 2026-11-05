/**
 * Core data model of the Sáhkku rules engine.
 *
 * Nothing in here depends on a host, a renderer or a random source, so the very same state objects
 * are produced by the browser client, by the headless CLI and by the tests. Enum values are stable
 * because they are part of persisted and replayed state.
 */

/** Kind of piece. */
export enum PieceType {
  Soldier = 0,
  King = 1,
  Queen = 2,
}

export enum PieceOwner {
  None = 0,
  P1 = 1,
  P2 = 2,
}

/**
 * Identity of a sáhkku die face (birccu). Purely an identity: the ruleset decides how many
 * steps each face is worth and in which order faces must be spent.
 */
export enum DieFace {
  Sahhku = 0,
  Three = 1,
  Two = 2,
  Zero = 3,
}

export enum TurnPhase {
  P1roll = 0,
  P1move = 1,
  P2roll = 2,
  P2move = 3,
}

/**
 * The player's explicit choice when re-rolling is on offer (see
 * `RulesEngine.applyRerollDecision`). The engine offers re-rolling only when the ruleset permits it;
 * a player with no active pieces must use a sáhkku to activate a piece.
 */
export enum RerollDecision {
  KeepDiceAndProceed = 0,
  RerollActiveDie = 1,
}

/** Why the game ended. Lets a host pick the right message without re-deriving rules. */
export enum WinReason {
  None = 0,

  /** The loser has no soldiers left on the board. */
  OpponentSoldiersExhausted = 1,

  /** The loser's queen was captured. */
  QueenCaptured = 2,
}

export enum RuleEventKind {
  PieceMoved = 0,
  SoldierCaptured = 1,
  KingRecruited = 2,
  QueenCaptured = 3,
  GameWon = 4,
}

/**
 * Thrown when a caller asks the engine to apply an action that is not legal in the current state.
 * Distinct from `RuleSetException`, which means the *ruleset* is broken.
 */
export class IllegalMoveException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalMoveException";
  }
}

/** Thrown when a ruleset cannot be parsed, is incomplete, or is inconsistent. */
export class RuleSetException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleSetException";
  }
}

/** A single playing piece. It lives on exactly one `Place`. */
export class Piece {
  /** Stable identity used to refer to a piece from a `Move`. */
  id: number;

  /** Index into `GameState.places`; the board square the piece occupies. */
  placeIndex: number;

  /**
   * Position along its owner's track (see `BoardTrack`), in `[0, trackLength)`.
   * `placeIndex` is derived from it, so the two can never disagree. Two arcs can map onto the same
   * middle-row place, which is exactly why this cannot be derived back from `placeIndex` and has to
   * be stored.
   */
  arc: number;

  type: PieceType;
  owner: PieceOwner;
  isActive: boolean;
  canBeActivated: boolean;
  allowedPlaces: number[];

  constructor(
    id: number,
    placeIndex: number,
    type: PieceType,
    owner: PieceOwner,
    isActive = false,
  ) {
    this.id = id;
    this.placeIndex = placeIndex;
    this.arc = placeIndex;
    this.type = type;
    this.owner = owner;
    this.isActive = isActive;
    this.canBeActivated = false;
    this.allowedPlaces = [];
  }

  isSelectable(): boolean {
    return this.allowedPlaces.length > 0;
  }
}

/** A board point (place) and the pieces currently on it. */
export class Place {
  x: number;
  y: number;
  pieces: Piece[];

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.pieces = [];
  }
}

/** Mutable game state. Contains no host types, so it can be produced/consumed off-engine. */
export class GameState {
  places: Place[];
  dice: DieFace[];
  turnPhase: TurnPhase;
  currentActiveDie: number;

  /**
   * True once the current player has explicitly chosen to keep the dice of this throw (see
   * `RulesEngine.applyRerollDecision`). While set, re-rolling is no longer offered for this throw,
   * even though a sáhkku face may still be up. Reset by every new roll and turn hand-over.
   */
  rerollDecisionMade: boolean;

  gameOver: boolean;
  winner: PieceOwner;
  winReason: WinReason;
  p1Captures: number;
  p2Captures: number;

  constructor() {
    this.places = [];
    this.dice = [];
    this.turnPhase = TurnPhase.P1roll;
    this.currentActiveDie = 0;
    this.rerollDecisionMade = false;
    this.gameOver = false;
    this.winner = PieceOwner.None;
    this.winReason = WinReason.None;
    this.p1Captures = 0;
    this.p2Captures = 0;
  }

  /** The player whose turn it is, derived from `turnPhase`. */
  get currentPlayer(): PieceOwner {
    return this.turnPhase < 2 ? PieceOwner.P1 : PieceOwner.P2;
  }

  /** True while the current player still has to roll (or reroll) dice. */
  get isRollPhase(): boolean {
    return this.turnPhase === TurnPhase.P1roll || this.turnPhase === TurnPhase.P2roll;
  }

  /** Deep copy, for search (LLM NPCs) and for tests that need to try a move twice. */
  clone(): GameState {
    const copy = new GameState();
    copy.turnPhase = this.turnPhase;
    copy.currentActiveDie = this.currentActiveDie;
    copy.rerollDecisionMade = this.rerollDecisionMade;
    copy.gameOver = this.gameOver;
    copy.winner = this.winner;
    copy.winReason = this.winReason;
    copy.p1Captures = this.p1Captures;
    copy.p2Captures = this.p2Captures;
    copy.dice.push(...this.dice);

    for (const place of this.places) {
      const placeCopy = new Place(place.x, place.y);
      for (const piece of place.pieces) {
        const pieceCopy = new Piece(
          piece.id,
          piece.placeIndex,
          piece.type,
          piece.owner,
          piece.isActive,
        );
        pieceCopy.arc = piece.arc;
        pieceCopy.canBeActivated = piece.canBeActivated;
        pieceCopy.allowedPlaces.push(...piece.allowedPlaces);
        placeCopy.pieces.push(pieceCopy);
      }
      copy.places.push(placeCopy);
    }
    return copy;
  }
}

/** A proposed or legal action: move the piece with `pieceId` onto `targetPlaceIndex`. */
export class Move {
  readonly pieceId: number;
  readonly targetPlaceIndex: number;

  constructor(pieceId: number, targetPlaceIndex: number) {
    this.pieceId = pieceId;
    this.targetPlaceIndex = targetPlaceIndex;
  }

  toString(): string {
    return `piece ${this.pieceId} -> place ${this.targetPlaceIndex}`;
  }
}

/**
 * A side effect of an applied action, emitted in order so the host can play sounds and visuals.
 */
export class RuleEvent {
  kind: RuleEventKind;
  pieceType: PieceType;
  owner: PieceOwner;
  winner: PieceOwner;

  constructor(
    kind: RuleEventKind,
    pieceType: PieceType,
    owner: PieceOwner,
    winner: PieceOwner = PieceOwner.None,
  ) {
    this.kind = kind;
    this.pieceType = pieceType;
    this.owner = owner;
    this.winner = winner;
  }
}

/** Injectable randomness so the engine stays deterministic and host-free. */
export interface IRandomSource {
  /** Returns a die face index in `[0, 4)`. */
  nextDieFaceIndex(): number;
}

/** Options supplied by the host (menu/settings) when starting a game. */
export class EngineOptions {
  startingPlayer: PieceOwner;
  evenOdds: boolean;

  /**
   * When true, `RulesEngine.initGame(options, random)` selects the starting player by throwing for
   * it (see `RulesEngine.throwForStartingPlayer`) instead of using `startingPlayer`. A random
   * source is then required.
   */
  throwForStartingPlayer: boolean;

  constructor(startingPlayer: PieceOwner, evenOdds: boolean, throwForStartingPlayer = false) {
    this.startingPlayer = startingPlayer;
    this.evenOdds = evenOdds;
    this.throwForStartingPlayer = throwForStartingPlayer;
  }
}
