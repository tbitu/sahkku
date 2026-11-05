---
artifact_type: plan
artifact_id: plan_sahkku_ts_refactor_and_2d_frontend_v1
plan_id: sahkku-ts-refactor-and-2d-frontend
created_on: "2026-09-29"
title: "Complete Refactor: TypeScript Rules Core, Agents, and Open-License 2D Web Frontend"
status: done
plan_status: done
prd_ref: null
owners:
  - "tarjeib"
task_order:
  - 1-ts-rules-core-and-tests
  - 2-ts-agents-and-cli-bench
  - 3-open-2d-web-board-frontend
  - 4-modes-settings-audio-locale
  - 5-e2e-tests-and-csharp-sunset
active_task_id: null
last_completed_task_id: 5-e2e-tests-and-csharp-sunset
archive_group: 2026-09-29-sahkku-ts-refactor-and-2d-frontend
task_tracker:
  - task_id: 1-ts-rules-core-and-tests
    task_path: plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/1-ts-rules-core-and-tests.md
    status: archived
    notes: "Port C# Sahkku.Rules core (Domain, RuleSet, Track, RulesEngine, GameStateFormatter) to strict TypeScript with 100% parity of all 139 unit tests in Vitest against SahkkuRules.json."
  - task_id: 2-ts-agents-and-cli-bench
    task_path: plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/2-ts-agents-and-cli-bench.md
    status: archived
    notes: "Port player agents (Human, Random, Heuristic, LLM Agent with fetch/OpenAI client) and headless CLI match runner/benchmark tool to TypeScript."
  - task_id: 3-open-2d-web-board-frontend
    task_path: plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/3-open-2d-web-board-frontend.md
    status: archived
    notes: "Build an open-license, dependency-light 2D web board game interface with Vite, featuring 15x3 board layout, piece movement/selection, 2D dice roller, and turn orchestration."
  - task_id: 4-modes-settings-audio-locale
    task_path: plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/4-modes-settings-audio-locale.md
    status: archived
    notes: "Implement game modes (Single-player AI, Local 2P hotseat, Bot-vs-Bot), settings modal (LLM endpoint config), Web Audio sound effects, and tri-lingual localization (Sámi, Norwegian, English)."
  - task_id: 5-e2e-tests-and-csharp-sunset
    task_path: plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/5-e2e-tests-and-csharp-sunset.md
    status: archived
    notes: "Verify complete browser gameplay via Playwright E2E suite, update pairflow.toml CI/validation commands, sunset Unity/C# assets and projects, and update documentation."
---

# Plan: Complete Refactor – TypeScript Rules Core, Agents, and Open-License 2D Web Frontend

## Objective

