/**
 * The interactive match controller: the bridge between clicks (or bots) and the pure `RulesEngine`.
 *
 * The controller owns the match loop — roll, offer the optional re-roll, play out the moves, notice
 * the end of the game — and exposes the result as a plain `MatchViewModel` snapshot. It contains no
 * rendering code and touches no DOM type, so the whole interaction model can be exercised headlessly
 * by the test suite while the browser layer (`board.ts`, `dice.ts`, `main.ts`) only has to paint the
 * snapshot it is handed.
 *
 * Two invariants shape every method here:
 *
 * 1. **The engine stays the sole authority.** Legal actions are read from
 *    `RulesEngine.evaluateAllowedPlaces` / `legalMoves`, and a move is committed only after
 *    `RulesEngine.isLegalMove` confirmed it. A click on an illegal cell is dropped silently — the UI
 *    must never be able to corrupt the board.
 * 2. **The controller never advances the turn by itself.** Handing over is a rules decision, so it
 *    only ever happens inside `RulesEngine.applyMove`, `nextPlayerTurn` or
 *    `applyRerollDecision`. The controller mirrors whatever the engine decided.
 *
 * Four collaborators are injected rather than reached for, which is what keeps the class testable:
 *
 * - the **translator** (`../locale/i18n`) owns every string the snapshot carries, so switching language
 *   is a `setTranslator` call followed by a repaint;
 * - the **sound player** (`../audio/audio`) receives one cue per committed action, derived from the
 *   engine's own `RuleEvent`s;
 * - the **seats** (`humanPlayers`) say which owners may act on this device, so a bot's turn cannot be
 *   played by a stray click — and a bot cannot be stalled by one either;
 * - the **bot driver** ({@link BotDriver}, below) plays the automated seats through this class's
 *   `*Automated` actions, which are the same engine calls, gated to the other kind of seat.
 */

import { HeuristicPlayerAgent } from "../agents/heuristic";
import { LlmPlayerAgent, type LlmConfig, type LlmTransport } from "../agents/llm";
import { RandomPlayerAgent } from "../agents/random";
import type { BotRandomSource, PlayerAgent } from "../agents/types";
import type { SoundName, SoundPlayer } from "../audio/audio";
import { defaultTranslate, type Translator } from "../locale/i18n";
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
  WinReason,
  type GameState,
  type IRandomSource,
} from "../rules/domain";
import type { RulesEngine } from "../rules/engine";
import { ownerNameKey, pieceNameKey } from "./pieces";

// ---------------------------------------------------------------------------------- match setup

/** The three ways a match can be seated. */
export const GameModes = {
  /** A local human (the Women) against one bot. */
  humanVsBot: "human_vs_bot",

  /** Two local humans sharing the device. */
  hotseat2p: "hotseat_2p",

  /** Spectator match between two bots. */
  botVsBot: "bot_vs_bot",
} as const;

export type GameMode = (typeof GameModes)[keyof typeof GameModes];

/** The bots a seat can be given. `human` is not here: that is what the seat list expresses. */
export const BotKinds = ["heuristic", "random", "llm"] as const;

export type BotKind = (typeof BotKinds)[number];

/** How fast a bot seat acts, which is what paces a spectator match. */
export const BotSpeeds = ["slow", "normal", "fast"] as const;

export type BotSpeed = (typeof BotSpeeds)[number];

/** The pause before a bot acts, per speed. Fast is a pace, not an instant: the board stays readable. */
export const BotThinkDelayMs: Record<BotSpeed, number> = {
  slow: 1100,
  normal: 520,
  fast: 140,
};

/** The loose-soldier variant, mapped onto the engine's single `evenOdds` flag. */
export const Variants = ["standard", "evenOdds"] as const;

export type VariantChoice = (typeof Variants)[number];

/** Who moves first. `throw` defers to the ruleset's own throw-for-the-start. */
export const StartingPlayers = ["throw", "P1", "P2"] as const;

export type StartingPlayerChoice = (typeof StartingPlayers)[number];

/** Everything the toolbar decides before a match starts. */
export interface MatchSetup {
  mode: GameMode;

  /** The bot seated for each side when that side is automated. */
  bots: { p1: BotKind; p2: BotKind };

  /** The pace of the automated seats. */
  speed: BotSpeed;

  variant: VariantChoice;

