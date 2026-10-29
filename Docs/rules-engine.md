# Sáhkku rules engine

The rules of Sáhkku are not hard-coded in the client. They live in a JSON ruleset that is interpreted
by a dependency-free TypeScript engine, shared by the browser game and by the NPC/LLM tooling.

The ruleset is the single source of truth: every rule decision the engine makes is selected by a value
in `src/rules/SahkkuRules.json`. There is a test (`NoSchemaFieldIsLeftUnread`) that fails when a key is
added to the JSON that the engine never consults, so a rule can never be written and silently ignored.

## Layers

| Layer | Module | Responsibility |
| --- | --- | --- |
| Rules engine | `src/rules/` | Board/domain types, the track, JSON ruleset parsing, all rule decisions |
| State formatting | `src/rules/formatter.ts` | ASCII board and dice rendering and the LLM prompt context |
| Player agents | `src/agents/` | The `PlayerAgent` seam and its human/random/heuristic/LLM implementations |
| Match controller | `src/ui/controller.ts` | Owns the interaction model: rolls, asks the active `PlayerAgent` for the re-roll and the move, and falls back to the heuristic agent when an agent fails. Decides no rule itself |
| Presentation | `src/ui/` (plus `src/audio/`, `src/locale/`) | Board/dice rendering, turn banner, input and sound; answers the human half of the interaction |
| Benchmark tool | `src/cli/` (`npm run bench`) | Plays bot-vs-bot and LLM-vs-bot matches through the engine, applies the turn-cap/timeout rules, and reports the run as a table or as JSON |

The engine imports nothing but its own modules — no DOM, no Node API, no third-party code — so the same
rule code runs in the browser, in a web worker, in the headless benchmark and in the tests.

### Engine API (`src/rules/engine.ts`)

```ts
initGame(options: EngineOptions, random?: IRandomSource | null): GameState;
throwForStartingPlayer(random: IRandomSource): PieceOwner; // "first to roll X starts" (see start.mode)
rollAllDice(state: GameState, random: IRandomSource): void;
rollDice(state: GameState, random: IRandomSource): void;
rollAndBeginTurn(state: GameState, random: IRandomSource): void; // roll + order + open the move phase
orderDice(state: GameState): void;                                // the ruleset's spending order
rerollFirstDie(state: GameState, random: IRandomSource): void;
applyRerollDecision(state: GameState, decision: RerollDecision, random?: IRandomSource | null): void;
canReroll(state: GameState): boolean;
evaluateAllowedPlaces(state: GameState): boolean;    // fills Piece.allowedPlaces; true if any move exists
getLegalMoves(state: GameState): Move[];             // the cached view (call evaluateAllowedPlaces first)
legalMoves(state: GameState): Move[];                // the same list, computed from scratch
isLegalMove(state: GameState, move: Move): boolean; // pure legality check
getAllowedPlaces(state: GameState, piece: Piece): number[]; // board cells
getAllowedArcs(state: GameState, piece: Piece): number[];   // the authoritative form (track arcs)
applyMove(state: GameState, move: Move): RuleEvent[];       // throws IllegalMoveException on an illegal move
tryApplyMove(state: GameState, move: Move): { success: boolean; events: RuleEvent[] };
nextPlayerTurn(state: GameState): void;
validateState(state: GameState): string[];           // invariants; an empty list means sound

// track helpers (for hosts, tooling and tests)
get trackLength(): number; placeOfArc(owner, arc): number; arcOfPlace(owner, place): number;
homeRowOf(owner): number;
```

`Piece`/`Place`/`GameState`/`Move`/`RuleEvent` and the enums (`PieceType`, `PieceOwner`, `DieFace`,
`TurnPhase`, `WinReason`) live in `src/rules/domain.ts`; the track lives in `src/rules/track.ts`.

`applyMove` **refuses illegal moves** (`IllegalMoveException`) so that no caller — UI, replay file,
network message or LLM — can drive the game into an illegal position. `tryApplyMove` is the
non-throwing form, and `GameState.clone()` lets a search (or a test) try a move without touching the
live game.

`applyMove` returns `RuleEvent`s (`PieceMoved`, `SoldierCaptured`, `KingRecruited`, `QueenCaptured`,
`GameWon`); the controller maps them to `AudioManager` cues. When the game ends the engine also sets
`GameState.winner` and `GameState.winReason`, so the host never has to re-derive *why* it ended. The
engine itself never touches audio, visuals or the DOM.

## The track (why pieces carry an `arc`)

