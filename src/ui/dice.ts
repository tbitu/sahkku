/**
 * The 2D Sáhkku dice roller ("birccu").
 *
 * Three elongated four-sided dice are drawn as inline SVG — an elongated body with the traditional
 * carved marking on its face:
 *
 * | face     | carving | value                              |
 * |----------|---------|------------------------------------|
 * | `sahhku` | `X`     | one step, activates a seated piece, may be re-thrown |
 * | `three`  | `III`   | three steps                        |
 * | `two`    | `II`    | two steps                          |
 * | `zero`   | blank   | nothing                            |
 *
 * The tray also shows the ruleset's *spending* order: the die up for spending is lifted and ringed,
 * dice already spent are struck out, and the ones still to come simply wait their turn. When the
 * active die may be re-thrown (`RulesEngine.canReroll`, i.e. a sáhkku before any die was spent) the
 * tray offers the player's explicit choice — **Reroll Die** or **Keep & Move** — because the engine
 * never decides that for them.
 *
 * Every caption either comes from the `MatchViewModel` (the controller localizes the button labels and
 * the spending-order line) or from the {@link Translator} handed to the constructor, which owns this
 * view's own accessible names. Nothing here decides anything.
 */

import { defaultTranslate, type Translator } from "../locale/i18n";
import { DieFace } from "../rules/domain";
import type { MatchViewModel } from "./controller";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Length of the throw animation, a little longer than the CSS keyframes. */
const ROLL_ANIMATION_MS = 680;

export interface DiceCallbacks {
  onRoll(): void;
  onReroll(): void;
  onKeep(): void;
}

export class DiceView {
  private readonly tray: HTMLElement;
  private readonly actions: HTMLElement;

  private translate: Translator;
  private dieElements: HTMLElement[] = [];
  private callbacks: DiceCallbacks | null = null;
  private lastSignature = "";
  private rollTimer: number | null = null;

  constructor(tray: HTMLElement, actions: HTMLElement, translate: Translator = defaultTranslate) {
    this.tray = tray;
    this.actions = actions;
    this.translate = translate;
    this.tray.setAttribute("aria-label", translate("dice.trayLabel"));
    this.actions.addEventListener("click", (event) => this.handleActionClick(event));
  }

  /**
   * Re-letters the tray in a new language. The die names are refreshed by the next `render`, which every
   * locale switch triggers through the controller's repaint.
   */
  setTranslator(translate: Translator): void {
    this.translate = translate;
    this.tray.setAttribute("aria-label", translate("dice.trayLabel"));
  }

  /** Paints the tray and the action buttons for one frame. */
  render(view: MatchViewModel, callbacks: DiceCallbacks): void {
    this.callbacks = callbacks;
    const doc = this.tray.ownerDocument;

    if (this.dieElements.length !== view.dice.dice.length) {
      this.buildDice(doc, view.dice.dice.length);
      this.lastSignature = "";
    }

    const rolled = view.dice.rolled;
    for (let index = 0; index < view.dice.dice.length; ++index) {
      const die = view.dice.dice[index]!;
      const element = this.dieElements[index]!;

      element.classList.toggle("die--active", rolled && die.active);
      element.classList.toggle("die--spent", die.spent);
      element.classList.toggle("die--unusable", die.unusable);
      element.setAttribute(
        "aria-label",
        dieLabel(this.translate, index, die.face, rolled, die.spent, die.active, die.unusable),
      );

      const marks = element.querySelector<SVGGElement>(".die-marks");
      if (marks != null) drawFace(doc, marks, rolled ? die.face : null);
    }

    const signature = rolled
      ? view.dice.dice.map((die) => faceSlug(die.face)).join("-")
      : "unrolled";
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      if (rolled && view.dice.feedbackText == null) this.playRollAnimation();
    }

