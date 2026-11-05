---
artifact_type: task
artifact_id: task_3_open_2d_web_board_frontend_v1
task_family_id: open-2d-web-board-frontend
sequence_key: "3"
task_id: 3-open-2d-web-board-frontend
title: "Build Open-License 2D Web Board Game Interface with Vite and 2D Dice Roller"
status: archived
phase: implementation
target_files:
  - package.json
  - index.html
  - vite.config.ts
  - src/ui/board.ts
  - src/ui/dice.ts
  - src/ui/pieces.ts
  - src/ui/controller.ts
  - src/ui/style.css
  - src/main.ts
  - tests/ui/controller.test.ts
prd_ref: null
plan_ref: plans/2026-09-29-sahkku-ts-refactor-and-2d-frontend-plan.md
system_context_ref: null
owners:
  - "tarjeib"
doc_bubble_id: null
impl_bubble_id: 3-open-2d-web-board-frontend
supersedes: []
superseded_by: null
archive_group: 2026-09-29-sahkku-ts-refactor-and-2d-frontend
---

# Task 3: Build Open-License 2D Web Board Game Interface with Vite and 2D Dice Roller

## L0: Context & Scope

### Problem Summary
The legacy presentation layer depends on Unity 6 WebGL with 3D mesh models, materials, and heavy WebAssembly runtime. Per project requirements, this must be completely replaced with an open-license, dependency-light, non-3D 2D web client built with Vite, HTML5 Canvas/SVG, and CSS:
1. **2D Board Tabletop**: A 15x3 grid representing the traditional carved wooden Sáhkku board, with clear distinctions between Player 1 home row, middle shared row, and Player 2 home row, plus X carvings on special cells.
2. **2D Pieces & Stacking**: Visual representation of Women (P1 soldiers), Men (P2 soldiers), Queens, and the central neutral/recruited King. Clean differentiation between inactive (home-row seated) and active pieces, plus badge/stack count indicators when pieces share a cell.
3. **2D Sáhkku Dice Roller**: Three elongated 4-sided Sáhkku dice (birccu) rendered in 2D with traditional face markings (Sáhkku `X`, `III`, `II`, `blank`), rolling animation, spending order progression indicator, and optional reroll decision buttons (`Reroll` vs `Keep & Move`).
4. **Interactive Match Controller**: Connects the pure `RulesEngine` to user clicks: highlighting selectable pieces for the active player, highlighting legal destination cells on piece selection, committing moves via `RulesEngine.applyMove`, handling rule events (captures, king recruitment), and displaying turn banners and game-over modals.

### Scope Reality Proof
- **Inspected Requirements**:
  - Open license only (MIT/Apache/CC0, zero proprietary 3D runtime).
  - No 3D (clean 2D board game aesthetic).
  - Connects directly to existing `RulesEngine` in `src/rules/` and `PlayerAgent` in `src/agents/`.
- **Bounded Slice**:
  - Add `vite` dev tooling and scripts to `package.json` (`"dev"`, `"build"`, `"preview"`).
  - `index.html`: Responsive viewport container for game tabletop, dice roller, status bar, and controls.
  - `src/ui/`: `board.ts` (board grid rendering & highlights), `pieces.ts` (2D piece tokens & badges), `dice.ts` (2D dice rendering & reroll buttons), `controller.ts` (web match state machine connecting UI to `RulesEngine`), `style.css` (clean responsive wooden aesthetic).
  - `src/main.ts`: Application entry point initializing local match.
  - `tests/ui/controller.test.ts`: Vitest unit tests asserting match controller state transitions, piece selection, and event handling.

### Scoped Invariants
- `applies_to`: `index.html`, `vite.config.ts`, `src/ui/*`, `src/main.ts`, `package.json`, `tests/ui/*`.
- `does_not_apply_to`: Multi-language string tables and audio synthesizer (deferred to Task 4).
- `proof_surface`: `npm run build` succeeds generating static dist bundle; `npm test` passes all tests; browser serves playable 2D game via `npm run preview` / `npm run dev`.

---

## L1: Implementation Contract

### 1. Functional Requirements

- **REQ_VITE_SETUP**: Add `vite` to `devDependencies` in `package.json`, add scripts `"dev": "vite"`, `"build": "vite build"`, `"preview": "vite preview"`, and configure `vite.config.ts`.
- **REQ_BOARD_VIEW**: In `src/ui/board.ts`:
  - Render 15 columns x 3 rows grid representing the traditional Sáhkku board:
    - Row 0: P1 (Women) home row.
    - Row 1: Middle row (shared battleground traversed twice in figure-of-8 track).
    - Row 2: P2 (Men) home row.
  - Carved ornamentation: Render traditional decorative line borders and "X" carvings on special cells (x=7 y=1 for King start, x=11 y=1 for P1 Queen, x=3 y=1 for P2 Queen, and end-column turnings).
  - Coordinate system aligns 1:1 with `RulesEngine` place indices `(y * 15 + x)`.