Soldiers, the king and the queen walk an "8"-shaped track: **right along your home row, left along the
middle row, right along the enemy row, left along the middle row again, and then down into your home row
to start over.** The enemy row is visited once per lap but the middle row is visited twice, so a lap is
`4 × board.width` cells long while the board only has `3 × board.width`.

Two consequences shape the engine:

* A piece's position cannot be recovered from its board cell: the same middle-row cell is reached on the
  way out and on the way back, and what happens at the end of that row differs. Every piece therefore
  stores the **arc** it stands on (`Piece.arc`), and `Piece.placeIndex` is the board cell that arc points
  at. A move is *"advance N arcs"* and the board cell follows.
* Bends between rows are part of the same straight move. Stepping from the end of the home row onto the
  middle row counts as going forwards, which is what lets the king "go around a bend" without turning.

`track.legs` describes one lap for player 1 in board coordinates; the second player's lap is the board
mirror of it, because the two players sit at opposite ends of the same board.

## The JSON ruleset

The ruleset is authored by hand at `src/rules/SahkkuRules.json` and loaded through
`loadShippedRuleset()` / `RuleSetJson.fromJson()`. It has no schema of its own: `RuleSetJson` maps the
document onto `RuleSet` field by field, so a misspelled key is caught by `validate()` and by
`NoSchemaFieldIsLeftUnread` rather than silently ignored.

Top-level sections:

| Key | Meaning |
| --- | --- |
| `board` | `width`, `height`, `layout` (`rowMajorSnake` = row 0 left→right, row 1 right→left, row 2 left→right) |
| `track` | `legs`: the cells of one lap, in order, as `{row, direction}` pairs (`direction` is `right`/`left`) |
| `pieces` | `soldier`, `queen`, `king` rule primitives (see below) |
| `dice` | die count, the face table, the spending order and the re-roll rule |
| `activation` | how activating a piece unlocks the next one in the queue |
| `inactive` | what may happen to pieces that have not been activated yet |
| `start` | how the starting player is decided |
| `setup` | starting cells for soldiers, queens and the neutral king |
| `variants` | `standard` and `evenOdds` starting positions |
| `win` | winning conditions |

Per-piece primitives:

| Key | Meaning |
| --- | --- |
| `moves` | `forward`, `backward` (along the track) and `vertical` (same x, y ± the die value) |
| `movesScaleWithDie` | the step count comes from the current die (otherwise a single step) |
| `startActivatable` | can be activated at the start of the game (queens) |
| `queuesNextOnActivation` | activating it unlocks the next piece in the activation queue |
| `blocksOwnLanding` | other pieces of the mover's side may not land on it |
| `cannotLandOnOwnUnits` | it may not land on a piece of the mover's side |
| `capturable` | landing on it removes it and scores a capture |
| `recruitedWhenLanded` | landing on it changes its owner instead of removing it (king) |
| `landingEndsGame` | landing on it ends the game in the mover's favour (queen) |
| `recruitsKingOnEnemyHomeRow` | reaching the opponent's home row recruits the neutral king (soldier) |

The remaining sections:

| Key | Meaning |
| --- | --- |
| `dice.faces[].steps` | what each face is worth (`sahhku` 1, `three` 3, `two` 2, `zero` 0) |
| `dice.activateFace` | the face that activates a piece |
| `dice.useOrder` | the order faces must be spent in: X, then III, then II, then blank |
| `dice.reroll.faces` | the faces that may be thrown again (the sáhkku X) |
| `dice.reroll.beforeUsingAnyDie` | re-rolls are only offered before any die of the throw is spent |
| `activation.onMoveInactivePiece.unlockOffset` | home-row lines between the mover's source line and the piece that becomes activatable (-1 = the next soldier in the queue) |
| `inactive.enterable` | false = no piece may be moved onto a line holding an unactivated piece |
| `start.mode` | `firstSahhku` (players throw in turn, the first X starts) or `mostSahhku` |
| `variants.*.soldiersActive` | how many leading soldiers start loose and one step forward along their track; the next one starts activatable |
| `win.opponentSoldiersExhausted` | you win when the opponent has no soldiers left |

`RuleSet.validate()` (called by `RuleSetJson.fromJson`) rejects malformed rulesets with a descriptive
`RuleSetException`: unknown face ids, a spending order that skips a face, a track whose legs do not join
end-to-end with a bend, overlapping setup cells, a variant that leaves no soldier to activate, and a
ruleset with no way to win.

## Tests

`npm test` (Vitest) runs the suites under `tests/`:

* `tests/rules/rules.test.ts` covers board mapping, the track (including the second pass over the middle
  row and a full lap), standard/even-odds setup, movement per piece/die, capture, recruit, king
  activation, `landingEndsGame`, the ruleset-driven variants of those rules, move validation, dice
  ordering, re-roll conditions, turn transitions, JSON validation, state invariants and two seeded
  full-game simulations.
