/**
 * Application entry point: wires the pure `RulesEngine` to the 2D presentation layer.
 *
 * The composition is deliberately thin, and everything it wires is injectable:
 *
 * - **the match** — a `WebMatchController` that owns the rules-legal interaction model and a
 *   `BotDriver` that plays whichever seats are not local humans;
 * - **the language** — one `I18n`, handed to every view that renders text, so a switch re-letters the
 *   whole client (toolbar, board, tray, legend, dialogs) and is persisted in the settings store;
 * - **the sound** — one `AudioManager`, given to the controller as its `SoundPlayer`, unlocked by the
 *   first real user gesture as the autoplay policy requires;
 * - **the preferences** — a `SettingsStore` behind the LLM endpoint/model/timeout fields and the two
 *   volume sliders, read back on the next start so the NPC seat is configured the way the player left it.
 *
 * The board opens as a preview. Only Start game deals a match and throws for the starting player.
 */

import { FetchLlmTransport, type LlmConfig, type LlmTransport } from "./agents/llm";
import type { BotRandomSource, PlayerAgent } from "./agents/types";
import { AudioManager } from "./audio/audio";
import { I18n, type Locale, type Translator } from "./locale/i18n";
import { EngineOptions, PieceOwner, PieceType, RerollDecision, type IRandomSource } from "./rules/domain";
import { RulesEngine } from "./rules/engine";
import { loadShippedRuleset } from "./rules/ruleset";
import { BoardView } from "./ui/board";
import { browserSearch } from "./agents/browser-search";
import {
  BotDriver,
  BotKinds,
  BotSpeeds,
  BotThinkDelayMs,
  DefaultMatchSetup,
  GameModes,
  StartingPlayers,
  Variants,
  WebMatchController,
  botKindFor,
  createBotAgent,
  engineOptionsFor,
  humanSeatsFor,
  isBotKind,
  isBotSeat,
  isBotSpeed,
  isGameMode,
  isStartingPlayerChoice,
  isVariantChoice,
  type BotKind,
  type GameMode,
  type GameOverView,
  type MatchSetup,
  type MatchViewModel,
  type StartingPlayerChoice,
  type VariantChoice,
} from "./ui/controller";
import { DiceView } from "./ui/dice";
import { HelpModal } from "./ui/help";
import { PieceRenderer } from "./ui/pieces";
import { SettingsModal, SettingsStore, llmConfigFrom, type SahkkuSettings } from "./ui/settings";

/** How long a rule-event banner stays on screen. */
const BANNER_TIMEOUT_MS = 5200;

/** How long a notice (an NPC that fell back to the heuristic) stays on screen. */
const NOTICE_TIMEOUT_MS = 9000;

const VICTORY_REVEAL_MS = 1800;

/**
 * Draws the die faces the way the engine's `IRandomSource` contract asks: uniform indices into the
 * ruleset's own face table, so the client never assumes a face count or an ordering of its own.
 *
 * It also answers the bots' own `BotRandomSource` draws, which keeps one source of chance for the whole
 * match — the dice and the random bot's pick cannot be handed different luck by accident.
 */
class UniformRandomSource implements IRandomSource, BotRandomSource {
  private readonly faceCount: number;

  constructor(faceCount: number) {
    this.faceCount = Math.max(1, faceCount);
  }

  nextDieFaceIndex(): number {
    return Math.floor(Math.random() * this.faceCount);
  }

  /** A draw in `[minimumInclusive, maximumExclusive)`; below the minimum when the range is empty. */
  nextInt(minimumInclusive: number, maximumExclusive: number): number {
    if (maximumExclusive <= minimumInclusive) return minimumInclusive - 1;
    return minimumInclusive + Math.floor(Math.random() * (maximumExclusive - minimumInclusive));
  }
}

/** The collaborators the LLM seat needs: a transport for the endpoint and the config it posts with. */
interface LlmDependencies {
  transport: LlmTransport;
  config: LlmConfig;
}