Completely refactor the Digital Sáhkku project by replacing the entire C# codebase and proprietary Unity runtime with an engine-agnostic, 100% TypeScript stack and a completely open-source, license-free, 2D web frontend:
1. **Pure TypeScript Rules Core**: Port [`Sahkku.Rules`](file:///home/tarjeib/repo/Sahkku/Sahkku/Assets/Scripts/Rules/RulesEngine.cs) to modern strict TypeScript with zero external dependencies, preserving [`SahkkuRules.json`](file:///home/tarjeib/repo/Sahkku/Sahkku/Assets/Resources/SahkkuRules.json) as the authoritative data-driven ruleset specification and maintaining 100% test parity with all 139 existing unit tests in Vitest.
2. **TypeScript Player Agents & Headless Benchmark**: Port Human, Random, Heuristic, and OpenAI-compatible LLM agents to TypeScript, alongside a fast headless CLI match runner and benchmark tool (`npm run bench`).
3. **Open-License 2D Web Frontend**: Deliver a lightweight, visually pleasing, non-3D 2D tabletop interface built with Vite, HTML5 Canvas/SVG, and modern CSS/Tailwind. The UI features a top-down wooden board representing the traditional 15x3 layout, figure-of-8 track navigation, distinct 2D piece tokens (Women, Men, Queen, King), a 2D Sáhkku dice roller, piece selection and move destination highlighting, and fluid turn orchestration.
4. **Game Modes, Settings, Audio & Localization**: Support Single-Player (vs Heuristic, Random, or local LLM), Local 2-Player Hotseat, and Bot-vs-Bot spectator matches, with in-browser LLM endpoint configuration, open Web Audio sound effects, and tri-lingual localization (North Sámi `se`, Norwegian `no`, and English `en`).
5. **Full E2E Verification & Unity Retirement**: Verify the complete web experience with automated Playwright browser tests, update `pairflow.toml` to validate against TypeScript build and test commands, retire the legacy Unity and C# files, and update documentation.

## Done Definition

1. **Rules Core Parity**:
   - `npm test` runs a comprehensive Vitest suite covering board mapping, track traversal, piece movement, captures, king recruitment, queen victory conditions, dice spending order, reroll mechanics, ruleset validation, and deterministic game simulations.
   - All 139 test cases from the legacy C# suite pass with 100% parity against the exact same [`SahkkuRules.json`](file:///home/tarjeib/repo/Sahkku/Sahkku/Assets/Resources/SahkkuRules.json).
2. **Headless CLI Parity**:
   - `npm run bench -- --games 20 --p1 heuristic --p2 random` executes simulated matches headlessly without browser or graphics, reporting win rates, turn counts, and captures with zero illegal move violations.
3. **Open-License 2D Frontend Quality**:
   - Zero proprietary engine dependencies (no Unity, no closed-source libraries, no commercial 3D assets). The tech stack is 100% open-source (MIT/Apache-2.0/CC-BY-NC-SA 4.0 compliant).
   - Clean top-down 2D board with clear visual distinction between rows, carved cells, active pieces, inactive home-row pieces, and piece stacks.
   - Responsive layout functioning seamlessly on desktop and mobile web browsers without WebGL/WebAssembly startup delays or memory bloat.
4. **Gameplay & Interaction Completeness**:
   - Interactive piece selection highlights all legal destination cells computed by the rules engine.
   - 2D dice roller clearly presents the three traditional elongated Sáhkku dice faces (Sáhkku `X`, `III`, `II`, `blank`), enforces spending order, and offers optional reroll actions when a Sáhkku face shows.
   - Match loop handles all turns, state transitions, victory banners, and event notifications (captures, king recruitment) without UI freezes or unhandled exceptions.
5. **Playwright E2E & Pairflow Integration**:
   - Playwright end-to-end tests verify cold start, hotseat match play, bot match play, settings configuration, and localization switching in headless Chromium.
   - `pairflow.toml` validation commands (`build`, `test`, `bootstrap`) execute npm-based commands with zero dependencies on the .NET SDK or Unity.
   - Legacy C# directories (`Sahkku/`, `Tools/RulesTests/`, `Tools/SahkkuBench/`) are cleanly retired.

## Capability Closure

| Capability Claim | Closure Classification | Activation Path | Repo-Provided Boundary | External Prerequisites | Last-Mile Proof |
|---|---|---|---|---|---|
| Pure TypeScript Rules Engine | end_to_end | `RulesEngine` class & `initGame()` | `src/rules/` (`engine.ts`, `domain.ts`, `track.ts`, `ruleset.ts`, `formatter.ts`) | Node.js (>= 18) | Vitest suite (`npm test`) passing all 139 ported rule tests |
| TypeScript Agents & Headless CLI | end_to_end | `npm run bench` & `MatchRunner` | `src/agents/`, `src/cli/` | Node.js | Automated benchmark simulation CLI producing valid JSON/table stats |
| Open-License 2D Web Board UI | end_to_end | `npm run dev` / `npm run build` | `src/ui/`, `index.html`, `src/web/` | Modern web browser | Browser rendering 15x3 board, piece movements, and 2D dice roller |
| Game Modes, Settings & Locale | end_to_end | UI menu & modal dialogues | `src/ui/components/`, `src/locale/`, `src/audio/` | Web Audio API, optional local LLM endpoint | Interactive hotseat, AI bot play, locale toggle, and audio SFX |
| Automated E2E Verification & CI | end_to_end | `npm run test:e2e` & `pairflow.toml` | `tests/e2e/`, `pairflow.toml` | Playwright / Chromium | Playwright suite asserting full gameplay and zero console errors |

## Guiding Principles

1. **Business Invariant**:
   - [`SahkkuRules.json`](file:///home/tarjeib/repo/Sahkku/Sahkku/Assets/Resources/SahkkuRules.json) remains the single authoritative specification for game mechanics.
   - The TypeScript `RulesEngine` is strictly pure and deterministic. No UI component, agent, network packet, or user gesture may bypass `RulesEngine.applyMove` or directly alter board state.
   - Attribution invariant: Sáhkku is recognized as a traditional game of the Sámi people across documentation and UI credits.
2. **Control Model**:
   - The match controller owns the active match state machine and turn pacing.
   - Legal actions are computed exclusively by `RulesEngine.evaluateAllowedPlaces` and `RulesEngine.legalMoves`.
   - Players and NPCs interact through an asynchronous `PlayerAgent` contract (`decideReroll`, `decideMove`).
3. **Read-Path Rule**:
   - The 2D presentation layer reads directly from immutable `GameState` projections. Piece selectability is governed by `piece.allowedPlaces.length > 0`.
   - LLM prompts are generated using a deterministic `GameStateFormatter` matching the established contract.
4. **Forbidden Fallback**:
   - No 3D engine abstractions (Three.js, Babylon.js, Unity WebGL) or proprietary game assets.
   - Never allow an illegal move to be applied even if proposed by an AI agent or invalid UI click.
   - Never hardcode board track coordinates or piece rules in the frontend presentation code.
5. **Allowed Resolution Path**:
   - If an LLM agent fails, times out, or produces unparseable JSON, the controller falls back to `HeuristicPlayerAgent` for that turn, logs a warning, and continues the match without interruption.
   - If a human player attempts an invalid click, the UI drops the selection with visual feedback without corrupting match state.
6. **Missing-Data Rule**:
   - If the JSON ruleset is missing required fields or violates schema constraints, `RuleSet.validate()` throws a descriptive error on startup and halts execution.
   - Missing locale keys fall back gracefully to North Sámi (`se`) or English (`en`).
7. **Sequencing and Boundary Note**:
   - **Producer-first**: The TypeScript rules engine and test suite (Task 1) must be completed and validated before agents/CLI (Task 2) and frontend UI (Task 3).
   - **Engine-UI Separation**: The 2D web frontend must import `RulesEngine` as an engine-agnostic dependency, ensuring the core remains runnable in Node.js, CLI benchmarks, and web workers.
   - **Deprecation Timing**: Unity and C# directories are removed only in Task 5 after Playwright E2E and Vitest verification succeed.

## Canonical Contract Anchors

1. **Ruleset Source-of-Truth**: [`Sahkku/Assets/Resources/SahkkuRules.json`](file:///home/tarjeib/repo/Sahkku/Sahkku/Assets/Resources/SahkkuRules.json).
2. **Specification Documentation**: [`Docs/rules-engine.md`](file:///home/tarjeib/repo/Sahkku/Docs/rules-engine.md) and [`Docs/rules-alignment.md`](file:///home/tarjeib/repo/Sahkku/Docs/rules-alignment.md).
3. **Existing C# Reference Core**: [`Sahkku/Assets/Scripts/Rules/`](file:///home/tarjeib/repo/Sahkku/Sahkku/Assets/Scripts/Rules/).
4. **Existing Test Reference**: [`Sahkku/Assets/Tests/Rules/RulesTests.cs`](file:///home/tarjeib/repo/Sahkku/Sahkku/Assets/Tests/Rules/RulesTests.cs) (139 passing unit tests).

## Current Status

### Completed Work
1. High-fidelity pure-C# rules engine and 139 NUnit unit tests in [`Tools/RulesTests`](file:///home/tarjeib/repo/Sahkku/Tools/RulesTests/RulesTests.csproj) establishing baseline correctness.
2. Canonical JSON ruleset specification [`SahkkuRules.json`](file:///home/tarjeib/repo/Sahkku/Sahkku/Assets/Resources/SahkkuRules.json) defining board, track, pieces, dice, activation, and variants.
3. Historical rule alignment and comprehensive architectural documentation in [`Docs/`](file:///home/tarjeib/repo/Sahkku/Docs/).

### Open Work
1. Porting the rules core and all 139 tests to TypeScript with Vitest.
2. Porting the agents and CLI benchmark harness to TypeScript.
3. Building the open-license 2D web board game interface and 2D dice roller.
4. Implementing game modes, LLM configuration dialog, Web Audio, and localization.
5. Setting up Playwright E2E tests, updating `pairflow.toml`, and retiring the C# and Unity codebase.

### Deferred / Future Work
1. Online peer-to-peer or WebSocket multiplayer (planned for a subsequent milestone).
2. Additional historical variants from other Sámi regions (e.g., Swedish/Finnish Sámi variants).

## Open Task List

| Task ID | Task Path | Purpose | Depends On | Closes Gap | Status |
|---|---|---|---|---|---|
| `1-ts-rules-core-and-tests` | `plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/1-ts-rules-core-and-tests.md` | Port `Sahkku.Rules` (Domain, RuleSet, Track, RulesEngine, GameStateFormatter) to strict TypeScript with 100% parity of all 139 unit tests in Vitest. | N/A | TypeScript core rules engine & test parity | archived |
| `2-ts-agents-and-cli-bench` | `plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/2-ts-agents-and-cli-bench.md` | Port `IPlayerAgent` interface, Human, Random, Heuristic, and LLM agents, plus the headless CLI match runner and benchmark tool (`npm run bench`). | `1-ts-rules-core-and-tests` | Agent framework and off-engine CLI benchmarking | archived |
| `3-open-2d-web-board-frontend` | `plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/3-open-2d-web-board-frontend.md` | Create the open-license 2D web board game frontend with Vite, 15x3 top-down wooden board, distinct 2D piece tokens, interactive destination highlights, and 2D dice roller. | `1-ts-rules-core-and-tests` | Visual 2D board game client and core match loop | archived |
| `4-modes-settings-audio-locale` | `plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/4-modes-settings-audio-locale.md` | Add Hotseat, AI bot matches, LLM endpoint configuration modal, synthesized/CC0 Web Audio sound effects, and tri-lingual localization (Sámi, Norwegian, English). | `2-ts-agents-and-cli-bench`, `3-open-2d-web-board-frontend` | Game modes, options, audio, and language accessibility | archived |
| `5-e2e-tests-and-csharp-sunset` | `plans/archive/tasks/2026-09-29-sahkku-ts-refactor-and-2d-frontend/5-e2e-tests-and-csharp-sunset.md` | Add automated Playwright E2E browser tests, update `pairflow.toml` validation commands to npm, retire Unity and C# codebase, and update documentation. | `4-modes-settings-audio-locale` | E2E quality validation, CI alignment, and legacy cleanup | archived |

## Coverage Map

| Plan Gap | Closed By | Notes |
|---|---|---|
| C# rules engine replacement | `1-ts-rules-core-and-tests` | Pure TypeScript rules engine in `src/rules/` with zero runtime dependencies |
| Unit test suite parity | `1-ts-rules-core-and-tests` | 139 ported test cases running in Vitest verifying identical rules behavior |
| Agent framework & CLI benchmark | `2-ts-agents-and-cli-bench` | `src/agents/` and `src/cli/bench.ts` supporting bot-vs-bot and LLM evaluation |
| Open-license 2D frontend | `3-open-2d-web-board-frontend` | Lightweight Vite web app with 2D SVG/Canvas board, pieces, and dice |
| Game modes & LLM settings | `4-modes-settings-audio-locale` | Hotseat, AI bot modes, in-browser LLM URL/model config, and Web Audio SFX |
| Tri-lingual localization | `4-modes-settings-audio-locale` | North Sámi (`se`), Norwegian (`no`), English (`en`) string tables |
| E2E verification & Unity retirement | `5-e2e-tests-and-csharp-sunset` | Playwright browser tests, `pairflow.toml` npm update, and C# deletion |

## Dependencies and Order

1. **Phase 1: Rules Core Foundation** (`1-ts-rules-core-and-tests`):
   - Establishes the npm project structure, TypeScript configuration, Vitest test runner, and canonical rules engine.
   - Gate: All 139 ported unit tests must pass before downstream tasks begin.
2. **Phase 2: Agents & CLI Tooling** (`2-ts-agents-and-cli-bench`):
   - Depends on Phase 1 for `RulesEngine`, `GameState`, `Move`, and `GameStateFormatter`.
   - Produces the headless agent implementations and the `npm run bench` command.
3. **Phase 3: 2D Web Board Presentation** (`3-open-2d-web-board-frontend`):
   - Depends on Phase 1 for rules legality and state transitions.
   - Delivers the interactive 2D board, pieces, dice roller, and local match loop.
4. **Phase 4: Match Modes, Settings, Audio & Localization** (`4-modes-settings-audio-locale`):
   - Depends on Phase 2 (agents) and Phase 3 (UI).
   - Plugs in single-player AI, local hotseat, settings modal, sound effects, and tri-lingual translation.
5. **Phase 5: E2E Verification & Legacy Sunset** (`5-e2e-tests-and-csharp-sunset`):
   - Depends on Phase 4.
   - Automates full browser tests with Playwright, updates `pairflow.toml`, purges Unity/C# files, and updates the repository README.

## Risks and Assumptions

1. **Risk: Rule Invariant Divergence during Porting**:
   - *Mitigation*: The test suite from C# (`RulesTests.cs`, 139 tests) is ported 1:1 into Vitest before any UI work begins. Any divergence in move legality, dice ordering, or activation queues will immediately fail tests.
2. **Risk: Frontend Asset Licensing & 3D Baggage**:
   - *Mitigation*: Strictly prohibit 3D engines (Unity, Three.js, Babylon) and proprietary store assets. Use procedural SVG/Canvas rendering, clean CSS, and open/permissive fonts and sound effects (MIT, CC0, CC-BY-NC-SA 4.0).
3. **Risk: Single-threaded Browser Loop & LLM Timeouts**:
   - *Mitigation*: All agent calls use standard asynchronous JavaScript promises with `AbortSignal` timeouts. An unresponsive LLM fallback to the heuristic agent ensures the browser UI never hangs or freezes.
4. **Assumption: Browser Platform**:
   - Modern evergreen browsers (Chrome, Firefox, Safari, Edge) supporting ES2022, SVG/Canvas, and Web Audio API.

## Validation Strategy

1. **Unit Testing (`npm test`)**:
   - 100% parity with legacy C# suite: board coordinate mapping, figure-of-8 track traversals, soldier activation queue, piece landing, captures, king recruitment, queen capture instant win, dice spending order, reroll decision rules, state invariants, and seeded game simulations.
2. **CLI Benchmarking (`npm run bench`)**:
   - Run 100 automated bot-vs-bot games headlessly asserting 0 rule violations, valid statistics generation, and deterministic seed reproducibility.
3. **Playwright E2E Browser Testing (`npm run test:e2e`)**:
   - Automated browser test asserting:
     - Cold launch renders the 2D board, dice, and controls cleanly with zero console errors.
     - Starting a 2P hotseat match allows selecting a piece, viewing destination highlights, rolling dice, and executing a valid move.
     - Starting a Single-Player match against the bot completes bot turns seamlessly without hangs.
     - Language switcher instantly updates text labels across all screens.
4. **CI & Pairflow Validation**:
   - `npm run build` and `npm test` execute cleanly in `pairflow.toml` validation checks without requiring .NET or Unity installations.
