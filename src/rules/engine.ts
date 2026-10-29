/**
 * The rules engine: the 1:1 port of the retired C# `RulesEngine`.
 *
 * Behaviour is defined by a `RuleSet` loaded from JSON; this type contains only the rule primitives
 * those definitions select. It has no host dependency and no hidden state, so it runs unchanged in
 * the browser, in a web worker and on a server that drives an NPC.
 *
 * Movement happens along the track: every piece stores the arc it sits on (`Piece.arc`) and its
 * board cell follows from that. That is what makes the "8"-shaped pattern — including the middle row
 * being walked a second time before the soldier drops back into its home row — expressible at all.
 */

import {
  DieFace,
  GameState,
  IllegalMoveException,
  Move,
  PieceOwner,
  PieceType,
  Place,
  Piece,
  RuleEvent,
  RuleEventKind,
  RuleSetException,
  RerollDecision,
  TurnPhase,
  WinReason,
  type EngineOptions,
  type IRandomSource,
} from "./domain";
import { MovePatterns, StartModes, RuleSet, type Placement, type RowPlacement, type VariantRules } from "./ruleset";
import { BoardLayout, BoardTrack } from "./track";

export class RulesEngine {
  /** The ruleset this engine interprets. */
  readonly rules: RuleSet;

  private readonly trackP1: BoardTrack;
  private readonly trackP2: BoardTrack;

  constructor(rules: RuleSet) {
    if (rules == null) throw new RuleSetException("RulesEngine requires a RuleSet.");
    this.rules = rules;
    this.trackP1 = BoardTrack.build(rules.board, rules.track);
    this.trackP2 = this.trackP1.mirror();
  }

  /** Number of arcs in one lap of a track. */
  get trackLength(): number {
    return this.trackP1.length;
  }

  /** The board cell an arc points at, on a player's track. */
  placeOfArc(owner: PieceOwner, arc: number): number {
    return this.trackFor(owner).placeOf(arc);
  }

  /** The track arc a board cell maps to on a player's track (-1 when off the track). */
  arcOfPlace(owner: PieceOwner, placeIndex: number): number {
    return this.trackFor(owner).firstArcOf(placeIndex);
  }

  /** The row a player's soldiers start on. */
  homeRowOf(owner: PieceOwner): number {
    return this.trackFor(owner).homeRow;
  }