export interface SahkkuApp {
  engine: RulesEngine;
  controller: WebMatchController;
  i18n: I18n;
  settings: SettingsStore;
  audio: AudioManager;

  /** The setup the toolbar currently describes. */
  readonly setup: MatchSetup;

  /** Applies a partial setup (or re-applies the current one) and deals a fresh match. */
  startMatch(setup?: Partial<MatchSetup>): void;
}

/** Builds the whole client against an existing document, ready for match setup. */
export function startSahkkuApp(doc: Document = document): SahkkuApp {
  const byId = (id: string): HTMLElement => {
    const element = doc.getElementById(id);
    if (element == null) throw new Error(`The page is missing the #${id} element.`);
    return element;
  };
  const selectById = (id: string): HTMLSelectElement => {
    const element = byId(id);
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error(`The page's #${id} element is not a <select>.`);
    }
    return element;
  };

  // ------------------------------------------------------------------ preferences and language

  const settings = new SettingsStore();
  const i18n = new I18n(settings.settings.locale);
  const audio = new AudioManager({
    masterVolume: settings.settings.masterVolume / 100,
    sfxVolume: settings.settings.sfxVolume / 100,
    muted: settings.settings.muted,
  });

  const applyAudioSettings = (preferences: SahkkuSettings): void => {
    audio.setVolumes({ master: preferences.masterVolume / 100, sfx: preferences.sfxVolume / 100 });
    audio.setMuted(preferences.muted);
  };

  // ------------------------------------------------------------------ the match

  const engine = new RulesEngine(loadShippedRuleset());
  const random = new UniformRandomSource(engine.rules.dice.faces.length);

  let setup: MatchSetup = { ...DefaultMatchSetup };
  let activeMode: GameMode | null = null;

  const controller = new WebMatchController(engine, random, engineOptionsFor({
    ...setup, startingPlayer: "P1",
  }), undefined, {
    started: false,
    humanPlayers: humanSeatsFor(setup),
    sounds: audio,
    translate: i18n.t,
  });

  // ------------------------------------------------------------------ the views

  const board = new BoardView(byId("board"), engine.rules, i18n.t);
  const dice = new DiceView(byId("dice-tray"), byId("dice-actions"), i18n.t);
  const legend = byId("legend");
  const statusBar = byId("status-bar");
  const banner = byId("banner");
  const modalRoot = byId("modal-root");
  const dialogRoot = byId("dialog-root");

  const presenter = new MatchPresenter(doc, banner, modalRoot, statusBar, i18n.t);

  const render = (view: MatchViewModel): void => {
    const playing = view.phase === "roll" || view.phase === "move";
    const startButton = byId("restart-button");
    startButton.textContent = i18n.t(
      view.phase === "setup" ? "menu.start" : playing ? "menu.restart" : "menu.newGame",
    );
    startButton.classList.toggle("button--primary", !playing);
    startButton.classList.toggle("button--secondary", playing);
    const setupLabel = i18n.t(view.phase === "setup" ? "menu.setup" : "menu.nextSetup");
    byId("setup-title").textContent = setupLabel;
    byId("match-setup").setAttribute("aria-label", setupLabel);
    byId("setup-hint").hidden = view.phase === "setup";
    board.render(view, {
      onPlaceClick: (placeIndex) => {
        controller.handlePlaceClick(placeIndex);
      },
    });
    dice.render(view, {
      onRoll: () => {
        controller.roll();
      },
      onReroll: () => {
        controller.decideReroll(RerollDecision.RerollActiveDie);
      },
      onKeep: () => {
        controller.decideReroll(RerollDecision.KeepDiceAndProceed);
      },
    });
    presenter.update(view);
  };

  controller.subscribe(render);

  // ------------------------------------------------------------------ the bots

  const botDriver = new BotDriver(controller, engine, {
    thinkDelayMs: BotThinkDelayMs[setup.speed],
    onThinkingChange: thinking => presenter.setThinking(thinking),
  });

  /**
   * The LLM seat's collaborators, rebuilt from the current settings: a fresh transport for each match,
   * so an endpoint edited in the dialog is used by the very next game. Its log lines are routed to the
   * banner, because a fallback the player cannot see is a silent change of opponent.
   */
  const llmDependencies = (): LlmDependencies => {
    const preferences = settings.settings;
    return {
      transport: new FetchLlmTransport(null, preferences.llmTimeoutSeconds * 1000),
      config: llmConfigFrom(preferences),
    };
  };

  const agentFor = (owner: PieceOwner, llm: LlmDependencies): PlayerAgent | null => {
    if (!isBotSeat(setup, owner)) return null;

    return createBotAgent(botKindFor(setup, owner), owner, engine, {
      searchExecutor: browserSearch,
      random,
      transport: llm.transport,
      llmConfig: llm.config,
      log: (message) => {
        if (/search failed/i.test(message)) {
          console.error(message);
          presenter.notice(i18n.t("notifications.searchFallback"));
          return;
        }
        if (!settings.settings.notifyOnFallback) return;
        if (!/heuristic/i.test(message)) return;
        presenter.notice(i18n.t("notifications.llmFallback"));
      },
    });
  };

  const startMatch = (next: Partial<MatchSetup> = {}): void => {
    setup = { ...setup, ...next, bots: { ...setup.bots, ...(next.bots ?? {}) } };
    botDriver.stop();
    activeMode = setup.mode;

    // The seats are changed before the new game is dealt, so the very first repaint of the fresh match
    // (and any step the driver schedules from it) already belongs to the agents this setup names.
    const llm = llmDependencies();
    botDriver.setThinkDelay(BotThinkDelayMs[setup.speed]);
    botDriver.setAgents({
      [PieceOwner.P1]: agentFor(PieceOwner.P1, llm),
      [PieceOwner.P2]: agentFor(PieceOwner.P2, llm),
    });

    controller.restart(engineOptionsFor(setup));
    controller.setHumanPlayers(humanSeatsFor(setup));
    syncToolbar();
    botDriver.start();
  };

  // ------------------------------------------------------------------ toolbar and dialogs

  const settingsModal = new SettingsModal({
    container: dialogRoot,
    store: settings,
    translate: i18n.t,
    onSave: (saved) => {
      applyAudioSettings(saved);
      i18n.setLocale(saved.locale);
    },
  });

  const helpModal = new HelpModal({ container: dialogRoot, translate: i18n.t });

  const modeSelect = selectById("mode-select");
  const bot1Select = selectById("bot1-select");
  const bot2Select = selectById("bot2-select");
  const speedSelect = selectById("speed-select");
  const variantSelect = selectById("variant-select");
  const starterSelect = selectById("starter-select");
  const localeSelect = selectById("locale-select");

  /** Fills every select from the current language, then restores the values the setup holds. */
  const fillSelects = (): void => {
    const t = i18n.t;

    fillSelect(
      modeSelect,
      [
        [GameModes.humanVsBot, t("menu.modes.humanVsBot")],
        [GameModes.hotseat2p, t("menu.modes.hotseat2p")],
        [GameModes.botVsBot, t("menu.modes.botVsBot")],
      ],
      setup.mode,
    );
    fillSelect(bot1Select, botOptions(t), setup.bots.p1);
    fillSelect(bot2Select, botOptions(t), setup.bots.p2);
    fillSelect(speedSelect, optionPairs(BotSpeeds, "menu.speeds", t), setup.speed);
    fillSelect(variantSelect, optionPairs(Variants, "menu.variants", t), setup.variant);
    fillSelect(
      starterSelect,
      [
        [StartingPlayers[0], t("menu.starters.throw")],
        [StartingPlayers[1], t("menu.starters.p1")],
        [StartingPlayers[2], t("menu.starters.p2")],
      ],
      setup.startingPlayer,
    );
    fillSelect(
      localeSelect,
      i18n.locales.map((info): [string, string] => [info.code, info.nativeName]),
      i18n.locale,
    );
  };

  /** Greys out the bot seats a mode does not use, so the toolbar never lies about who is playing. */
  const syncToolbar = (): void => {
    bot1Select.disabled = !isBotSeat(setup, PieceOwner.P1);
    bot2Select.disabled = !isBotSeat(setup, PieceOwner.P2);
    speedSelect.disabled = setup.mode === GameModes.hotseat2p &&
      (activeMode == null || activeMode === GameModes.hotseat2p);
    modeSelect.value = setup.mode;
    bot1Select.value = setup.bots.p1;
    bot2Select.value = setup.bots.p2;
    speedSelect.value = setup.speed;
    variantSelect.value = setup.variant;
    starterSelect.value = setup.startingPlayer;
  };

  modeSelect.addEventListener("change", () => {
    const mode: GameMode = isGameMode(modeSelect.value) ? modeSelect.value : setup.mode;
    setup = { ...setup, mode };
    syncToolbar();
  });
  bot1Select.addEventListener("change", () => {
    setup = { ...setup, bots: { ...setup.bots, p1: readBotKind(bot1Select.value, setup.bots.p1) } };
  });
  bot2Select.addEventListener("change", () => {
    setup = { ...setup, bots: { ...setup.bots, p2: readBotKind(bot2Select.value, setup.bots.p2) } };
  });
  speedSelect.addEventListener("change", () => {
    setup = { ...setup, speed: isBotSpeed(speedSelect.value) ? speedSelect.value : setup.speed };
    botDriver.setThinkDelay(BotThinkDelayMs[setup.speed]);
    syncToolbar();
  });
  variantSelect.addEventListener("change", () => {
    const variant: VariantChoice = isVariantChoice(variantSelect.value)
      ? variantSelect.value
      : setup.variant;
    setup = { ...setup, variant };
  });
  starterSelect.addEventListener("change", () => {
    const startingPlayer: StartingPlayerChoice = isStartingPlayerChoice(starterSelect.value)
      ? starterSelect.value
      : setup.startingPlayer;
    setup = { ...setup, startingPlayer };
  });
  localeSelect.addEventListener("change", () => {
    i18n.setLocale(localeSelect.value);
  });

  byId("restart-button").addEventListener("click", () => {
    const phase = controller.viewModel.phase;
    if ((phase === "roll" || phase === "move") &&
        !doc.defaultView?.confirm(i18n.t("menu.restartConfirm"))) return;
    startMatch();
  });
  byId("settings-button").addEventListener("click", () => {
    helpModal.close();
    settingsModal.open();
  });
  byId("help-button").addEventListener("click", () => {
    settingsModal.close();
    helpModal.open();
  });

  // ------------------------------------------------------------------ language switching

  /** Re-letters every piece of chrome, then repaints the board from the controller's view model. */
  const applyLocale = (locale: Locale): void => {
    doc.documentElement.lang = locale;
    doc.title = i18n.t("app.title");

    applyStaticTranslations(doc, i18n.t);
    fillSelects();
    renderLegend(legend, doc, i18n.t);
    board.setTranslator(i18n.t);
    dice.setTranslator(i18n.t);
    presenter.setTranslator(i18n.t);
    settingsModal.setTranslator(i18n.t);
    helpModal.setTranslator(i18n.t);

    // Repaints and re-labels everything the controller owns (status line, tray buttons, banner).
    controller.setTranslator(i18n.t);
  };

  i18n.subscribe((locale) => {
    settings.update({ locale });
    applyLocale(locale);
  });

  // ------------------------------------------------------------------ autoplay unlocking

  /**
   * The autoplay policy leaves a fresh `AudioContext` suspended, so the first real gesture is where the
   * sound is unlocked. Nothing waits on it and nothing throws: a refused unlock simply means the match
   * is played silently.
   */
  const unlockAudio = (): void => {
    doc.removeEventListener("pointerdown", unlockAudio, true);
    doc.removeEventListener("keydown", unlockAudio, true);
    void audio.unlock();
  };
  doc.addEventListener("pointerdown", unlockAudio, true);
  doc.addEventListener("keydown", unlockAudio, true);

  // ------------------------------------------------------------------ boot

  settings.subscribe((preferences) => {
    applyAudioSettings(preferences);
  });

  applyLocale(i18n.locale);
  syncToolbar();
  render(controller.viewModel);

  return {
    engine,
    controller,
    i18n,
    settings,
    audio,
    get setup() {
      return setup;
    },
    startMatch,
  };
}

