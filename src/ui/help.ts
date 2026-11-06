/**
 * The illustrated rules dialog.
 *
 * Sáhkku is a traditional game, and the client's whole job is to teach it to someone who has never
 * seen a carved board — so the help dialog is not a wall of text: every section carries a small inline
 * SVG diagram drawn from the same primitives the board uses (no image assets, no external fonts).
 *
 * The text lives in the locale tables and is addressed by key, so the dialog is fully translated and
 * `setTranslator` re-renders it mid-session — the same contract as the settings dialog.
 */

import { PieceOwner, PieceType } from "../rules/domain";
import type { Translator } from "../locale/i18n";
import { createOverlay, dismissOnBackdropAndEscape, focusableActiveElement } from "./dialog";
import { PieceRenderer } from "./pieces";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface HelpModalInit {
  /** Where the dialog is mounted, e.g. `#dialog-root`. */
  container: HTMLElement;

  /** The active language. */
  translate: Translator;
}

/** One section of the guide: a heading, a diagram and a paragraph, all localized. */
interface HelpSection {
  titleKey: string;
  bodyKey: string;
  figure(doc: Document): SVGElement;
}

/** The sections, in reading order. */
const Sections: readonly HelpSection[] = [
  { titleKey: "help.intro.title", bodyKey: "help.intro.body", figure: figureFigureOfEight },
  { titleKey: "help.board.title", bodyKey: "help.board.body", figure: figureBoard },
  { titleKey: "help.start.title", bodyKey: "help.start.body", figure: figureDice },
  { titleKey: "help.dice.title", bodyKey: "help.dice.body", figure: figureDice },
  { titleKey: "help.pieces.title", bodyKey: "help.pieces.body", figure: figurePieces },
  { titleKey: "help.activation.title", bodyKey: "help.activation.body", figure: figureQueue },
  { titleKey: "help.win.title", bodyKey: "help.win.body", figure: figureVictory },
];

export class HelpModal {
  private readonly container: HTMLElement;
  private translate: Translator;
  private overlay: HTMLElement | null = null;
  private restoreFocusTo: HTMLElement | null = null;

  constructor(init: HelpModalInit) {
    this.container = init.container;
    this.translate = init.translate;
  }

  get isOpen(): boolean {
    return this.overlay != null;
  }

  /** Uses `translator` for every subsequent render (and repaints now, if the dialog is open). */
  setTranslator(translator: Translator): void {
    this.translate = translator;
    if (this.isOpen) this.render();
  }

  /** Mounts the guide. Idempotent. */
  open(): void {
    if (this.isOpen) return;

    const doc = this.container.ownerDocument;
    this.restoreFocusTo = focusableActiveElement(doc);

    const overlay = createOverlay(doc, "help", this.translate("help.label"));
    this.container.appendChild(overlay);
    this.overlay = overlay;
    this.render();
  }

  /** Unmounts the guide. Idempotent. */
  close(): void {
    const overlay = this.overlay;
    if (overlay == null) return;

    overlay.remove();
    this.overlay = null;

    const target = this.restoreFocusTo;
    this.restoreFocusTo = null;
    target?.focus();
  }

  private render(): void {
    const overlay = this.overlay;
    if (overlay == null) return;

    const doc = overlay.ownerDocument;
    const t = this.translate;
    overlay.textContent = "";
    overlay.setAttribute("aria-label", t("help.label"));

    const card = doc.createElement("div");
    card.className = "modal-card modal-card--help";
    card.tabIndex = -1;

    const title = doc.createElement("h2");
    title.className = "modal-title";
    title.textContent = t("help.title");
    card.appendChild(title);

    for (const section of Sections) {
      const block = doc.createElement("section");
      block.className = "help-section";

      const heading = doc.createElement("h3");
      heading.className = "help-section-title";
      heading.textContent = t(section.titleKey);

      const figure = doc.createElement("div");
      figure.className = "help-figure";
      figure.appendChild(section.figure(doc));

      const body = doc.createElement("p");
      body.className = "help-body";
      body.textContent = t(section.bodyKey);

      block.append(heading, figure, body);
      card.appendChild(block);
    }

    const credit = doc.createElement("p");
    credit.className = "help-credit";
    credit.textContent = t("help.credit");
    card.appendChild(credit);

    const actions = doc.createElement("div");
    actions.className = "modal-actions";

    const close = doc.createElement("button");
    close.type = "button";
    close.className = "button button--primary";
    close.dataset["action"] = "close";
    close.textContent = t("help.close");
    close.addEventListener("click", () => {
      this.close();
    });

    actions.appendChild(close);
    card.appendChild(actions);
    overlay.appendChild(card);

    dismissOnBackdropAndEscape(overlay, card, () => {
      this.close();
    });
    card.focus();
  }
}