  startingPlayer: StartingPlayerChoice;
}

/** The shipped setup: single player against the deterministic bot, even odds, throwing for the start. */
export const DefaultMatchSetup: MatchSetup = {
  mode: GameModes.humanVsBot,
  bots: { p1: "heuristic", p2: "heuristic" },
  speed: "normal",
  variant: "evenOdds",
  startingPlayer: "throw",
};

/** True for every valid mode, bot kind, speed, variant and starter — used to validate UI input. */
export function isGameMode(value: unknown): value is GameMode {
  return typeof value === "string" && Object.values(GameModes).includes(value as GameMode);
}

export function isBotKind(value: unknown): value is BotKind {
  return typeof value === "string" && (BotKinds as readonly string[]).includes(value);
}

export function isBotSpeed(value: unknown): value is BotSpeed {
  return typeof value === "string" && (BotSpeeds as readonly string[]).includes(value);
}

export function isVariantChoice(value: unknown): value is VariantChoice {
  return typeof value === "string" && (Variants as readonly string[]).includes(value);
}

export function isStartingPlayerChoice(value: unknown): value is StartingPlayerChoice {
  return typeof value === "string" && (StartingPlayers as readonly string[]).includes(value);
}

/** Is the side automated under this setup? The mirror of {@link agentsForSetup}. */
export function isBotSeat(setup: MatchSetup, owner: PieceOwner): boolean {
  switch (setup.mode) {
    case GameModes.botVsBot:
      return true;
    case GameModes.humanVsBot:
      return owner === PieceOwner.P2;
    default:
      return false;
  }
}

/** The owners a human plays on this device under this setup: everything that is not a bot seat. */
export function humanSeatsFor(setup: MatchSetup): PieceOwner[] {
  const seats: PieceOwner[] = [];
  for (const owner of [PieceOwner.P1, PieceOwner.P2]) {
    if (!isBotSeat(setup, owner)) seats.push(owner);
  }
  return seats;
}

/** The engine options a setup implies: the variant, and either a fixed starter or a throw for it. */
export function engineOptionsFor(setup: MatchSetup): EngineOptions {
  const startingPlayer = setup.startingPlayer === "P2" ? PieceOwner.P2 : PieceOwner.P1;
  return new EngineOptions(startingPlayer, setup.variant === "evenOdds", setup.startingPlayer === "throw");
}

/** The bot kind seated for `owner` under this setup. */
export function botKindFor(setup: MatchSetup, owner: PieceOwner): BotKind {
  return owner === PieceOwner.P1 ? setup.bots.p1 : setup.bots.p2;
}

export interface BotAgentDeps {
  /** Randomness, used by the random bot's own draws. The engine keeps its own source. */
  random?: BotRandomSource | null;

  /** The LLM transport. With `null` the LLM seat answers heuristically instead of failing. */
  transport?: LlmTransport | null;

  /** Endpoint, model and request budget for the LLM seat. */
  llmConfig?: LlmConfig | null;

  /** Where the agent's own log lines go (decisions, fallbacks). */
  log?: ((message: string) => void) | null;
}

/**
 * Builds the agent of one automated seat. Total: an unknown kind yields the heuristic, so a corrupt
 * setting can never leave a seat empty (which would stall the match instead of losing it gracefully).
 */
export function createBotAgent(
  kind: BotKind,
  owner: PieceOwner,
  engine: RulesEngine,
  deps: BotAgentDeps = {},
): PlayerAgent {
  switch (kind) {
    case "random":
      return new RandomPlayerAgent(owner, null, deps.random ?? null);
    case "llm":
      return new LlmPlayerAgent(
        owner,
        null,
        deps.transport ?? null,
        deps.llmConfig ?? null,
        engine,
        deps.log ?? null,
      );
    default:
      return new HeuristicPlayerAgent(owner, null, engine);
  }
}

// ---------------------------------------------------------------------------------- view model

/** One piece as the board should draw it. */
export interface PieceTokenView {
  id: number;
  type: PieceType;
  owner: PieceOwner;

  /** Activated pieces are drawn raised and bright. */
  isActive: boolean;

  /** Seated in the home row but unlocked; the next click may activate it. */
  canBeActivated: boolean;

  /** Belongs to the player to move and has at least one legal destination. */
  selectable: boolean;

  selected: boolean;
}