// ---------------------------------------------------------------------------------- toolbar helpers

/** The two bot seats' option list, shared by both selects. */
function botOptions(t: Translator): Array<[string, string]> {
  return BotKinds.filter(kind => kind !== "heuristic")
    .map((kind): [string, string] => [kind, t(`menu.bots.${kind}`)]);
}

/** `[value, label]` pairs for a list of locale keys sharing a prefix, e.g. `menu.speeds.slow`. */
function optionPairs(
  values: readonly string[],
  keyPrefix: string,
  t: Translator,
): Array<[string, string]> {
  return values.map((value): [string, string] => [value, t(`${keyPrefix}.${value}`)]);
}

/** Refills a select with `[value, label]` pairs and selects `selected`, which is kept if unknown. */
function fillSelect(select: HTMLSelectElement, options: Array<[string, string]>, selected: string): void {
  const doc = select.ownerDocument;
  select.textContent = "";

  for (const [value, label] of options) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = selected;
}

function readBotKind(value: string, fallback: BotKind): BotKind {
  return isBotKind(value) ? value : fallback;
}

/**
 * Applies the locale to every static text node that carries a `data-i18n` key, and to every attribute
 * named by `data-i18n-attr="attribute=key"` (several may be listed, separated by `;`).
 *
 * Keeping the keys in the markup means the page's skeleton needs no JavaScript to be readable: with the
 * client disabled it still shows the shipped English text.
 */