// ----------------------------------------------------------------------------------------------
// illustrations
// ----------------------------------------------------------------------------------------------

/** The board with the figure-of-eight lap drawn over it. */
function figureFigureOfEight(doc: Document): SVGElement {
  const svg = svgFigure(doc, "0 0 240 120");

  svg.appendChild(roundedRect(doc, { x: 8, y: 12, width: 224, height: 96, rx: 10, class: "help-wood" }));

  for (const y of [24, 60, 96]) {
    for (let column = 0; column < 15; ++column) {
      const x = 24 + column * 13;
      svg.appendChild(
        roundedRect(doc, { x, y: y - 8, width: 8, height: 16, rx: 3, class: "help-cell" }),
      );
    }
  }

  svg.appendChild(svgCircle(doc, 119, 60, 6, "help-king"));

  // Offset the two middle-row passes so both are visible; they use the same cells in play.
  const lap = "M28 96 L210 96 L210 64 L28 64 L28 24 L210 24 L210 56 L28 56 L28 96";
  svg.appendChild(svgPath(doc, lap, "help-lap"));
  for (const y of [24, 96]) {
    svg.appendChild(svgPath(doc, `M154 ${y - 4} L160 ${y} L154 ${y + 4}`, "help-arrow"));
  }
  for (const y of [56, 64]) {
    svg.appendChild(svgPath(doc, `M84 ${y - 3} L78 ${y} L84 ${y + 3}`, "help-arrow"));
  }
  return svg;
}

/** The board's three rows, with the two home rows and the shared middle row marked. */
function figureBoard(doc: Document): SVGElement {
  const svg = svgFigure(doc, "0 0 240 120");
  const rows: Array<{ y: number; class: string }> = [
    { y: 22, class: "help-cell help-cell--p2" },
    { y: 56, class: "help-cell help-cell--middle" },
    { y: 90, class: "help-cell help-cell--p1" },
  ];

  for (const row of rows) {
    for (let column = 0; column < 11; ++column) {
      const x = 16 + column * 19;
      svg.appendChild(roundedRect(doc, { x, y: row.y, width: 15, height: 18, rx: 3, class: row.class }));
    }
  }

  // The king's and queens' starting cells.
  svg.appendChild(svgPath(doc, "M110 58 L122 74 M122 58 L110 74", "help-mark"));
  svg.appendChild(svgPath(doc, "M55 58 L67 74 M67 58 L55 74", "help-mark"));
  svg.appendChild(svgPath(doc, "M169 58 L181 74 M181 58 L169 74", "help-mark"));
  return svg;
}

/** The three four-sided dice with their traditional carvings. */
function figureDice(doc: Document): SVGElement {
  const svg = svgFigure(doc, "0 0 240 120");
  const faces: Array<{ x: number; marks: string[] }> = [
    { x: 40, marks: ["M12 18 L28 46", "M28 18 L12 46"] },
    { x: 108, marks: ["M12 20 L12 44", "M20 20 L20 44", "M28 20 L28 44"] },
    { x: 176, marks: ["M12 20 L12 44", "M28 20 L28 44"] },
  ];

  for (const face of faces) {
    const group = svgGroup(doc, `translate(${face.x} 30)`);
    group.appendChild(roundedRect(doc, { x: 0, y: 0, width: 40, height: 58, rx: 8, class: "help-die" }));
    for (const mark of face.marks) group.appendChild(svgPath(doc, mark, "help-carving"));
    svg.appendChild(group);
  }
  return svg;
}