/** One board cell with the pieces standing on it. */
export interface CellView {
  placeIndex: number;
  x: number;
  y: number;

  /** A legal destination of the currently selected piece. */
  highlight: boolean;

  /** Bottom to top; `pieces[0]` is the piece the engine treats as the top of a stack. */
  pieces: PieceTokenView[];
}

export interface DieView {
  index: number;
  face: DieFace;

  /** Already spent this throw. */
  spent: boolean;

  /** The die up for spending right now. */
  active: boolean;
}

export interface DiceViewState {
  /** False while the dice are still to be thrown this turn. */
  rolled: boolean;

  currentActiveDie: number;
  dice: DieView[];

  /** The Roll Dice button is live. */
  canRoll: boolean;

  /** The Reroll Die / Keep & Move decision is on offer. */
  canReroll: boolean;

  /** Human-readable spending-order progress. */
  orderText: string;

  /** Button captions, already localized by the controller so the tray stays a dumb view. */
  rollLabel: string;
  rerollLabel: string;
  keepLabel: string;
}

export interface GameOverView {
  winner: PieceOwner;
  winnerLabel: string;
  reason: WinReason;
  reasonLabel: string;
}

/** Everything the presentation layer needs to draw one frame. */
export interface MatchViewModel {
  boardWidth: number;
  boardHeight: number;
  cells: CellView[];

  turnPhase: TurnPhase;
  currentPlayer: PieceOwner;
  currentPlayerLabel: string;
  phase: "roll" | "move" | "gameover";
  statusText: string;

  /**
   * True when the player to move is seated at this device. False means an automated seat is (or is
   * about to be) acting: the board offers no selectable pieces and the tray no buttons, so a stray
   * click cannot play a bot's turn.
   */
  humanTurn: boolean;

  dice: DiceViewState;
  captures: { p1: number; p2: number };

  selectedPieceId: number | null;
  selectablePieceIds: number[];
  highlightedPlaces: number[];

  /** The events of the last committed action, for the banner. */
  events: RuleEvent[];
  eventMessages: string[];

  gameOver: GameOverView | null;
}

export type MatchListener = (view: MatchViewModel) => void;

// ---------------------------------------------------------------------------------- controller

/** The collaborators the presentation layer injects, all optional and all replaceable at runtime. */
export interface MatchControllerInit {
  /**
   * The owners a local human plays. Everything else is an automated seat the {@link BotDriver} owns.
   * Defaults to both, i.e. a hotseat table, which is what the headless tests want.
   */
  humanPlayers?: readonly PieceOwner[];

  /** Where committed actions send their cue. `null` (the default) keeps the match silent. */
  sounds?: SoundPlayer | null;

  /** Owns every string in the snapshot. Defaults to English. */
  translate?: Translator;
}

export class WebMatchController {
  private readonly engine: RulesEngine;
  private readonly random: IRandomSource;

  private options: EngineOptions;
  private game: GameState;
  private selected: number | null = null;
  private lastEvents: RuleEvent[] = [];
  private readonly listeners = new Set<MatchListener>();

  private readonly sounds: SoundPlayer | null;
  private translator: Translator;
  private humanPlayers: Set<PieceOwner>;

  /**
   * @param state An already-built state to sit on. Omitted by the browser client, which lets the
   *   engine deal a fresh game; the tests pass a hand-built position.
   * @param init The injected collaborators: seats, sound and language (see {@link MatchControllerInit}).
   */
  constructor(
    engine: RulesEngine,
    random: IRandomSource,
    options: EngineOptions,
    state?: GameState,
    init: MatchControllerInit = {},
  ) {
    this.engine = engine;
    this.random = random;
    this.options = options;
    this.game = state ?? engine.initGame(options, random);
    this.sounds = init.sounds ?? null;
    this.translator = init.translate ?? defaultTranslate;
    this.humanPlayers = new Set(init.humanPlayers ?? [PieceOwner.P1, PieceOwner.P2]);
    this.syncDerived();
  }

  // ------------------------------------------------------------------ read-only surface

  /** The live state. Read it; never mutate it — every change goes through the engine. */
  get state(): GameState {
    return this.game;
  }

  /** The Roll Dice button is live. */
  get canRoll(): boolean {
    return !this.game.gameOver && this.game.isRollPhase;
  }

  /** The owners a local human plays on this device. */
  get seats(): PieceOwner[] {
    return [...this.humanPlayers];
  }