- **REQ_PIECE_TOKENS**: In `src/ui/pieces.ts`:
  - 2D SVG / CSS tokens representing:
    - Women (P1 soldiers): Clean stylized conical/triangular tokens in P1 color motif (e.g. warm ochre/crimson).
    - Men (P2 soldiers): Clean stylized tall cylindrical tokens in P2 color motif (e.g. royal blue/teal).
    - Queen: Distinct royal crown/token for each player.
    - King: Traditional central king token, neutral by default, adopting the recruiting player's aura/color once recruited.
  - Inactive vs Active: Inactive soldiers in home rows appear seated/darker; activated soldiers appear bright/raised.
  - Piece Stacking: When multiple soldiers of the same player occupy a cell, display top piece with clear count badge (e.g. `x2`, `x3`).
- **REQ_DICE_ROLLER**: In `src/ui/dice.ts`:
  - Display three 2D elongated Sáhkku dice with traditional carved markings:
    - `sahhku`: "X" (1 step / activate / reroll).
    - `three`: "III" (3 notches).
    - `two`: "II" (2 notches).
    - `zero`: blank face.
  - Spending order indicator: Clearly highlight which die is active/next to be spent.
  - Reroll UI: When the active die is eligible for reroll (`RulesEngine.canReroll`), display prominent "Reroll Die" and "Keep & Move" action buttons.
  - Roll button: "Roll Dice" button for active human roll phases.
- **REQ_INTERACTION_CONTROLLER**: In `src/ui/controller.ts`:
  - Match state machine driving turn progression:
    - Roll phase: Prompt player to roll; animate dice.
    - Reroll phase: If Sáhkku appears, prompt player for reroll decision or advance.
    - Move phase: Calculate legal moves via `RulesEngine.evaluateAllowedPlaces` and `getLegalMoves`.
  - Piece Selection & Movement:
    - Highlight all pieces belonging to current player with `allowedPlaces.length > 0`.
    - Clicking a selectable piece marks it as selected and highlights its legal destination cells on the board.
    - Clicking a highlighted destination cell applies the `Move` via `RulesEngine.applyMove(state, move)`.
    - Clicking elsewhere or another selectable piece cancels or shifts selection.
  - Rule Events: Visual banner notifications for `PieceMoved`, `SoldierCaptured`, `KingRecruited`, `QueenCaptured`, and `GameWon`.
  - Game Over Modal: Displays winner (`P1 (Women)` or `P2 (Men)`) and win reason (`OpponentSoldiersExhausted` or `QueenCaptured`) with "Play Again" button.

### 2. Call-Site Matrix

| Target File | Method / Entity | Description |
|---|---|---|
| `package.json` | scripts | Add `dev`, `build`, `preview` scripts and `vite` dependency. |
| `index.html` | Root document | HTML layout for board container, dice tray, turn banner, modals. |
| `src/ui/board.ts` | `BoardView` | Render 15x3 grid, cell coordinates, and highlight overlays. |
| `src/ui/pieces.ts` | `PieceRenderer` | Render 2D piece graphics, active states, and stack badges. |
| `src/ui/dice.ts` | `DiceView` | Render 3 dice, spend highlights, roll animation, reroll buttons. |
| `src/ui/controller.ts` | `WebMatchController` | Orchestrate match turns, input handling, and rules integration. |
| `src/ui/style.css` | Stylesheet | Styling for board, wooden texture/patterns, pieces, responsive grid. |
| `src/main.ts` | Main entry | Bootstrap UI and launch initial match. |
| `tests/ui/controller.test.ts` | Test suite | Vitest unit tests verifying UI controller match flow. |

### 3. Error and Fallback Handling

- Ignore clicks on illegal destination cells without throwing.
- Ensure `applyMove` is only ever called with moves verified by `isLegalMove`.
- Responsive layout handles screen resizing gracefully down to mobile screens (>= 320px).

### 4. Test Matrix

| Test ID | Input / Scenario | Expected Outcome |
|---|---|---|
| `T3_VITE_BUILD` | `npm run build` | Produces clean `dist/` bundle with zero TypeScript/Vite errors. |
| `T3_CONTROLLER_TESTS` | `npm test -- tests/ui` | MatchController handles piece selection, dice reroll, and turns. |
| `T3_SELECT_HIGHLIGHT` | Select active piece in move phase | Allowed destination cells return non-empty and highlight. |
| `T3_MOVE_APPLICATION` | Click valid destination cell | `applyMove` commits move and updates piece positions. |

---

## L2: Hardening Backlog

- Add touch drag-and-drop gesture support as an alternative to click-to-move.
- Add CSS transition animations for piece movement sliding along board rows.