function applyStaticTranslations(doc: Document, t: Translator): void {
  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset["i18n"];
    if (key != null && key.length > 0) element.textContent = t(key);
  }

  for (const element of doc.querySelectorAll<HTMLElement>("[data-i18n-attr]")) {
    const spec = element.dataset["i18nAttr"];
    if (spec == null || spec.length === 0) continue;

    for (const pair of spec.split(";")) {
      const [attribute, key] = pair.split("=").map((part) => part.trim());
      if (attribute == null || key == null || attribute.length === 0 || key.length === 0) continue;
      element.setAttribute(attribute, t(key));
    }
  }
}

// ---------------------------------------------------------------------------------- presentation

/** Owns the transient chrome around the board: the status line, the event banner and the modals. */
class MatchPresenter {
  private readonly doc: Document;
  private readonly statusBar: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly modalRoot: HTMLElement;

  private translate: Translator;
  private bannerSignature = "";
  private bannerTimer: number | null = null;
  private modalSignature = "";
  private gameOverDismissed = false;
  private victoryTimer: number | null = null;
  private victoryReady = false;
  private noticeText: string | null = null;
  private noticeTimer: number | null = null;
  private lastView: MatchViewModel | null = null;
  private readonly statusLabel: HTMLElement;
  private readonly elapsedLabel: HTMLElement;
  private thinkingStarted: number | null = null;
  private thinkingTimer: number | null = null;

