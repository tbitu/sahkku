/**
 * The 2D board view: a fluid CSS grid of 15 × 3 carved cells, the pieces standing on them and the
 * highlight overlays the interaction needs.
 *
 * Board geometry — its size, the row roles and the carved "X" cells — is *derived from the ruleset*,
 * never hardcoded: the width and height come from `board`, the home rows from the soldier setup and
 * the track turnings from `track.legs`. A different ruleset therefore paints a different board
 * without a line changing here.
 *
 * The view is a pure function of the `MatchViewModel` it is handed: it owns no game state and decides
 * nothing, it only paints what the controller reported. Its one piece of *text* is the row labels and
 * the accessible names of the cells, which come from a {@link Translator} (English by default) so a
 * language switch re-letters the board along with the rest of the chrome.
 */

import { defaultTranslate, type Translator } from "../locale/i18n";
import { PieceOwner } from "../rules/domain";
import type { RuleSet } from "../rules/ruleset";
import { TrackDirections } from "../rules/ruleset";
import { BoardLayout } from "../rules/track";
import type { CellView, MatchViewModel } from "./controller";
import { PieceRenderer, ownerNameKey } from "./pieces";

/** The three traditional carvings cut into the board. */
export type DecorationKind = "king" | "queen" | "turning";

export interface CellDecoration {
  kind: DecorationKind;
  label: string;
}

/** The static shape of one board: size, row roles and carved cells. */
export interface BoardGeometry {
  width: number;
  height: number;

  /** Row labels indexed by board row (`y`). */
  rowLabels: string[];

  /** `"home"` for a player's own home row, `"middle"` for the shared row, by board row (`y`). */
  rowKind: string[];

  /** Carved cells, keyed by place index. */
  decorations: Map<number, CellDecoration[]>;
}

/**
 * Derives the static geometry from the ruleset: the grid size, which row belongs to whom, and the
 * cells that carry a carving (the king's seat, both queens' seats and the end columns where the
 * figure-of-eight track turns). `translate` supplies the labels only; the geometry itself is ruleset
 * data and is identical in every language.
 */
export function boardGeometry(rules: RuleSet, translate: Translator = defaultTranslate): BoardGeometry {
  const width = rules.board.width;
  const height = rules.board.height;
  const t = translate;

  const p1Row = rules.setup.soldiers.P1.row;
  const p2Row = rules.setup.soldiers.P2.row;

  const rowLabels: string[] = [];
  const rowKind: string[] = [];
  for (let y = 0; y < height; ++y) {
    if (y === p1Row) {
      rowLabels.push(t("board.row.home", { player: t(ownerNameKey(PieceOwner.P1)) }));
      rowKind.push("home");
    } else if (y === p2Row) {
      rowLabels.push(t("board.row.home", { player: t(ownerNameKey(PieceOwner.P2)) }));
      rowKind.push("home");
    } else {
      rowLabels.push(t("board.row.middle"));
      rowKind.push("middle");
    }
  }

  const decorations = new Map<number, CellDecoration[]>();
  const carve = (x: number, y: number, decoration: CellDecoration): void => {
    const place = BoardLayout.indexFromCoordinates(width, height, x, y);
    if (place < 0) return;
    const existing = decorations.get(place) ?? [];
    if (!existing.some((entry) => entry.kind === decoration.kind)) existing.push(decoration);
    decorations.set(place, existing);
  };

  carve(rules.setup.king.x, rules.setup.king.row, {
    kind: "king",
    label: t("board.carving.king"),
  });
  carve(rules.setup.queens.P1.x, rules.setup.queens.P1.row, {
    kind: "queen",
    label: t("board.carving.queenP1"),
  });
  carve(rules.setup.queens.P2.x, rules.setup.queens.P2.row, {
    kind: "queen",
    label: t("board.carving.queenP2"),
  });

  // Every leg of the lap starts and ends on an end column; that is where the track bends.
  for (const leg of rules.track.legs) {
    const columns = leg.direction === TrackDirections.Right ? [0, width - 1] : [width - 1, 0];
    for (const x of columns) {
      carve(x, leg.row, { kind: "turning", label: t("board.carving.turning") });
    }
  }

  return { width, height, rowLabels, rowKind, decorations };
}

export interface BoardCallbacks {
  onPlaceClick(placeIndex: number): void;
}

export class BoardView {
  private readonly container: HTMLElement;
  private readonly rules: RuleSet;
  private readonly cellsByPlace: HTMLButtonElement[] = [];

  private geometry: BoardGeometry;
  private translate: Translator;
  private onPlaceClick: ((placeIndex: number) => void) | null = null;

  constructor(container: HTMLElement, rules: RuleSet, translate: Translator = defaultTranslate) {
    this.container = container;
    this.rules = rules;
    this.translate = translate;
    this.geometry = boardGeometry(rules, translate);
    this.build();
    this.container.addEventListener("click", (event) => this.handleClick(event));
  }

  /**
   * Re-letters the board in a new language. The geometry is re-derived and the cells rebuilt, which is
   * cheap (15×3 buttons) and keeps the row labels, the carving titles and the cell names in one place.
   * The caller repaints afterwards; the cells are blank until it does.
   */
  setTranslator(translate: Translator): void {
    this.translate = translate;
    this.geometry = boardGeometry(this.rules, translate);
    this.build();
  }