* `tests/agents/` covers the human/random/heuristic agents and the LLM NPC against a scripted transport.
* `tests/cli/` covers the headless match runner, its statistics and its fallback counter. The LLM
  suites drive a scripted transport, so the whole suite runs offline.
* `tests/ui/` covers the settings store, the interaction model and the game modes.

The engine needs only its own modules, so the same suite also runs headlessly anywhere Node runs:

```bash
npm test          # the whole Vitest suite
npm run typecheck # tsc --noEmit over src/ and tests/
npm run test:e2e  # the Playwright browser suite (see README.md)
```

## Deliberate behaviour, pinned by tests

On the web board, repeated clicks on a shared cell cycle through its currently movable pieces
(including a recruited king and its soldier). Enter or Space on the focused cell does the same.
The token and accessible name show the selected piece; clicking a highlighted destination commits
that piece's move. Selecting or cycling does not spend a die.

* Dice are spent in `dice.useOrder` (X, III, II, blank), so the sáhkku goes first and a blank face last.
* Only the die currently up for spending can be re-rolled, and only while a sáhkku shows
  (`beforeUsingAnyDie`). With several X's the player presses the button once per die, because the
  ruleset re-sorts the dice after every re-roll.
* `evenOdds` marks the three foremost soldiers *loose in place*: they are activated but have not made
  their activation move.
* Landing on your own active soldier is allowed (soldiers stack) and the mover still counts as moved.
* The `RandomPlayerAgent` CPU keeps the original random draw, including its `Clamp(Range(0, 4), …)`
  bias.
* A soldier reaching the opponent's home row recruits the neutral king and announces it with a
  `KingRecruited` event (the pre-engine code recruited the king silently).

## Rule traceability

Every clause of the player-facing rules maps onto a ruleset field and a test:

| Rule (PDF / Reaidu) | Ruleset | Test |
| --- | --- | --- |
| Three dice X/III/II/blank; X = 1 step, activate, or re-roll | `dice` | `ShippedRuleset_DescribesTheVuonnamarkanGame` |
| Faces must be spent X, then III, then II; you lose the II if the III has no move | `dice.useOrder` | `OrderDice_SpendsThreeBeforeTwoBeforeBlank`, `RollAndBeginTurn_HandsOverWhenNoDieCanBeUsed` |
| When you roll X you may throw those dice again | `dice.reroll` | `Reroll_DoesNotRequireAnAlreadyActivePiece`, `Reroll_IsOnlyOfferedBeforeAnyDieHasBeenSpent` |
| Soldiers are activated in queue order, foremost first; activating moves them one line | `activation`, `queuesNextOnActivation` | `MovingAnInactiveSoldier_MakesTheNeighbourActivatable`, `InactiveSoldier_NeedsSahhkuAndActivation` |
| Unactivated pieces cannot move, be captured, or have their line entered | `inactive.enterable` | `Soldier_CannotLandOnInactiveOpponent`, `InactiveRule_ComesFromTheRuleset` |
| The "8"-shaped track, including the second middle-row pass and the return home | `track.legs` | `Track_WalksTheFigureOfEightAndReturnsToTheHomeRow`, `SecondPassOverTheMiddleRow_DescendsIntoTheHomeRow`, `Soldier_FullLap_ReturnsToItsStartingCell` |
| Both players walk mirrored tracks | the `track` mirror | `Track_IsTheBoardMirrorForTheSecondPlayer` |
| Every piece on a line is captured | `capturable` | `CapturingASoldier_ScoresAndRemovesIt` |
| Royal pieces never share a line, except when recruiting the king | `blocksOwnLanding`, `cannotLandOnOwnUnits`, `recruitedWhenLanded` | `Soldier_CannotLandOnOwnQueenOrKing`, `LandingOnTheKing_RecruitsIt` |
| The king crosses rows only with the exact die value, and goes around bends | `moves` | `King_CrossesRowsOnlyWithTheExactDieValue`, `King_CrossingAtTheBendIsAlsoAStraightStep` |
| The king is recruited when a soldier enters the enemy home row | `recruitsKingOnEnemyHomeRow` | `MovingASoldierIntoEnemyTerritory_ActivatesTheNeutralKing`, `KingRecruitmentComesFromTheRuleset` |
| The queen starts unactivated and may be activated in any direction | `startActivatable` | `Queen_MovesForwardBackwardAndVertically` |
| Losing the queen loses the game; losing every soldier loses the game | `landingEndsGame`, `win` | `CapturingTheQueen_EndsTheGame`, `CapturingEveryEnemySoldier_EndsTheGame`, `LosingTheQueenOnlyEndsTheGameWhenTheRulesetSaysSo` |
| "The first one to get X starts" | `start.mode` | `ThrowForStartingPlayer_FirstSahhkuStarts` |
| "Like odds": three soldiers are taken loose | `variants.evenOdds.soldiersActive` | `InitGame_EvenOdds_MarksTheThreeForemostSoldiersLoose` |