  /** True when the player to move is seated at this device. */
  get awaitsHuman(): boolean {
    return this.humanPlayers.has(this.game.currentPlayer);
  }

  /** True when the human actions below will be accepted right now. */
  get canHumanAct(): boolean {
    return !this.game.gameOver && this.humanPlayers.has(this.game.currentPlayer);
  }

  get selectedPieceId(): number | null {
    return this.selected;
  }

  /** Legal destinations of the selected piece, as board cell indices. */
  get highlightedPlaces(): number[] {
    const piece = this.selected == null ? null : this.engine.findPiece(this.game, this.selected);
    return piece == null ? [] : [...piece.allowedPlaces];
  }

  /** Every legal action for the player to move, computed from scratch by the engine. */
  get legalMoves(): Move[] {
    return this.engine.legalMoves(this.game);
  }

  /**
   * A fresh snapshot for the presentation layer. Reading it re-derives the board's legal-move cache
   * (`Piece.allowedPlaces`) and drops a selection that the engine no longer allows; it never changes
   * the turn or the board itself.
   */
  get viewModel(): MatchViewModel {
    this.syncDerived();
    return this.buildViewModel();
  }

  /** Registers a listener for state changes; returns the unsubscribe function. */
  subscribe(listener: MatchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ------------------------------------------------------------------ collaborators

  /** Swaps the localizer and repaints, so every string on screen follows the new language. */
  setTranslator(translator: Translator): void {
    this.translator = translator;
    this.publish();
  }

  /** Replaces the owners a local human plays. Does not deal a new match. */
  setHumanPlayers(owners: readonly PieceOwner[]): void {
    this.humanPlayers = new Set(owners.filter((owner) => owner !== PieceOwner.None));
    this.publish();
  }

  /** Recomputes the derived caches and re-notifies every listener without touching the match. */
  refresh(): void {
    this.publish();
  }

  // ------------------------------------------------------------------ match loop

  /**
   * Throws the three dice. Returns false when it is not the local human's roll phase — a bot's turn, a
   * finished match, or a turn that was already thrown. A bot throws through {@link rollAutomated}.
   */
  roll(): boolean {
    return this.rollFor(true);
  }

  /** The bot driver's throw: the identical engine call, legal only for an automated seat. */
  rollAutomated(): boolean {
    return this.rollFor(false);
  }

  /** Throws the die that is up for spending again. Only legal while `canReroll`. */
  rerollActiveDie(): boolean {
    return this.decideReroll(RerollDecision.RerollActiveDie);
  }

  /** Keeps the throw as it fell and continues to the moves. Always legal in a move phase. */
  keepDice(): boolean {
    return this.decideReroll(RerollDecision.KeepDiceAndProceed);
  }

  /**
   * Applies the local human's answer to the re-roll that is on offer. Re-rolling is refused unless the
   * ruleset allows it, so a stray click can never reopen a closed decision.
   */
  decideReroll(decision: RerollDecision): boolean {
    return this.decideRerollFor(decision, true);
  }

  /** The bot driver's re-roll answer: the identical engine call, legal only for an automated seat. */
  decideRerollAutomated(decision: RerollDecision): boolean {
    return this.decideRerollFor(decision, false);
  }

  // ------------------------------------------------------------------ piece selection

  /**
   * Selects a selectable piece of the human player to move. Returns false for anything else — a bot's
   * turn included, so a click during the NPC's move cannot pick up its pieces.
   */
  selectPiece(pieceId: number): boolean {
    if (!this.accepts(true)) return false;
    if (this.game.isRollPhase) return false;

    const piece = this.engine.findPiece(this.game, pieceId);
    if (piece == null) return false;
    if (piece.owner !== this.game.currentPlayer) return false;
    if (!piece.isSelectable()) return false;

    this.selected = pieceId;
    this.sounds?.play("select");
    this.publish();
    return true;
  }

  /** Drops the current selection, if any. */
  clearSelection(): void {
    if (this.selected == null) return;
    this.selected = null;
    this.publish();
  }

  /**
   * Handles a click on a board cell: it commits the selected piece's move when the cell is one of its
   * legal destinations, cycles through selectable pieces sharing a cell, and otherwise cancels the
   * selection. Clicks that mean nothing are ignored without touching the state.
   */
  handlePlaceClick(placeIndex: number): boolean {
    if (!this.accepts(true)) return false;
    if (this.game.isRollPhase) return false;
    if (placeIndex < 0 || placeIndex >= this.game.places.length) return false;

    const selected = this.selected == null ? null : this.engine.findPiece(this.game, this.selected);
    if (selected != null && selected.allowedPlaces.includes(placeIndex)) {
      return this.commitMove(new Move(selected.id, placeIndex));
    }

    const cell = this.game.places[placeIndex];
    const mine = cell.pieces.filter(
      (piece) => piece.owner === this.game.currentPlayer && piece.isSelectable(),
    );
    if (mine.length > 0) {
      const currentIndex = mine.findIndex((piece) => piece.id === this.selected);
      return this.selectPiece(mine[(currentIndex + 1) % mine.length].id);
    }

    if (this.selected != null) {
      this.selected = null;
      this.publish();
      return true;
    }
    return false;
  }

  /**
   * Commits a move the engine confirmed to be legal; an illegal proposal is dropped without touching
   * the board. The local human's entry point — the bot driver uses {@link commitMoveAutomated}.
   */
  commitMove(move: Move): boolean {
    return this.commitMoveFor(move, true);
  }

  /** The bot driver's move: the identical legality check, legal only for an automated seat. */
  commitMoveAutomated(move: Move): boolean {
    return this.commitMoveFor(move, false);
  }

  /** Deals a fresh game with the same options and clears every decision. */
  resetMatch(): void {
    this.restart();
  }

  /**
   * Deals a fresh game, optionally under different engine options — which is how the toolbar's variant
   * and starting-player choices reach the engine. The bots and the language are untouched.
   */
  restart(options?: EngineOptions): void {
    if (options != null) this.options = options;
    this.game = this.engine.initGame(this.options, this.random);
    this.selected = null;
    this.lastEvents = [];
    this.publish();
  }

  // ------------------------------------------------------------------ action cores

  /** True when an action from this kind of seat is allowed in the current state. */
  private accepts(human: boolean): boolean {
    if (this.game.gameOver) return false;
    return this.humanPlayers.has(this.game.currentPlayer) === human;
  }

  private rollFor(human: boolean): boolean {
    if (!this.accepts(human) || !this.game.isRollPhase) return false;

    this.engine.rollDice(this.game, this.random);
    this.selected = null;
    this.lastEvents = [];

    // A sáhkku on the table opens the optional re-throw; anything else goes straight to the moves.
    if (!this.engine.canReroll(this.game)) this.beginMovePhase();

    this.sounds?.play("roll");
    this.publish();
    return true;
  }

  private decideRerollFor(decision: RerollDecision, human: boolean): boolean {
    if (!this.accepts(human) || this.game.isRollPhase) return false;
    if (decision === RerollDecision.RerollActiveDie && !this.engine.canReroll(this.game)) {
      return false;
    }

    this.engine.applyRerollDecision(
      this.game,
      decision,
      decision === RerollDecision.RerollActiveDie ? this.random : null,
    );
    this.selected = null;

    // A re-throw can produce another sáhkku, which reopens the decision; keeping the dice does not.
    if (!this.engine.canReroll(this.game)) this.beginMovePhase();

    this.publish();
    return true;
  }

  private commitMoveFor(move: Move, human: boolean): boolean {
    if (!this.accepts(human) || this.game.isRollPhase) return false;
    if (!this.engine.isLegalMove(this.game, move)) return false;

    this.lastEvents = this.engine.applyMove(this.game, move);
    this.selected = null;
    this.playEventSounds(this.lastEvents);
    this.publish();
    return true;
  }

  /**
   * Turns the engine's own side effects into one cue per action. A move can emit several events (a
   * capture is also a move), so the most decisive one wins rather than layering every sound at once.
   */
  private playEventSounds(events: readonly RuleEvent[]): void {
    if (this.sounds == null) return;
    const sound = soundForEvents(events);
    if (sound != null) this.sounds.play(sound);
  }

  // ------------------------------------------------------------------ internals

  private publish(): void {
    this.syncDerived();
    const view = this.buildViewModel();
    // Copy the set: a listener is allowed to unsubscribe while it is being notified.
    for (const listener of [...this.listeners]) listener(view);
  }

  /**
   * Refreshes the facts only the engine can compute: the legal-move cache for the player to move and
   * the validity of the current selection. Idempotent, and deliberately unable to hand the turn over
   * — that stays a rules decision.
   */
  private syncDerived(): void {
    if (this.game.gameOver) {
      this.selected = null;
      return;
    }
    if (!this.game.isRollPhase) this.engine.evaluateAllowedPlaces(this.game);

    if (this.selected == null) return;
    const piece = this.engine.findPiece(this.game, this.selected);
    if (piece == null || piece.owner !== this.game.currentPlayer || !piece.isSelectable()) {
      this.selected = null;
    }
  }

  /** Opens the move phase once the dice are settled, handing over when nothing can be spent. */
  private beginMovePhase(): void {
    if (this.game.gameOver || this.game.isRollPhase) return;
    if (!this.engine.evaluateAllowedPlaces(this.game)) this.engine.nextPlayerTurn(this.game);
  }

  private buildViewModel(): MatchViewModel {
    const state = this.game;
    const t = this.translator;
    const selected = this.selected == null ? null : this.engine.findPiece(this.game, this.selected);
    const highlightedPlaces = selected == null ? [] : [...selected.allowedPlaces];
    const current = state.currentPlayer;

    // A bot's turn is not the human's to play: no piece is offered and no button is live.
    const humanTurn = !state.gameOver && this.humanPlayers.has(current);

    const cells: CellView[] = state.places.map((place, index) => ({
      placeIndex: index,
      x: place.x,
      y: place.y,
      highlight: highlightedPlaces.includes(index),
      pieces: place.pieces.map((piece) => ({
        id: piece.id,
        type: piece.type,
        owner: piece.owner,
        isActive: piece.isActive,
        canBeActivated: piece.canBeActivated,
        selectable: humanTurn && piece.owner === current && piece.isSelectable(),
        selected: piece.id === this.selected,
      })),
    }));

    const selectablePieceIds: number[] = [];
    for (const cell of cells) {
      for (const piece of cell.pieces) {
        if (piece.selectable) selectablePieceIds.push(piece.id);
      }
    }

    const rolled = !state.isRollPhase;
    const canReroll = this.engine.canReroll(state) && humanTurn;
    const dice: DieView[] = state.dice.map((face, index) => ({
      index,
      face,
      spent: rolled && index < state.currentActiveDie,
      active: rolled && !state.gameOver && index === state.currentActiveDie,
    }));

    return {
      boardWidth: this.engine.rules.board.width,
      boardHeight: this.engine.rules.board.height,
      cells,
      turnPhase: state.turnPhase,
      currentPlayer: current,
      currentPlayerLabel: t(ownerNameKey(current)),
      phase: state.gameOver ? "gameover" : state.isRollPhase ? "roll" : "move",
      statusText: this.statusText(state, selected),
      humanTurn,
      dice: {
        rolled,
        currentActiveDie: state.currentActiveDie,
        dice,
        canRoll: this.canRoll && humanTurn,
        canReroll,
        orderText: this.diceOrderText(state, rolled),
        rollLabel: t("dice.roll"),
        rerollLabel: t("dice.reroll"),
        keepLabel: t("dice.keep"),
      },
      captures: { p1: state.p1Captures, p2: state.p2Captures },
      selectedPieceId: this.selected,
      selectablePieceIds,
      highlightedPlaces,
      events: [...this.lastEvents],
      eventMessages: this.lastEvents.map((event) => this.describeEvent(event)),
      gameOver: state.gameOver
        ? {
            winner: state.winner,
            winnerLabel: t(ownerNameKey(state.winner)),
            reason: state.winReason,
            reasonLabel: this.winReasonLabel(state.winReason),
          }
        : null,
    };
  }

  private statusText(state: GameState, selected: { type: PieceType; owner: PieceOwner } | null): string {
    const t = this.translator;

    if (state.gameOver) {
      return t("status.gameOver", {
        player: t(ownerNameKey(state.winner)),
        reason: this.winReasonLabel(state.winReason),
      });
    }

    const who = t(ownerNameKey(state.currentPlayer));

    // The bot's seat reports what it is doing rather than inviting a click it would refuse.
    if (!this.humanPlayers.has(state.currentPlayer)) return t("status.thinking", { player: who });

    if (state.isRollPhase) return t("status.rollPrompt", { player: who });
    if (this.engine.canReroll(state)) {
      // Which faces may be re-thrown is the ruleset's call, so the hint names them from there.
      const faces = this.engine.rules.dice.reroll.faces.join(" / ");
      return t("status.rerollPrompt", { player: who, faces });
    }
    if (selected != null) {
      return t("status.pieceSelected", {
        player: who,
        piece: t(pieceNameKey(selected.type, selected.owner)),
      });
    }
    return t("status.selectPiece", {
      player: who,
      die: state.currentActiveDie + 1,
      total: state.dice.length,
    });
  }

  /** One committed event as a banner line: "P1 · Women captured a soldier". */
  private describeEvent(event: RuleEvent): string {
    const t = this.translator;
    const who = t(ownerNameKey(event.owner));

    switch (event.kind) {
      case RuleEventKind.PieceMoved:
        return `${who} ${t("events.pieceMoved")}`;
      case RuleEventKind.SoldierCaptured:
        return `${who} ${t("events.soldierCaptured")}`;
      case RuleEventKind.KingRecruited:
        return `${who} ${t("events.kingRecruited")}`;
      case RuleEventKind.QueenCaptured:
        return `${who} ${t("events.queenCaptured")}`;
      case RuleEventKind.GameWon:
        return t("events.gameWon", { player: t(ownerNameKey(event.winner)) });
      default:
        return `${who} ${t("events.acted")}`;
    }
  }

  private winReasonLabel(reason: WinReason): string {
    switch (reason) {
      case WinReason.OpponentSoldiersExhausted:
        return this.translator("win.reason.soldiersExhausted");
      case WinReason.QueenCaptured:
        return this.translator("win.reason.queenCaptured");
      default:
        return this.translator("win.reason.none");
    }
  }

  private diceOrderText(state: GameState, rolled: boolean): string {
    if (state.gameOver) return this.translator("status.matchOver");
    if (!rolled) return this.translator("status.diceUnrolled");
    return this.translator("status.diceOrder", {
      die: state.currentActiveDie + 1,
      total: state.dice.length,
    });
  }
}

// ---------------------------------------------------------------------------------- helpers

/**
 * Which cue an action's events map onto, most decisive first. A capture is also a move, so choosing one
 * entry from this list keeps a single action down to a single sound.
 *
 * Exported because it is the whole mapping between the rules engine's side effects and the audio: a test
 * can pin every kind without having to play the position that produces it.
 */
const EventSoundPriority: ReadonlyArray<readonly [RuleEventKind, SoundName]> = [
  [RuleEventKind.GameWon, "victory"],
  [RuleEventKind.QueenCaptured, "capture"],
  [RuleEventKind.KingRecruited, "recruit"],
  [RuleEventKind.SoldierCaptured, "capture"],
  [RuleEventKind.PieceMoved, "move"],
];

/** The one cue a committed action's events deserve, or `null` when nothing about it is audible. */
export function soundForEvents(events: readonly RuleEvent[]): SoundName | null {
  for (const [kind, sound] of EventSoundPriority) {
    if (events.some((event) => event.kind === kind)) return sound;
  }
  return null;
}

// ---------------------------------------------------------------------------------- bot driver

export interface BotDriverInit {
  /** Pause before an automated seat acts (see {@link BotThinkDelayMs}). */
  thinkDelayMs?: number;
}

/**
 * Plays the automated seats.
 *
 * The driver owns no rule and no board: it asks each bot's `PlayerAgent` for a decision and hands the
 * answer to the controller's `*Automated` actions, which check it against the engine exactly like a
 * human click would. That asymmetry is deliberate — a misbehaving bot can lose a turn, but it can never
 * corrupt the position, and a human click can never play a bot's turn.
 *
 * One action is taken per step, with a configurable pause, so a spectator match stays watchable and the
 * board paints between decisions. `step()` is public and awaitable, which is what lets the tests drive a
 * whole bot match deterministically (with `thinkDelayMs: 0`) instead of waiting on wall-clock time.
 */
export class BotDriver {
  private readonly controller: WebMatchController;
  private readonly engine: RulesEngine;
  private readonly agents = new Map<PieceOwner, PlayerAgent>();

