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
  - **Easy / Medium / Hard** — one shared whole-board evaluator for soldier material and development,
    activation, mobility, king control and royal safety. Easy chooses one move at a time; Medium
    plans the remaining dice and probes opponent turns; Hard attempts deeper and wider adversarial
    search, including our next response. Opponent choices are deliberate, dice are chance-weighted.
    All levels recognize immediate wins. `heuristic` is a compatibility alias for **Medium**.
  - **LLM** — any OpenAI-compatible `/v1/chat/completions` endpoint (LM Studio, Ollama, vLLM, OpenAI),
    with a request deadline and a **Medium** fallback, so a dead endpoint cannot freeze a match.
- **Headless match runner and benchmark** (`src/cli/`): plays bot-vs-bot or LLM-vs-bot matches at full
  speed, applies the turn cap and the timeout rules, and reports the run as a table or as JSON.
- **Open-license 2D web client** (`src/ui/`): a fluid 15 × 3 carved board, three SVG *birccu* dice with
  the ruleset's spending order, capture counters, rule-event banners, an end-of-match card, match setup
  (single player against a bot, local hot-seat, spectator bot-vs-bot, pace, variant, starting player) and
  a rules/help modal. Bot speed can be changed during a match without resetting the board, dice or turn.
- **Localization** (`src/locale/`): North Sámi (`se`), Norwegian (`no`) and English (`en`) string tables,
  switched live from the toolbar — every piece of chrome, an open dialog included, re-letters at once.
- **Sound and settings** (`src/audio/`, `src/ui/settings.ts`): Web Audio cues synthesised at runtime (no
  audio files), master and sound-effect volumes, mute, and the LLM endpoint, model and timeout — all
  persisted in `localStorage` and read back on the next start.
- **Verification**: Vitest unit tests over the rules, agents, CLI, audio, locale, settings and match
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
| `npm test` | Runs the Vitest unit tests. |
| `npm run test:watch` | The same suite in watch mode. |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/`. |
| `npm run bench -- …` | Plays headless matches and evaluation benchmarks. |
| `npm run bench:strategy -- …` | Paired-seat, both-setup strategic strength evaluation. |
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

# Independent difficulty per seat
npm run bench -- --games 10 --p1 hard --p2 medium --seed 42 --json
```

`npm run bench -- --help` lists every option. The runner hands every action to the engine and checks the
board after each one, so a rule violation ends the run with exit code 1 instead of producing a
plausible-looking benchmark.

### Heuristic difficulty and search limits

The browser defaults to Medium. Difficulty is independent of animation speed and is selected for each
automated seat. Medium/Hard run in a worker; a new game or seat change terminates outstanding work.
Hard deliberately allows longer thinking. Its finite node budget is larger, not a short UI deadline.
The thinking status stays visible while the board remains interactive. An animated indicator marks
an active AI decision (static with reduced motion); elapsed time appears after 10 seconds and resets
for each decision, including cancellation or a new match.

The search uses the rules engine for all moves, captures, recruitment and turn transitions. It
enumerates dice outcomes with exact multiplicities and solves repeat rerolls as an optimal-stopping
problem. Soldier exhaustion and queen capture both win immediately; queen advancement alone does not.
King ownership can transfer, and inactive-piece protection is respected.

Search is **selective**, not an exhaustive solution of Sáhkku. Nonterminal branches are ordered and
limited per difficulty. Resource exhaustion retains the last fully completed layer; a partial set of
roll outcomes is never reported as a complete expectation. Hard completes Medium's search layers
before attempting wider/deeper ones. CLI JSON includes per-seat search counts, completed depths,
budget limits and failures. The static greedy helper is retained only for an explicitly reported
emergency fallback and historical regression fixtures.

Seeded tie-breaking varies only equal-valued root choices; speculative search never consumes the dice
stream. Seeded runs replay within the same AI version. Old `heuristic` game outcomes intentionally
change because that name now selects Medium.

For strength calibration against deliberate attackers (not just random bots):

```bash
# Small calibration run; not a statistically validated difficulty claim
npm run bench:strategy -- --pairs 5 --seed 20261101 --matchup medium-easy --workers 4

# Bounded integration smoke test, never eligible for the strength release gate
npm run bench:strategy -- --pairs 1 --seed 20261112 --matchup medium-hunter --max-turns 100

# Fresh-seed validation: 200 seed blocks × 2 seats × 2 setups = 800 games per matchup
npm run bench:strategy -- --pairs 200 --seed 20271101 --matchup hard-medium \
  --workers 4 --output /tmp/sahkku-hard-medium.json
```

Matchups also include `easy-hunter`, `medium-hunter`, `hard-hunter` and each level versus `legacy`.
The hunter explicitly searches winning multi-die sequences and creates queen threats. The harness
reports paired-seed bootstrap intervals, setup-specific scores, queen losses, exhaustion wins, search
depths and latency distributions. `releaseGate` remains false unless at least 800 games achieve a
60% draw-adjusted score and the paired interval excludes 50%, without failures or a reduced turn cap.
Reports include the turn cap and a policy fingerprint to distinguish changed configurations.
Until those held-out gates pass, the names describe search capabilities, **not certified win-rate
rankings**.

Initial bounded integration samples (not held-out strength certification):

| Matchup | Results for the first level | Turn cap |
|---|---|---|
| Medium vs Easy | 9 wins, 3 losses | 100 |
| Medium vs deliberate hunter | 4 wins | 100 |
| Hard vs Medium | 1 win, 1 loss, 2 draws | 40 |

These samples cover both seats and setups but only three, one and one independent seed blocks,
respectively. Hard is **not yet proven stronger than Medium**. In the Hard–Medium sample, pooled
decision latency reached about 15 seconds at p95 under concurrent validation load; longer thinking
and capped games remain practical limitations. Use the full gates above before declaring a ladder.

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