  constructor(
    doc: Document,
    banner: HTMLElement,
    modalRoot: HTMLElement,
    statusBar: HTMLElement,
    translate: Translator,
  ) {
    this.doc = doc;
    this.banner = banner;
    this.modalRoot = modalRoot;
    this.statusBar = statusBar;
    this.translate = translate;
    this.statusLabel = doc.createElement("span");
    this.elapsedLabel = doc.createElement("span");
    this.elapsedLabel.className = "thinking-elapsed";
    this.elapsedLabel.setAttribute("aria-live", "off");
    this.elapsedLabel.hidden = true;
    statusBar.replaceChildren(this.statusLabel, this.elapsedLabel);
  }

  setThinking(thinking: boolean): void {
    const win = this.doc.defaultView;
    if (thinking && win != null && this.thinkingStarted == null) {
      this.thinkingStarted = win.performance.now();
      this.statusBar.dataset["thinking"] = "true";
      this.thinkingTimer = win.setInterval(() => this.updateElapsed(), 1000);
    } else if (!thinking) {
      if (this.thinkingTimer != null) win?.clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
      this.thinkingStarted = null;
      delete this.statusBar.dataset["thinking"];
      this.elapsedLabel.hidden = true;
      this.elapsedLabel.textContent = "";
    }
  }