/** The four traditional pieces, drawn with the very same token renderer the board uses. */
function figurePieces(doc: Document): SVGElement {
  const svg = svgFigure(doc, "0 0 240 120");
  const tokens: Array<{ type: PieceType; owner: PieceOwner; x: number; scale: number }> = [
    { type: PieceType.Soldier, owner: PieceOwner.P1, x: 22, scale: 0.9 },
    { type: PieceType.Soldier, owner: PieceOwner.P2, x: 80, scale: 0.9 },
    { type: PieceType.Queen, owner: PieceOwner.P1, x: 138, scale: 0.95 },
    { type: PieceType.King, owner: PieceOwner.None, x: 196, scale: 1 },
  ];

  for (const token of tokens) {
    const tokenElement = PieceRenderer.createToken(
      { type: token.type, owner: token.owner, isActive: true },
      doc,
    );
    tokenElement.setAttribute("class", `${tokenElement.getAttribute("class") ?? "piece"} help-token`);
    const group = svgGroup(doc, `translate(${token.x} 20) scale(${token.scale})`);
    group.appendChild(tokenElement);
    svg.appendChild(group);
  }
  return svg;
}

/** The activation queue: the foremost waiting soldier is woken, the pieces behind follow. */
function figureQueue(doc: Document): SVGElement {
  const svg = svgFigure(doc, "0 0 240 120");
  svg.appendChild(roundedRect(doc, { x: 12, y: 44, width: 216, height: 40, rx: 8, class: "help-cell help-cell--p1" }));

  for (let index = 0; index < 5; ++index) {
    const x = 34 + index * 40;
    svg.appendChild(svgCircle(doc, x, 64, 11, index === 0 ? "help-active" : "help-queued"));
    svg.appendChild(svgText(doc, x, 64, String(index + 1)));
  }

  svg.appendChild(svgPath(doc, "M30 24 L210 24 M198 16 L210 24 L198 32", "help-arrow"));
  return svg;
}

/** Victory: the crown standing over a fallen queen. */
function figureVictory(doc: Document): SVGElement {
  const svg = svgFigure(doc, "0 0 240 120");

  const king = PieceRenderer.createToken(
    { type: PieceType.King, owner: PieceOwner.P1, isActive: true },
    doc,
  );
  king.setAttribute("class", `${king.getAttribute("class") ?? "piece"} help-token`);
  const winner = svgGroup(doc, "translate(96 12) scale(1.15)");
  winner.appendChild(king);
  svg.appendChild(winner);

  svg.appendChild(svgPath(doc, "M40 100 L200 100", "help-lap"));
  svg.appendChild(svgCircle(doc, 52, 100, 9, "help-captured"));
  svg.appendChild(svgCircle(doc, 84, 100, 9, "help-captured"));
  svg.appendChild(svgCircle(doc, 168, 100, 9, "help-captured"));
  return svg;
}

// ----------------------------------------------------------------------------------------------
// svg helpers
// ----------------------------------------------------------------------------------------------

function svgFigure(doc: Document, viewBox: string): SVGElement {
  const svg = doc.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("class", "help-svg");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function svgGroup(doc: Document, transform: string): SVGGElement {
  const group = doc.createElementNS(SVG_NAMESPACE, "g");
  group.setAttribute("transform", transform);
  return group;
}

function svgPath(doc: Document, d: string, className: string): SVGElement {
  return svgElement(doc, "path", { d, class: className });
}

function svgCircle(doc: Document, cx: number, cy: number, r: number, className: string): SVGElement {
  return svgElement(doc, "circle", { cx, cy, r, class: className });
}

function svgText(doc: Document, x: number, y: number, text: string): SVGElement {
  const node = svgElement(doc, "text", { x, y: y + 4, class: "help-text" });
  node.textContent = text;
  return node;
}

function roundedRect(
  doc: Document,
  attributes: { x: number; y: number; width: number; height: number; rx: number; class: string },
): SVGElement {
  return svgElement(doc, "rect", attributes);
}

function svgElement(
  doc: Document,
  tag: string,
  attributes: Record<string, string | number>,
): SVGElement {
  const node = doc.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}