## Agents (`src/agents/`)

`PlayerAgent` is the seam. A side is played by a `HumanPlayerAgent` (which forwards both decisions to
the injected interaction, implemented by the web client), a `RandomPlayerAgent` (the AI the game
shipped with), a `HeuristicPlayerAgent` (deterministic scoring; also the controller's fallback) or an
`LlmPlayerAgent` (an LLM NPC behind an OpenAI-compatible endpoint).

### The LLM NPC (`src/agents/llm.ts`)

`LlmPlayerAgent` asks the model to rank the options the engine already declared legal:

1. The prompt is `GameStateFormatter.formatPromptContext(state, legalMoves)` - the authoritative board,
   the dice in spending order and every legal move as a numbered list — plus the JSON contract
   (`{"move_index": N, "reasoning": "..."}`, or `{"reroll": true, "reasoning": "..."}` for the optional
   sáhkku re-roll). The chat-completions body is built as plain JSON.
2. The parser reads the answer: the `choices[0].message.content` envelope, Markdown fences, quoted
   numbers and JSON embedded in prose, and gives up (returns `null`) rather than throwing.
3. The move is taken from `legalMoves[moveIndex]`, so an accepted proposal is legal by construction and no
   model output can mutate the state. A forced move (one legal option) skips the round trip entirely.

Every failure — no endpoint, connection refused, HTTP non-200, timeout, an unusable answer, an index
outside the list, a re-roll the engine does not offer — logs once and falls back to
`HeuristicPlayerAgent`, so a missing model degrades the opponent instead of breaking the match. A
cancelled match is the one case that propagates (`AbortSignal`): "the model was too slow" stays
distinguishable from "the match ended".

`src/ui/settings.ts` supplies the endpoint, the model name and the timeout (`llmEndpoint`, `llmModel`,
`llmTimeoutSeconds`, persisted in `localStorage["sahkku_settings"]`); `src/agents/config.ts` reads the
same two values from a shared `llm-config.json` for the headless benchmark. The settings dialog's
"LLM opponent" section only stores those connection details and the fallback notice — it does not pick
an agent. Which agent plays a seat is chosen in the match-setup toolbar: the mode select decides which
seats are human, and the player-two bot select (`#bot2-select`, wired in `src/main.ts`) restarts the
match with the chosen bot kind — Heuristic, Random or LLM (`BotKinds` in `src/ui/controller.ts`).

## Headless benchmark (`npm run bench`)

`src/cli/` plays matches off-engine — no browser, no renderer — with the same rules and the same agents:

```bash
# `--help` lists every flag.
npm run bench -- --games 100 --p1 heuristic --p2 random
npm run bench -- --games 10 --p1 llm --p2 heuristic --json
```

`MatchRunner` owns one game and decides no rule itself: it rolls, asks the active agent
(`decideReroll` while `canReroll`, `decideMove` while a die is up for spending), checks every proposal
with `isLegalMove` before handing it to `applyMove`, and runs `validateState` after every change.
The failure rules the harness has to follow are the same ones the game follows:

* An illegal proposal or a broken invariant is a **rule violation**: the game is aborted, the reason is
  recorded, and the run exits `1`. The runner never substitutes a move to get past one.
* `--max-turns` turns a game that runs past the cap into a **draw** (`winner`/`winReason` `None`), which is
  a result, not a failure.
* A per-turn deadline turns an agent that does not answer into a **failed game**, which also exits `1`.

`BenchmarkSummary` folds the games into win rates, half-move averages, captures, re-roll counts and LLM
fallbacks, printed as a table or as JSON (`--json`). The fallback number comes from `LlmFallbackCounter`,
which reads the agent's own log lines: the agent logs its decisions (which carry the model's free-form
reasoning) and its fallbacks, so the counter matches a fallback on the *shape* of the line — the sentence
it starts with — rather than by looking for a phrase anywhere in it, which a model echoing the agent's
wording inside its reasoning would otherwise inflate. Runs are reproducible: with `--seed` the dice come
from `SeededRandomSource` — SplitMix64 written out, so a runtime upgrade cannot change a seed's games — and
the random bots draw from the same generator.