  /** Creates a fresh game using the setup declared in the ruleset. */
  initGame(options: EngineOptions, random?: IRandomSource | null): GameState {
    if (options.throwForStartingPlayer && random == null) {
      throw new RuleSetException("InitGame with 'throwForStartingPlayer' requires a random source.");
    }

    const state = new GameState();
    this.buildPlaces(state);

    let nextId = 0;
    nextId = this.addSoldiers(state, PieceOwner.P1, this.rules.setup.soldiers.P1, nextId);
    nextId = this.addSoldiers(state, PieceOwner.P2, this.rules.setup.soldiers.P2, nextId);
    nextId = this.addPiece(state, this.rules.setup.queens.P1, PieceType.Queen, PieceOwner.P1, nextId);
    nextId = this.addPiece(state, this.rules.setup.queens.P2, PieceType.Queen, PieceOwner.P2, nextId);
    nextId = this.addPiece(
      state,
      this.rules.setup.king,
      PieceType.King,
      resolveOwner(this.rules.setup.king.owner),
      nextId,
    );

    const variant = options.evenOdds ? this.rules.variants.evenOdds : this.rules.variants.standard;
    this.applyVariant(state, PieceOwner.P1, variant);
    this.applyVariant(state, PieceOwner.P2, variant);

    // The board cell is derived from the arc, so normalise every piece onto its owner's track
    // (the mirror means a player-two piece's arc is not its place index).
    for (const place of state.places) {
      for (const piece of place.pieces) {
        piece.arc = this.arcForPiece(piece);
      }
    }

    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (this.rules.def(piece.type).startActivatable) piece.canBeActivated = true;
      }
    }

    for (let i = 0; i < this.rules.dice.count; ++i) state.dice.push(DieFace.Zero);

    let starter = options.startingPlayer;
    if (options.throwForStartingPlayer) starter = this.throwForStartingPlayer(random as IRandomSource);
    state.turnPhase = starter === PieceOwner.P1 ? TurnPhase.P1roll : TurnPhase.P2roll;
    return state;
  }

  /**
   * Throws for the starting player as the ruleset prescribes (see `StartRules`). A host that lets
   * the players pick instead passes the choice through `EngineOptions.startingPlayer` and never
   * calls this.
   */
  throwForStartingPlayer(random: IRandomSource): PieceOwner {
    if (random == null) throw new RuleSetException("ThrowForStartingPlayer requires a random source.");
    const activateId = this.rules.dice.activateFace;

    if (this.rules.start.mode === StartModes.MostSahhku) {
      let p1: number;
      let p2: number;
      do {
        p1 = this.countSahhku(random, activateId);
        p2 = this.countSahhku(random, activateId);
      } while (p1 === p2);
      return p1 > p2 ? PieceOwner.P1 : PieceOwner.P2;
    }

    let owner = PieceOwner.P1;
    for (let attempt = 0; attempt < 10000; ++attempt) {
      for (let die = 0; die < this.rules.dice.count; ++die) {
        if (this.rules.dice.faces[random.nextDieFaceIndex()].id === activateId) return owner;
      }
      owner = owner === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;
    }
    throw new RuleSetException(
      "ThrowForStartingPlayer never produced a sáhkku; the random source looks broken.",
    );
  }

  private countSahhku(random: IRandomSource, faceId: string): number {
    let count = 0;
    for (let die = 0; die < this.rules.dice.count; ++die) {
      if (this.rules.dice.faces[random.nextDieFaceIndex()].id === faceId) count++;
    }
    return count;
  }

  /** Maps board coordinates onto the S-shaped path index; returns -1 when off the board. */
  indexFromCoordinates(x: number, y: number): number {
    return BoardLayout.indexFromCoordinates(this.rules.board.width, this.rules.board.height, x, y);
  }

  rollAllDice(state: GameState, random: IRandomSource): void {
    for (let i = 0; i < state.dice.length; ++i) {
      state.dice[i] = this.faceFromIndex(random.nextDieFaceIndex());
    }
  }

  /**
   * Rolls the dice and puts them into the ruleset's spending order, then opens the decision point:
   * while no die has been spent yet, re-rolling may still be offered (see `canReroll`). Unlike
   * `rollAndBeginTurn`, this neither evaluates moves nor hands the turn over — that is what
   * `applyRerollDecision` does.
   */
  rollDice(state: GameState, random: IRandomSource): void {
    if (state.gameOver) throw new IllegalMoveException("The game is over.");
    if (!state.isRollPhase) throw new IllegalMoveException("It is not a roll phase.");
    this.rollAllDice(state, random);
    this.orderDice(state);
    state.currentActiveDie = 0;
    state.rerollDecisionMade = false;
    state.turnPhase = (state.turnPhase + 1) as TurnPhase;
  }

  /**
   * Rolls the dice and begins the turn in one step: rolls, orders by spending value, opens the move
   * phase and hands the turn straight over when no die can be used at all, because the ruleset
   * forbids skipping a die value. Hosts that want to offer an explicit re-roll decision use
   * `rollDice` followed by `applyRerollDecision` instead.
   */
  rollAndBeginTurn(state: GameState, random: IRandomSource): void {
    this.rollDice(state, random);
    if (!this.evaluateAllowedPlaces(state)) this.nextPlayerTurn(state);
  }

  /** Orders the dice into the spending order declared by the ruleset. */
  orderDice(state: GameState): void {
    state.dice.sort((a, b) => this.rules.useOrderOf(a) - this.rules.useOrderOf(b));
  }

  /**
   * Throws the die currently up for spending again, exactly as `applyRerollDecision` with
   * `RerollDecision.RerollActiveDie` does — the re-thrown die is ordered back into the ruleset's
   * spending order, so the next sáhkku (if any) becomes the die up for spending. Only legal while
   * the ruleset allows re-rolling (here: while a sáhkku face is up and no die has been spent yet).
   * This is the legacy one-step shorthand; hosts that ask the player first should call
   * `applyRerollDecision` instead.
   */
  rerollFirstDie(state: GameState, random: IRandomSource): void {
    this.applyRerollDecision(state, RerollDecision.RerollActiveDie, random);
  }

  /**
   * Applies the player's explicit decision about the re-roll that is on offer: keep the dice and
   * spend them, or throw the active die again. The engine never chooses for the player — a host
   * (hotseat dialog, heuristic or LLM agent) must call this with the chosen `RerollDecision`;
   * keeping is always legal, re-rolling only while `canReroll` holds.
   */
  applyRerollDecision(state: GameState, decision: RerollDecision, random?: IRandomSource | null): void {
    // A re-roll needs a die roll; validate the argument before touching the state, the way initGame
    // validates the source it needs for the starting throw. Keeping the dice needs no random source
    // at all, so a host may pass null for KeepDiceAndProceed.
    if (decision === RerollDecision.RerollActiveDie && random == null) {
      throw new RuleSetException("ApplyRerollDecision with 'RerollActiveDie' requires a random source.");
    }

    if (state.gameOver || state.isRollPhase) {
      throw new IllegalMoveException("There is no thrown die to decide about.");
    }

    if (decision === RerollDecision.RerollActiveDie) {
      if (!this.canReroll(state)) throw new IllegalMoveException("Re-rolling is not allowed right now.");
      state.dice[state.currentActiveDie] = this.faceFromIndex(
        (random as IRandomSource).nextDieFaceIndex(),
      );
      this.orderDice(state);
      return;
    }

    // KeepDiceAndProceed: the dice are kept exactly as thrown. Re-rolling is closed for this throw
    // and the turn moves straight into move evaluation, handing over when nothing can be used.
    state.rerollDecisionMade = true;
    if (!this.evaluateAllowedPlaces(state)) this.nextPlayerTurn(state);
  }

  canReroll(state: GameState): boolean {
    if (state.gameOver || state.isRollPhase) return false;
    if (state.rerollDecisionMade) return false; // the player already chose to keep these dice
    if (this.rules.dice.reroll.beforeUsingAnyDie && state.currentActiveDie !== 0) return false;
    return this.canRerollFace(this.currentFace(state));
  }

  /** Recomputes `Piece.allowedPlaces` for the current player; returns whether any piece can move. */
  evaluateAllowedPlaces(state: GameState): boolean {
    if (state.gameOver || state.isRollPhase) {
      this.clearAllowedPlaces(state);
      return false;
    }

    let anyAllowedPlaces = false;
    const current = state.currentPlayer;
    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (piece.owner === current) {
          piece.allowedPlaces = this.getAllowedPlaces(state, piece);
          if (piece.isSelectable()) anyAllowedPlaces = true;
        } else {
          piece.allowedPlaces.length = 0;
        }
      }
    }
    return anyAllowedPlaces;
  }

  clearAllowedPlaces(state: GameState): void {
    for (const place of state.places) {
      for (const piece of place.pieces) {
        piece.allowedPlaces.length = 0;
      }
    }
  }

  /** Board cells the piece may move to with the die currently being spent. */
  getAllowedPlaces(state: GameState, piece: Piece): number[] {
    const allowed: number[] = [];
    const track = this.trackFor(piece.owner);
    for (const arc of this.getAllowedArcs(state, piece)) {
      const place = track.placeOf(arc);
      if (!allowed.includes(place)) allowed.push(place);
    }
    return allowed;
  }

  /**
   * The track arcs a piece may move to with the die currently being spent. This is the authoritative
   * form of "what is legal"; `getAllowedPlaces` projects it onto board cells for the UI. Two arcs
   * share a middle-row cell, so the arc is what makes a move unambiguous.
   */
  getAllowedArcs(state: GameState, piece: Piece): number[] {
    const allowed: number[] = [];
    if (piece == null) return allowed;

    const def = this.rules.def(piece.type);
    const track = this.trackFor(piece.owner);
    const steps = def.movesScaleWithDie ? this.stepsFor(this.currentFace(state)) : 1;
    if (steps === 0) return allowed;

    const canAct =
      piece.isActive ||
      (piece.canBeActivated && this.currentFace(state) === this.resolveFace(this.rules.dice.activateFace));
    if (!canAct) return allowed;

    if (def.has(MovePatterns.Forward)) this.tryAddArc(state, track, piece, piece.arc + steps, allowed);
    if (def.has(MovePatterns.Backward)) this.tryAddArc(state, track, piece, piece.arc - steps, allowed);
    if (def.has(MovePatterns.Vertical)) {
      const origin = state.places[piece.placeIndex];
      this.tryAddCrossing(state, track, piece, origin.x, origin.y + steps, allowed);
      this.tryAddCrossing(state, track, piece, origin.x, origin.y - steps, allowed);
    }
    return allowed;
  }

  getPotentialPieces(state: GameState): Piece[] {
    const potential: Piece[] = [];
    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (piece.isSelectable()) potential.push(piece);
      }
    }
    return potential;
  }

  /**
   * Every legal action for the current player according to the cached `Piece.allowedPlaces`. Call
   * `evaluateAllowedPlaces` first, or use `legalMoves`, which always computes from scratch.
   */
  getLegalMoves(state: GameState): Move[] {
    const moves: Move[] = [];
    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (!piece.isSelectable()) continue;
        for (const target of piece.allowedPlaces) {
          moves.push(new Move(piece.id, target));
        }
      }
    }
    return moves;
  }

  /** Every legal action for the current player, computed from scratch. The flat, LLM-facing view. */
  legalMoves(state: GameState): Move[] {
    const moves: Move[] = [];
    if (state.gameOver || state.isRollPhase) return moves;

    const current = state.currentPlayer;
    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (piece.owner !== current) continue;
        for (const target of this.getAllowedPlaces(state, piece)) {
          moves.push(new Move(piece.id, target));
        }
      }
    }
    return moves;
  }

  /** True when `move` is a legal action in the current state. */
  isLegalMove(state: GameState, move: Move): boolean {
    if (state == null) return false;
    if (state.gameOver || state.isRollPhase) return false;

    const piece = this.findPiece(state, move.pieceId);
    if (piece == null || piece.owner !== state.currentPlayer) return false;
    if (move.targetPlaceIndex < 0 || move.targetPlaceIndex >= state.places.length) return false;
    return this.resolveTargetArc(state, piece, move.targetPlaceIndex) >= 0;
  }

  findPiece(state: GameState, pieceId: number): Piece | null {
    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (piece.id === pieceId) return piece;
      }
    }
    return null;
  }

  /**
   * Applies a move and returns the presentation events it produced. Throws `IllegalMoveException`
   * when the move is not legal, so no caller — UI, replay file, network message or LLM — can drive
   * the game into an illegal state. Use `tryApplyMove` for the non-throwing form.
   */
  applyMove(state: GameState, move: Move): RuleEvent[] {
    const outcome = this.tryApplyMove(state, move);
    if (!outcome.success) {
      throw new IllegalMoveException(
        `Illegal move ${move} for ${PieceOwner[state.currentPlayer]} in phase ${TurnPhase[state.turnPhase]}.`,
      );
    }
    return outcome.events;
  }

  /** Non-throwing `applyMove`: `success: false` (and no events) for an illegal move. */
  tryApplyMove(state: GameState, move: Move): { success: boolean; events: RuleEvent[] } {
    const events: RuleEvent[] = [];
    if (state == null || state.gameOver || state.isRollPhase) return { success: false, events };

    const piece = this.findPiece(state, move.pieceId);
    if (piece == null || piece.owner !== state.currentPlayer) return { success: false, events };
    if (move.targetPlaceIndex < 0 || move.targetPlaceIndex >= state.places.length) {
      return { success: false, events };
    }

    const newArc = this.resolveTargetArc(state, piece, move.targetPlaceIndex);
    if (newArc < 0) return { success: false, events };

    const current = state.currentPlayer;
    const target = state.places[move.targetPlaceIndex];

    this.applyLanding(state, piece, target, current, events);

    // The ruleset may make moving an inactive piece unlock the next one in the queue.
    const activation = this.rules.activation.onMoveInactivePiece;
    if (!piece.isActive && this.rules.def(piece.type).queuesNextOnActivation) {
      this.unlockNextInQueue(state, piece, current, activation.unlockOffset);
    }

    const source = state.places[piece.placeIndex];
    const index = source.pieces.indexOf(piece);
    if (index >= 0) source.pieces.splice(index, 1);
    piece.isActive = true;
    piece.placeIndex = move.targetPlaceIndex;
    piece.arc = this.trackFor(piece.owner).normalize(newArc);
    target.pieces.push(piece);

    // A soldier reaching the opponent's home row recruits the neutral king.
    if (this.rules.def(piece.type).recruitsKingOnEnemyHomeRow) {
      const opponent = current === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;
      const track = this.trackFor(current);
      if (track.rowOfLeg(track.legOf(newArc)) === this.trackFor(opponent).homeRow) {
        this.recruitNeutralKing(state, current, events);
      }
    }

    if (state.gameOver) return { success: true, events };

    state.currentActiveDie++;
    if (state.currentActiveDie >= state.dice.length) {
      this.nextPlayerTurn(state);
    } else if (!this.evaluateAllowedPlaces(state)) {
      this.nextPlayerTurn(state);
    }
    return { success: true, events };
  }

  /**
   * Checks the invariants that must hold in every state. Returns a list of problems; an empty list
   * means the state is sound. Used by the tests and available to hosts as a debug aid.
   */
  validateState(state: GameState): string[] {
    const problems: string[] = [];
    if (state == null) {
      problems.push("state is null");
      return problems;
    }

    const seen = new Set<number>();
    let soldiers = 0;
    for (let i = 0; i < state.places.length; ++i) {
      const place = state.places[i];
      let p1 = false;
      let p2 = false;
      let royal = false;

      for (const piece of place.pieces) {
        if (seen.has(piece.id)) problems.push(`piece ${piece.id} appears on the board more than once`);
        seen.add(piece.id);
        if (piece.placeIndex !== i) {
          problems.push(`piece ${piece.id} claims place ${piece.placeIndex} but sits on place ${i}`);
        }
        if (piece.owner === PieceOwner.P1) p1 = true;
        if (piece.owner === PieceOwner.P2) p2 = true;
        if (piece.type !== PieceType.Soldier) {
          royal = true;
        } else {
          soldiers++;
        }

        const arcPlace = this.trackFor(piece.owner).placeOf(piece.arc);
        if (arcPlace !== piece.placeIndex) {
          problems.push(
            `piece ${piece.id} has arc ${piece.arc} which points at place ${arcPlace}, not ${piece.placeIndex}`,
          );
        }

        for (const allowed of piece.allowedPlaces) {
          if (allowed < 0 || allowed >= state.places.length) {
            problems.push(`piece ${piece.id} allows off-board place ${allowed}`);
          }
        }
      }

      if (p1 && p2) problems.push(`place ${i} holds pieces of both players`);
      if (royal && place.pieces.length > 1 && !sharesLineWithItsRecruiter(place)) {
        problems.push(`place ${i} makes a royal piece share its line`);
      }
    }

    if (soldiers + state.p1Captures + state.p2Captures !== 2 * this.rules.board.width) {
      problems.push(
        `soldiers are not conserved: ${soldiers} on board plus ${state.p1Captures} and ${state.p2Captures} captures is not ${2 * this.rules.board.width}`,
      );
    }

    if (state.gameOver && state.winner === PieceOwner.None) {
      problems.push("the game is over without a winner");
    }
    if (!state.gameOver && state.winner !== PieceOwner.None) {
      problems.push("a winner is set but the game is not over");
    }
    if (state.currentActiveDie < 0 || state.currentActiveDie >= state.dice.length) {
      problems.push(`currentActiveDie ${state.currentActiveDie} is out of range`);
    }
    if (!this.rules.win.opponentSoldiersExhausted && state.gameOver) {
      problems.push("the game ended although the ruleset declares no win condition");
    }
    return problems;
  }

  nextPlayerTurn(state: GameState): void {
    this.clearAllowedPlaces(state);
    state.currentActiveDie = 0;
    state.rerollDecisionMade = false; // a fresh throw may offer the re-roll decision again
    state.turnPhase =
      state.currentPlayer === PieceOwner.P2 ? TurnPhase.P1roll : TurnPhase.P2roll;
  }

  // ------------------------------------------------------------------ internals

  private applyLanding(
    state: GameState,
    piece: Piece,
    target: Place,
    current: PieceOwner,
    events: RuleEvent[],
  ): void {
    const indicesToRemove: number[] = [];
    let endedByCapture = false;

    for (let i = 0; i < target.pieces.length; ++i) {
      const other = target.pieces[i];
      if (other.owner === current) continue;

      const otherRules = this.rules.def(other.type);
      if (otherRules.recruitedWhenLanded) {
        other.owner = current;
        other.arc = this.arcForPiece(other);
        events.push(new RuleEvent(RuleEventKind.KingRecruited, other.type, current));
      } else if (otherRules.capturable) {
        indicesToRemove.push(i);
        if (otherRules.landingEndsGame) endedByCapture = true;
        events.push(
          new RuleEvent(
            otherRules.landingEndsGame ? RuleEventKind.QueenCaptured : RuleEventKind.SoldierCaptured,
            other.type,
            current,
          ),
        );

        // The capture counters score soldiers taken, and the host shows them as such.
        if (!otherRules.landingEndsGame) {
          if (current === PieceOwner.P1) state.p1Captures++;
          else state.p2Captures++;
        }
      }
    }

    if (indicesToRemove.length === 0) {
      events.push(new RuleEvent(RuleEventKind.PieceMoved, piece.type, current));
    }

    for (let i = indicesToRemove.length - 1; i >= 0; --i) {
      target.pieces.splice(indicesToRemove[i], 1);
    }

    if (indicesToRemove.length > 0) this.checkWinAfterCapture(state, current, endedByCapture, events);
  }

  private checkWinAfterCapture(
    state: GameState,
    current: PieceOwner,
    endedByCapture: boolean,
    events: RuleEvent[],
  ): void {
    const opponent = current === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1;

    if (endedByCapture) {
      endGame(state, current, WinReason.QueenCaptured, PieceType.Queen, events);
      return;
    }

    if (this.rules.win.opponentSoldiersExhausted && this.countSoldiers(state, opponent) === 0) {
      endGame(state, current, WinReason.OpponentSoldiersExhausted, PieceType.Soldier, events);
    }
  }

  private recruitNeutralKing(state: GameState, current: PieceOwner, events: RuleEvent[]): void {
    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (piece.type !== PieceType.King || piece.isActive) continue;
        piece.isActive = true;
        piece.owner = current;
        piece.arc = this.arcForPiece(piece);
        events.push(new RuleEvent(RuleEventKind.KingRecruited, piece.type, current));
      }
    }
  }

  /** Makes the piece one home-row line further back than the mover's source activatable. */
  private unlockNextInQueue(
    state: GameState,
    mover: Piece,
    current: PieceOwner,
    unlockOffset: number,
  ): void {
    const track = this.trackFor(current);
    const sourceOffset = track.arcOfPlaceInLeg(0, mover.placeIndex);
    if (sourceOffset < 0) return;

    const targetOffset = track.offsetOf(sourceOffset) + unlockOffset;
    if (targetOffset < 0 || targetOffset >= this.rules.board.width) return;

    const neighbour = track.placeOf(targetOffset);
    if (neighbour < 0 || neighbour >= state.places.length) return;
    if (state.places[neighbour].pieces.length === 0) return;
    state.places[neighbour].pieces[0].canBeActivated = true;
  }

  private countSoldiers(state: GameState, owner: PieceOwner): number {
    let count = 0;
    for (const place of state.places) {
      for (const piece of place.pieces) {
        if (piece.owner === owner && piece.type === PieceType.Soldier) count++;
      }
    }
    return count;
  }

  /** The arc a piece's current cell maps to on its owner's track (used when ownership changes). */
  private arcForPiece(piece: Piece): number {
    const arc = this.trackFor(piece.owner).firstArcOf(piece.placeIndex);
    if (arc < 0) {
      throw new RuleSetException(
        `Piece ${piece.id} stands on place ${piece.placeIndex}, which is not on the track.`,
      );
    }
    return arc;
  }

  /**
   * The arc a move onto `targetPlace` departs from, or -1 when the piece cannot reach that cell with
   * the die currently up for spending. Two arcs point at the same middle-row cell, so the arc — not
   * the cell — is what makes a move unambiguous.
   */
  private resolveTargetArc(state: GameState, piece: Piece, targetPlace: number): number {
    const track = this.trackFor(piece.owner);
    for (const arc of this.getAllowedArcs(state, piece)) {
      if (track.placeOf(arc) === targetPlace) return arc;
    }
    return -1;
  }

  private tryAddArc(
    state: GameState,
    track: BoardTrack,
    piece: Piece,
    arc: number,
    allowed: number[],
  ): void {
    const normalized = track.normalize(arc);
    const place = track.placeOf(normalized);
    if (place < 0) return;
    if (!this.canLandOn(state, piece, place)) return;
    if (!allowed.includes(normalized)) allowed.push(normalized);
  }

  private tryAddCrossing(
    state: GameState,
    track: BoardTrack,
    piece: Piece,
    x: number,
    row: number,
    allowed: number[],
  ): void {
    if (x < 0 || x >= this.rules.board.width) return;
    if (row < 0 || row >= this.rules.board.height) return;

    const place = BoardLayout.indexFromCoordinates(
      this.rules.board.width,
      this.rules.board.height,
      x,
      row,
    );
    if (place < 0) return;

    const arc = track.crossingArc(piece.arc, row, place);
    if (arc < 0) return;
    if (!this.canLandOn(state, piece, place)) return;
    if (!allowed.includes(arc)) allowed.push(arc);
  }

  private canLandOn(state: GameState, mover: Piece, place: number): boolean {
    const target = state.places[place];
    if (target.pieces.length === 0) return true;

    const top = target.pieces[0];
    if (!top.isActive) return this.rules.inactive.enterable;

    const ownUnit = top.owner === mover.owner;
    if (this.rules.def(top.type).blocksOwnLanding && ownUnit) return false;
    if (this.rules.def(mover.type).cannotLandOnOwnUnits && ownUnit) return false;
    return true;
  }

  private currentFace(state: GameState): DieFace {
    if (state.dice.length === 0) {
      throw new RuleSetException("The ruleset must declare at least one die.");
    }
    if (state.currentActiveDie < 0 || state.currentActiveDie >= state.dice.length) {
      throw new IllegalMoveException("The active die index is out of range.");
    }
    return state.dice[state.currentActiveDie];
  }

  private stepsFor(face: DieFace): number {
    return this.rules.faceRules(face).steps;
  }

  private faceFromIndex(index: number): DieFace {
    if (index < 0 || index >= this.rules.dice.faces.length) {
      throw new RuleSetException(`Die face index ${index} is out of range.`);
    }
    return this.resolveFace(this.rules.dice.faces[index].id);
  }

  private canRerollFace(face: DieFace): boolean {
    return this.rules.dice.reroll.faces.includes(RuleSet.faceId(face));
  }

  private resolveFace(id: string): DieFace {
    return this.rules.resolveFace(id);
  }

  private trackFor(owner: PieceOwner): BoardTrack {
    return owner === PieceOwner.P2 ? this.trackP2 : this.trackP1;
  }

  private buildPlaces(state: GameState): void {
    // Snake order, so that place index == indexFromCoordinates(place.x, place.y).
    for (let y = 0; y < this.rules.board.height; ++y) {
      for (let i = 0; i < this.rules.board.width; ++i) {
        const x = y % 2 === 1 ? this.rules.board.width - 1 - i : i;
        state.places.push(new Place(x, y));
      }
    }
  }

  private addSoldiers(
    state: GameState,
    owner: PieceOwner,
    placement: RowPlacement,
    nextId: number,
  ): number {
    for (let x = 0; x < this.rules.board.width; ++x) {
      const index = BoardLayout.indexFromCoordinates(
        this.rules.board.width,
        this.rules.board.height,
        x,
        placement.row,
      );
      state.places[index].pieces.push(new Piece(nextId++, index, PieceType.Soldier, owner));
    }
    return nextId;
  }

  private addPiece(
    state: GameState,
    placement: Placement,
    type: PieceType,
    owner: PieceOwner,
    nextId: number,
  ): number {
    const index = this.indexFromCoordinates(placement.x, placement.row);
    if (index < 0) throw new RuleSetException(`Piece '${PieceType[type]}' is placed off the board.`);
    state.places[index].pieces.push(new Piece(nextId++, index, type, owner));
    return nextId;
  }

  /**
   * Activates and advances the leading soldiers one step, foremost first, leaving the next soldier
   * in the home-row queue ready for activation.
   */
  private applyVariant(state: GameState, owner: PieceOwner, variant: VariantRules): void {
    const track = this.trackFor(owner);
    const homeRow = track.homeRow;

    const soldiers: Piece[] = [];
    const arcs: number[] = [];
    for (const place of state.places) {
      if (place.y !== homeRow) continue;
      for (const piece of place.pieces) {
        if (piece.owner !== owner || piece.type !== PieceType.Soldier) continue;
        const arc = track.arcOfPlaceInLeg(0, piece.placeIndex);
        if (arc < 0) continue;
        soldiers.push(piece);
        arcs.push(arc);
      }
    }

    // Foremost first: the soldier furthest along the home-row leg.
    for (let i = 0; i < soldiers.length; ++i) {
      for (let j = i + 1; j < soldiers.length; ++j) {
        if (arcs[j] > arcs[i]) {
          const arc = arcs[i];
          arcs[i] = arcs[j];
          arcs[j] = arc;
          const piece = soldiers[i];
          soldiers[i] = soldiers[j];
          soldiers[j] = piece;
        }
      }
    }

    for (let i = 0; i < soldiers.length; ++i) {
      const piece = soldiers[i];
      if (i < variant.soldiersActive) {
        const source = state.places[piece.placeIndex];
        source.pieces.splice(source.pieces.indexOf(piece), 1);
        piece.arc = track.normalize(arcs[i] + 1);
        piece.placeIndex = track.placeOf(piece.arc);
        piece.isActive = true;
        state.places[piece.placeIndex].pieces.push(piece);
      } else if (i === variant.soldiersActive) {
        piece.canBeActivated = true;
      }
    }
  }
}

// ------------------------------------------------------------------ module helpers

function sharesLineWithItsRecruiter(place: Place): boolean {
  // The ruleset's one exception: a piece that moved onto the king to recruit it stays on the king's
  // line until one of the two moves away.
  if (place.pieces.length !== 2) return false;
  const king = place.pieces[0];
  return king.type === PieceType.King && place.pieces[1].owner === king.owner;
}

function endGame(
  state: GameState,
  winner: PieceOwner,
  reason: WinReason,
  lastPieceType: PieceType,
  events: RuleEvent[],
): void {
  state.gameOver = true;
  state.winner = winner;
  state.winReason = reason;
  events.push(new RuleEvent(RuleEventKind.GameWon, lastPieceType, winner, winner));
}

export function resolveOwner(owner: string): PieceOwner {
  if (owner === "P1") return PieceOwner.P1;
  if (owner === "P2") return PieceOwner.P2;
  if (owner === "neutral" || owner === "none") return PieceOwner.None;
  throw new RuleSetException(`Unknown piece owner '${owner}'.`);
}