  /** Paints one frame. Safe to call on every state change. */
  render(view: MatchViewModel, callbacks: BoardCallbacks): void {
    this.onPlaceClick = callbacks.onPlaceClick;
    const doc = this.container.ownerDocument;

    for (const cell of view.cells) {
      const element = this.cellsByPlace[cell.placeIndex];
      if (element == null) continue;

      const selectable = cell.pieces.some((piece) => piece.selectable);
      const actionable = cell.highlight || selectable;

      element.classList.toggle("is-highlight", cell.highlight);
      element.classList.toggle("has-piece", cell.pieces.length > 0);
      element.classList.toggle("is-selected", cell.pieces.some((piece) => piece.selected));
      element.classList.toggle("is-actionable", actionable);
      element.tabIndex = actionable ? 0 : -1;
      element.setAttribute("aria-label", cellLabel(cell, this.translate));
      element.title = cell.pieces.filter((piece) => piece.selectable).length > 1
        ? this.translate("board.cell.cycle")
        : "";

      const layer = element.querySelector<HTMLElement>(".cell-pieces");
      if (layer == null) continue;

      layer.textContent = "";
      const top = displayedPiece(cell);
      if (top == null) continue;

      layer.appendChild(
        PieceRenderer.createToken(
          {
            type: top.type,
            owner: top.owner,
            isActive: top.isActive,
            selected: top.selected,
          },
          doc,
        ),
      );

      if (cell.pieces.length > 1) {
        const badge = doc.createElement("span");
        badge.className = "stack-badge";
        badge.textContent = `×${cell.pieces.length}`;
        layer.appendChild(badge);
      }
    }
  }

  // ------------------------------------------------------------------ internals

  private build(): void {
    const doc = this.container.ownerDocument;
    this.container.textContent = "";
    this.container.style.setProperty("--board-columns", String(this.geometry.width));
    this.cellsByPlace.length = 0;

    // Highest row first, so the board reads the same way the ASCII formatter prints it: the far
    // player's home row along the top and the near player's along the bottom.
    for (let y = this.geometry.height - 1; y >= 0; --y) {
      const label = doc.createElement("span");
      label.className = "row-label";
      label.textContent = this.geometry.rowLabels[y] ?? `Row ${y + 1}`;
      this.container.appendChild(label);

      for (let x = 0; x < this.geometry.width; ++x) {
        const place = BoardLayout.indexFromCoordinates(
          this.geometry.width,
          this.geometry.height,
          x,
          y,
        );
        if (place < 0) continue;
        const cell = this.createCell(doc, place, x, y);
        this.cellsByPlace[place] = cell;
        this.container.appendChild(cell);
      }
    }
  }

  private createCell(doc: Document, place: number, x: number, y: number): HTMLButtonElement {
    const cell = doc.createElement("button");
    cell.type = "button";
    cell.className = "cell";
    cell.dataset["place"] = String(place);
    cell.dataset["x"] = String(x);
    cell.dataset["y"] = String(y);
    cell.dataset["row"] = this.geometry.rowKind[y] ?? "middle";
    cell.tabIndex = -1;
    cell.setAttribute(
      "aria-label",
      this.translate("board.cell.empty", {
        position: this.translate("board.cell.position", { x: x + 1, y: y + 1 }),
      }),
    );

    const carvings = doc.createElement("span");
    carvings.className = "carving-layer";
    carvings.setAttribute("aria-hidden", "true");
    for (const decoration of this.geometry.decorations.get(place) ?? []) {
      const mark = doc.createElement("span");
      mark.className = `carving carving--${decoration.kind}`;
      mark.title = decoration.label;
      carvings.appendChild(mark);
    }
    cell.appendChild(carvings);

    const pieces = doc.createElement("span");
    pieces.className = "cell-pieces";
    cell.appendChild(pieces);

    return cell;
  }

  private handleClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const cell = target.closest<HTMLElement>(".cell");
    if (cell == null) return;

    const place = Number(cell.dataset["place"]);
    if (!Number.isInteger(place)) return;

    this.onPlaceClick?.(place);
  }
}

/** The accessible name of a cell: position, what stands on it, and why it is clickable. */
function cellLabel(cell: CellView, t: Translator): string {
  const position = t("board.cell.position", { x: cell.x + 1, y: cell.y + 1 });
  const top = displayedPiece(cell);
  if (top == null) {
    return t(cell.highlight ? "board.cell.emptyDestination" : "board.cell.empty", { position });
  }

  const parts = [
    PieceRenderer.describe({ type: top.type, owner: top.owner, isActive: top.isActive }, t),
  ];
  if (cell.pieces.length > 1) parts.push(t("board.cell.stack", { count: cell.pieces.length }));
  if (cell.pieces.some((piece) => piece.selectable)) parts.push(t("board.cell.selectable"));
  if (cell.pieces.filter((piece) => piece.selectable).length > 1) parts.push(t("board.cell.cycle"));
  if (cell.highlight) parts.push(t("board.cell.legalDestination"));
  return `${position}: ${parts.join(", ")}`;
}

function displayedPiece(cell: CellView): CellView["pieces"][number] | undefined {
  return cell.pieces.find((piece) => piece.selected) ?? cell.pieces[0];
}
