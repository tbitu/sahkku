# Sáhkku (Digital Sáhkku)

A digital implementation of **Sáhkku**, a traditional Sámi running-fight board game with centuries of
history.

The whole game is modern TypeScript: one engine-agnostic rules core, a set of interchangeable player
agents, a headless match runner and benchmark, and an open-license 2D board that plays in the browser.
There is no game engine, no 3D runtime, no WebAssembly and no proprietary asset pipeline — everything
the client draws is CSS and inline SVG, and every dependency is open source.

The published Unity WebGL build is still playable at [itch.io](https://zhamul.itch.io/digital-shkku);
this repository now builds the 2D web client described below.

---

## Features

- **Data-driven rules engine** (`src/rules/`): a dependency-free port of the rules core. The board, the
  figure-of-eight track, the pieces, the four-sided dice, the activation queue, the variants and the win
  conditions are all read from [`src/rules/SahkkuRules.json`](src/rules/SahkkuRules.json), which is the
  single authoritative specification of the game. The engine validates every move and can report the
  invariants of any state.
- **Pluggable player agents** (`src/agents/`), one interface (`PlayerAgent`) for every seat:
  - **Human** — the browser board, or the headless runner with `--p1 human`.
  - **Random** — baseline randomized move selection.
  - **Heuristic** — greedy agent evaluating captures, piece advancement and the king.
  - **LLM** — any OpenAI-compatible `/v1/chat/completions` endpoint (LM Studio, Ollama, vLLM, OpenAI),
    with a request deadline and a heuristic fallback, so a dead endpoint cannot freeze a match.
- **Headless match runner and benchmark** (`src/cli/`): plays bot-vs-bot or LLM-vs-bot matches at full
  speed, applies the turn cap and the timeout rules, and reports the run as a table or as JSON.
- **Open-license 2D web client** (`src/ui/`): a fluid 15 × 3 carved board, three SVG *birccu* dice with
  the ruleset's spending order, capture counters, rule-event banners, an end-of-match card, match setup
  (single player against a bot, local hot-seat, spectator bot-vs-bot, pace, variant, starting player) and
  a rules/help modal.
- **Localization** (`src/locale/`): North Sámi (`se`), Norwegian (`no`) and English (`en`) string tables,
  switched live from the toolbar — every piece of chrome, an open dialog included, re-letters at once.
- **Sound and settings** (`src/audio/`, `src/ui/settings.ts`): Web Audio cues synthesised at runtime (no
  audio files), master and sound-effect volumes, mute, and the LLM endpoint, model and timeout — all
  persisted in `localStorage` and read back on the next start.
- **Verification**: 247 Vitest unit tests over the rules, agents, CLI, audio, locale, settings and match
  controller, plus a headless Playwright suite that drives the real bundle in a real browser.

---

## Quick start

```bash
npm install          # rules core, agents, CLI, web client and their tests
npm run dev          # local web server on http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server for the 2D web client (`http://localhost:5173`). |
| `npm run build` | Builds the static client into `dist/`. |
| `npm run preview` | Serves the built bundle (`http://localhost:4173`). |
| `npm test` | Runs the 247 Vitest unit tests. |
| `npm run test:watch` | The same suite in watch mode. |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/`. |
| `npm run bench -- …` | Plays headless matches and evaluation benchmarks. |
| `npm run test:e2e` | Builds the client and runs the Playwright browser suite (see below). |

### Headless matches and benchmarks

```bash
# Ten games between the heuristic and the random agent
npm run bench -- --games 10 --p1 heuristic --p2 random

# A hundred games, summarised as JSON
npm run bench -- --games 100 --p1 heuristic --p2 random --json

# A match against an LLM endpoint
npm run bench -- --p1 heuristic --p2 llm --endpoint http://localhost:1234/v1 --model pairflow-player

# A reproducible run, one line per game
npm run bench -- --games 20 --seed 42 --verbose
```

`npm run bench -- --help` lists every option. The runner hands every action to the engine and checks the
board after each one, so a rule violation ends the run with exit code 1 instead of producing a
plausible-looking benchmark.

The endpoint and model for LLM seats can also live in a shared `llm-config.json`, discovered upwards from
the working directory or named by `SAHKKU_LLM_CONFIG`; the in-game settings dialog owns the same two
values for the browser client.

### Browser end-to-end tests

The Playwright harness lives in [`Tools/PlaywrightTests/`](Tools/PlaywrightTests/) and keeps its own
dependencies:

```bash
npm --prefix Tools/PlaywrightTests install                     # once: the harness's dependencies
npx --prefix Tools/PlaywrightTests playwright install chromium  # once: the browser binary

npm run test:e2e                                               # build the client, serve it, run the suite
```

The suite builds and serves the shipped bundle on `http://localhost:4173`; set `SAHKKU_E2E_URL` (or
`BASE_URL`) to test an already deployed client instead. It verifies a clean cold launch (board, dice,
zero console errors), interactive piece selection with highlighted destinations and a committed move, a
full human-vs-bot turn with the bot answering and handing the turn back, live language switching, and the
settings dialog's persistence across a reload.

---

## Project structure

```
src/rules/       Rules engine, ruleset model, board track, ruleset JSON (the specification)
src/agents/      PlayerAgent implementations (human, random, heuristic, LLM) and the LLM config file
src/cli/         Headless match runner, benchmark statistics and the `npm run bench` entry point
src/ui/          Board, dice, pieces, dialog, help, settings views and the match controller
src/audio/       Web Audio synthesised sound effects
src/locale/      `se` / `no` / `en` string tables and the translator
src/main.ts      Composition root: wires the engine, the controller, the views, the language and the sound
tests/           Vitest suites, mirroring the source layout
Tools/PlaywrightTests/  Playwright configuration and the browser end-to-end suite
Docs/            rules-engine.md (engine specification) and rules-alignment.md (historical notes)
index.html       The single entry document of the web client
```

### How it fits together

- **The ruleset is data, not code.** `SahkkuRules.json` declares the board and its carved cells, the
  track's legs and directions, the dice and their spending order, the pieces' movement patterns, the
  activation queue, the variants and the win conditions. The engine derives everything from it, so a
  different ruleset paints a different board without a line of client code changing.
- **Agents decide; the engine rules.** A `PlayerAgent` picks a move from the legal moves it is handed.
  Every action a bot proposes goes back through the engine's legality check, so a misbehaving agent can
  lose a turn but can never corrupt the position.
- **The client is a view of a view model.** `WebMatchController` owns the interaction model — whose turn
  it is, what is selectable, what is highlighted, what the tray offers — and publishes an immutable
  snapshot that `src/main.ts` paints with the board, the dice and the chrome. The same controller plays
  the automated seats through a `BotDriver` at a configurable pace.
- **Preferences are the only state the client keeps.** Volumes, mute, language and the LLM endpoint,
  model and timeout live in `localStorage["sahkku_settings"]`, normalized on read: a hand-edited or
  unavailable store degrades to the defaults rather than to an error.

---

## License and attribution

Sáhkku is a **traditional game of the Sámi people**. Any use of this material in a Sáhkku/game context
must say so — that notice is part of the license, not a courtesy.

The project is released under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) (see
[`License.txt`](License.txt)): attribution, non-commercial use and share-alike. The code, the procedural
SVG artwork and the synthesised sound effects are original to this repository, and the toolchain it
builds on (TypeScript, Vite, Vitest, Playwright, `tsx`) is open source.