  private updateElapsed(): void {
    const win = this.doc.defaultView;
    if (this.thinkingStarted == null || win == null) return;
    const seconds = Math.floor((win.performance.now() - this.thinkingStarted) / 1000);
    this.elapsedLabel.hidden = seconds < 10;
    if (seconds >= 10) this.elapsedLabel.textContent = this.translate("status.thinkingElapsed", { seconds });
  }

  /** Re-letters the chrome and repaints the cards that are already on screen. */
  setTranslator(translate: Translator): void {
    this.translate = translate;
    this.bannerSignature = "";
    this.modalSignature = "";
    if (this.lastView != null) this.update(this.lastView);
  }

  /**
   * Shows a notice — an LLM seat that gave up and played the heuristic move — above the rule-event
   * banner until its own (longer) timer runs out, so a bot's silent change of mind is visible.
   */
  notice(message: string): void {
    this.noticeText = message;

    const win = this.doc.defaultView;
    if (win != null) {
      if (this.noticeTimer != null) win.clearTimeout(this.noticeTimer);
      this.noticeTimer = win.setTimeout(() => {
        this.noticeTimer = null;
        this.noticeText = null;
        if (this.lastView != null) this.update(this.lastView);
      }, NOTICE_TIMEOUT_MS);
    }

    if (this.lastView != null) this.update(this.lastView);
  }

  update(view: MatchViewModel): void {
    this.lastView = view;
    this.statusLabel.textContent = view.statusText;
    this.updateElapsed();
    this.statusBar.dataset["phase"] = view.phase;
    this.statusBar.dataset["turn"] = view.humanTurn ? "human" : "bot";
    this.banner.classList.toggle("banner--victory", view.gameOver != null);
    this.showBanner(view.eventMessages);
    this.showGameOver(view.gameOver);
  }

  private showBanner(messages: readonly string[]): void {
    const parts = this.noticeText == null ? [...messages] : [this.noticeText, ...messages];
    const signature = parts.join("|");
    if (signature === this.bannerSignature) return;
    this.bannerSignature = signature;

    if (parts.length === 0) {
      this.banner.hidden = true;
      this.banner.textContent = "";
      return;
    }

    this.banner.hidden = false;
    this.banner.textContent = parts.join(" · ");

    const win = this.doc.defaultView;
    if (win == null) return;
    if (this.bannerTimer != null) win.clearTimeout(this.bannerTimer);
    this.bannerTimer = null;

    // Keep the winning explanation visible when the player returns to inspect the board.
    if (this.noticeText != null || this.lastView?.gameOver != null) return;
    this.bannerTimer = win.setTimeout(() => {
      this.banner.hidden = true;
      this.bannerSignature = "";
      this.bannerTimer = null;
    }, BANNER_TIMEOUT_MS);
  }