  private thinkDelay = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private abort: AbortController | null = null;
  private busy = false;

  /**
   * Bumped by `stop()`, so a decision that was already in flight when the driver was stopped can
   * recognise that its answer belongs to a cancelled driver and must be dropped.
   */
  private generation = 0;

  constructor(controller: WebMatchController, engine: RulesEngine, init: BotDriverInit = {}) {
    this.controller = controller;
    this.engine = engine;
    this.thinkDelay = Math.max(0, init.thinkDelayMs ?? 0);
  }

  /** True while the driver follows the controller's state changes. */
  get running(): boolean {
    return this.unsubscribe != null;
  }

  /** The agent seated for one owner, or `null` when that seat is a human's. */
  agentFor(owner: PieceOwner): PlayerAgent | null {
    return this.agents.get(owner) ?? null;
  }

  /** Replaces both seats at once — a mode change or a new match — and schedules a step. */
  setAgents(agents: Partial<Record<PieceOwner, PlayerAgent | null>>): void {
    for (const owner of [PieceOwner.P1, PieceOwner.P2]) {
      const agent = agents[owner] ?? null;
      if (agent == null) this.agents.delete(owner);
      else this.agents.set(owner, agent);
    }
    this.schedule();
  }

  /** Sets the pause between two actions, in milliseconds. */
  setThinkDelay(milliseconds: number): void {
    this.thinkDelay = Math.max(0, milliseconds);
  }