    if (view.dice.feedbackText != null) {
      const win = this.tray.ownerDocument.defaultView;
      if (this.rollTimer != null) win?.clearTimeout(this.rollTimer);
      this.rollTimer = null;
      this.tray.classList.remove("is-rolling");
    }
    this.renderActions(doc, view);
  }

  // ------------------------------------------------------------------ internals

  private buildDice(doc: Document, count: number): void {
    this.tray.textContent = "";
    this.dieElements = [];

    for (let index = 0; index < count; ++index) {
      const die = doc.createElement("div");
      die.className = "die";

      const order = doc.createElement("span");
      order.className = "die-order";
      order.textContent = String(index + 1);

      const shape = doc.createElementNS(SVG_NAMESPACE, "svg");
      shape.setAttribute("class", "die-shape");
      shape.setAttribute("viewBox", "0 0 48 128");
      shape.setAttribute("focusable", "false");
      shape.setAttribute("aria-hidden", "true");

      // The elongated four-sided birccu: body, foot and top cap.
      shape.appendChild(
        createSvg(doc, "rect", {
          class: "die-body",
          x: 13,
          y: 12,
          width: 22,
          height: 104,
          rx: 11,
        }),
      );
      shape.appendChild(createSvg(doc, "ellipse", { class: "die-foot", cx: 24, cy: 116, rx: 11, ry: 6 }));
      shape.appendChild(createSvg(doc, "ellipse", { class: "die-cap", cx: 24, cy: 12, rx: 11, ry: 6 }));

      const marks = doc.createElementNS(SVG_NAMESPACE, "g");
      marks.setAttribute("class", "die-marks");
      shape.appendChild(marks);

      die.appendChild(order);
      die.appendChild(shape);
      this.tray.appendChild(die);
      this.dieElements.push(die);
    }
  }

  private renderActions(doc: Document, view: MatchViewModel): void {
    this.actions.textContent = "";

    if (view.dice.feedbackText != null) {
      const warning = doc.createElement("p");
      warning.className = "dice-feedback";
      warning.textContent = view.dice.feedbackText;
      this.actions.appendChild(warning);
      return;
    }

    const order = doc.createElement("p");
    order.className = "dice-order";
    order.textContent = view.dice.orderText;
    this.actions.appendChild(order);

    if (view.dice.canRoll) {
      this.actions.appendChild(
        createButton(doc, "roll", "button--primary", view.dice.rollLabel),
      );
      return;
    }

    if (view.dice.canReroll) {
      this.actions.appendChild(
        createButton(doc, "reroll", "button--primary", view.dice.rerollLabel),
      );
      this.actions.appendChild(
        createButton(doc, "keep", "button--secondary", view.dice.keepLabel),
      );
    }
  }

  private playRollAnimation(): void {
    const win = this.tray.ownerDocument.defaultView;
    if (win == null) return;
    if (this.rollTimer != null) win.clearTimeout(this.rollTimer);

    // Re-adding the class has to restart the animation, so the style flush in between is deliberate.
    this.tray.classList.remove("is-rolling");
    void this.tray.offsetWidth;
    this.tray.classList.add("is-rolling");

    this.rollTimer = win.setTimeout(() => {
      this.tray.classList.remove("is-rolling");
      this.rollTimer = null;
    }, ROLL_ANIMATION_MS);
  }

  private handleActionClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest<HTMLButtonElement>("[data-action]");
    if (button == null) return;

    switch (button.dataset["action"]) {
      case "roll":
        this.callbacks?.onRoll();
        break;
      case "reroll":
        this.callbacks?.onReroll();
        break;
      case "keep":
        this.callbacks?.onKeep();
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------------- drawing

/** Draws one face's carving into the die, or leaves it blank before the throw. */
function drawFace(doc: Document, marks: SVGGElement, face: DieFace | null): void {
  marks.textContent = "";
  if (face == null) return;

  switch (face) {
    case DieFace.Sahhku:
      marks.appendChild(createSvg(doc, "path", { class: "die-mark", d: "M15 50 L33 78" }));
      marks.appendChild(createSvg(doc, "path", { class: "die-mark", d: "M33 50 L15 78" }));
      break;
    case DieFace.Three:
      for (const x of [17, 24, 31]) {
        marks.appendChild(createSvg(doc, "path", { class: "die-mark", d: `M${x} 53 L${x} 75` }));
      }
      break;
    case DieFace.Two:
      for (const x of [19, 29]) {
        marks.appendChild(createSvg(doc, "path", { class: "die-mark", d: `M${x} 53 L${x} 75` }));
      }
      break;
    default:
      // The blank side carries no carving at all.
      break;
  }
}

function createSvg(
  doc: Document,
  tag: string,
  attributes: Record<string, string | number>,
): SVGElement {
  const node = doc.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function createButton(
  doc: Document,
  action: string,
  modifier: string,
  label: string,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = `button ${modifier}`;
  button.dataset["action"] = action;
  button.textContent = label;
  return button;
}

function faceSlug(face: DieFace): string {
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

function faceNameKey(face: DieFace): string {
  switch (face) {
    case DieFace.Sahhku:
      return "dice.face.sahkku";
    case DieFace.Three:
      return "dice.face.three";
    case DieFace.Two:
      return "dice.face.two";
    default:
      return "dice.face.zero";
  }
}

function dieLabel(
  t: Translator,
  index: number,
  face: DieFace,
  rolled: boolean,
  spent: boolean,
  active: boolean,
  unusable: boolean,
): string {
  if (!rolled) return t("dice.die.notThrown", { index: index + 1 });
  const state = t(unusable ? "dice.state.unusable" :
    spent ? "dice.state.spent" : active ? "dice.state.active" : "dice.state.waiting");
  return t("dice.die.state", { index: index + 1, face: t(faceNameKey(face)), state });
}