  private showGameOver(gameOver: GameOverView | null): void {
    const win = this.doc.defaultView;
    if (gameOver == null) {
      if (this.victoryTimer != null) win?.clearTimeout(this.victoryTimer);
      this.victoryTimer = null;
      this.victoryReady = false;
    } else if (!this.victoryReady && win != null) {
      if (this.victoryTimer == null) {
        this.victoryTimer = win.setTimeout(() => {
          this.victoryTimer = null;
          this.victoryReady = true;
          this.showGameOver(this.lastView?.gameOver ?? null);
        }, VICTORY_REVEAL_MS);
      }
      return;
    }
    if (gameOver == null) this.gameOverDismissed = false;
    if (this.gameOverDismissed) return;
    const signature = gameOver == null ? "" : `${gameOver.winner}:${gameOver.reason}`;
    if (signature === this.modalSignature) return;
    this.modalSignature = signature;

    this.modalRoot.textContent = "";
    if (gameOver == null) return;

    const doc = this.doc;
    const t = this.translate;

    const overlay = doc.createElement("div");
    overlay.className = "modal";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", t("gameOver.label"));

    const card = doc.createElement("div");
    card.className = "modal-card";

    const title = doc.createElement("h2");
    title.className = "modal-title";
    title.textContent = t("gameOver.title", { player: gameOver.winnerLabel });

    const body = doc.createElement("p");
    body.className = "modal-body";
    body.textContent = t("gameOver.body", { reason: gameOver.reasonLabel });

    const actions = doc.createElement("div");
    actions.className = "modal-actions";

    const again = doc.createElement("button");
    again.type = "button";
    again.className = "button button--primary";
    again.textContent = t("gameOver.backToBoard");
    again.addEventListener("click", () => {
      this.gameOverDismissed = true;
      this.modalRoot.textContent = "";
      this.doc.getElementById("restart-button")?.focus();
    });
    actions.appendChild(again);

    card.append(title, body, actions);
    overlay.appendChild(card);
    this.modalRoot.appendChild(overlay);
  }
}

/** The piece legend, drawn with the very same tokens the board uses and named in the active language. */
function renderLegend(container: HTMLElement, doc: Document, t: Translator): void {
  const entries: Array<{
    type: PieceType;
    owner: PieceOwner;
    isActive: boolean;
    label: string;
  }> = [
    { type: PieceType.Soldier, owner: PieceOwner.P1, isActive: true, label: t("legend.woman") },
    { type: PieceType.Soldier, owner: PieceOwner.P2, isActive: true, label: t("legend.man") },
    { type: PieceType.Queen, owner: PieceOwner.P1, isActive: true, label: t("legend.queenP1") },
    { type: PieceType.Queen, owner: PieceOwner.P2, isActive: true, label: t("legend.queenP2") },
    { type: PieceType.King, owner: PieceOwner.None, isActive: true, label: t("legend.king") },
    { type: PieceType.Soldier, owner: PieceOwner.P1, isActive: false, label: t("legend.seated") },
  ];

  container.textContent = "";
  for (const entry of entries) {
    const item = doc.createElement("span");
    item.className = "legend-item";

    const swatch = doc.createElement("span");
    swatch.className = "legend-swatch";
    swatch.appendChild(
      PieceRenderer.createToken(
        { type: entry.type, owner: entry.owner, isActive: entry.isActive },
        doc,
      ),
    );

    const text = doc.createElement("span");
    text.textContent = entry.label;

    item.append(swatch, text);
    container.appendChild(item);
  }

  const carvingItem = doc.createElement("span");
  carvingItem.className = "legend-item";
  const carvingSwatch = doc.createElement("span");
  carvingSwatch.className = "legend-swatch legend-swatch--carving";
  carvingSwatch.setAttribute("aria-hidden", "true");
  const carvingText = doc.createElement("span");
  carvingText.textContent = t("legend.carving");
  carvingItem.append(carvingSwatch, carvingText);
  container.appendChild(carvingItem);
}

if (typeof document !== "undefined") startSahkkuApp();