  /** Starts following the controller and schedules the first step. Idempotent. */
  start(): void {
    if (this.unsubscribe != null) return;

    this.abort = new AbortController();
    this.unsubscribe = this.controller.subscribe(() => this.schedule());
    this.schedule();
  }

  /** Stops following, cancels a pending action and aborts a decision that is already in flight. */
  stop(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    unsubscribe?.();
    this.generation++;

    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
  }

  /**
   * Takes one action for the seat to move, if that seat is automated, and reports whether anything
   * happened. Never throws: a bot that rejects a decision is treated as passing, so a broken endpoint
   * cannot freeze the table.
   *
   * Callable without `start()`, which is how the tests play a whole match deterministically instead of
   * waiting on timers; `start()` only adds the scheduling.
   */
  async step(): Promise<boolean> {
    if (this.busy) return false;

    const state = this.controller.state;
    if (state.gameOver) return false;

    const agent = this.agents.get(state.currentPlayer);
    if (agent == null) return false;

    const generation = this.generation;
    this.busy = true;
    try {
      if (state.isRollPhase) return this.controller.rollAutomated();

      if (this.engine.canReroll(state)) {
        let decision = RerollDecision.KeepDiceAndProceed;
        try {
          decision = await agent.decideReroll(state, this.abort?.signal);
        } catch {
          decision = RerollDecision.KeepDiceAndProceed;
        }
        // The match may have been restarted (or the driver stopped) while the agent was thinking.
        if (!this.isCurrent(state, generation)) return false;
        return this.controller.decideRerollAutomated(decision);
      }

      const legalMoves = this.engine.legalMoves(state);
      if (legalMoves.length === 0) {
        // A hand-built position can leave the move phase with nothing to play; hand over, as the
        // engine would have done after the last committed move.
        this.engine.nextPlayerTurn(state);
        this.controller.refresh();
        return true;
      }

      let move: Move | null = null;
      try {
        move = await agent.decideMove(state, legalMoves, this.abort?.signal);
      } catch {
        move = null;
      }
      if (!this.isCurrent(state, generation)) return false;

      // A proposal outside the legal list is dropped rather than applied; the engine is the authority
      // and the match has to go on, so the first legal move stands in for the bot that misfired.
      const chosen = move != null && this.engine.isLegalMove(state, move) ? move : legalMoves[0]!;
      return this.controller.commitMoveAutomated(chosen);
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------ internals

  /**
   * True while the decision still belongs to the match it was asked about: nobody dealt a new game (the
   * controller replaces its state) and nobody stopped the driver (the generation moved on).
   */
  private isCurrent(state: GameState, generation: number): boolean {
    return generation === this.generation && this.controller.state === state;
  }

  /** Arms the next step, once, whenever an automated seat is to move. */
  private schedule(): void {
    if (this.unsubscribe == null || this.timer != null || this.busy) return;

    const state = this.controller.state;
    if (state.gameOver || !this.agents.has(state.currentPlayer)) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.step().then(
        () => this.schedule(),
        () => this.schedule(),
      );
    }, this.thinkDelay);
  }
}
