# Sáhkku rules: sources, alignment and open questions

This document records **where the executable rules come from**, how the ruleset
(`src/rules/SahkkuRules.json`) was brought in line with them, and what is still genuinely
undecided. It is the companion to [rules-engine.md](rules-engine.md), which describes the engine and the
ruleset schema, and it supersedes the first pass of this analysis (which listed the gaps that are now
fixed).

## 1. Sources of truth

| Source | Role |
| --- | --- |
| `SahkkuRules.pdf` | The player-facing rules, "Lágesvuon sáhkku with Unjárga king (Vuonnamárkan style)". It shipped with the retired C#/Unity client and is no longer in this repository; what it said is what the ruleset before you encodes. |
| `SahkkuRegler.pdf` | The same rules in Norwegian, retired with the same client. |
| [Reaidu / UiT, "Sáhkku"](https://result.uit.no/reaidu/ressurser/aktiviteter/sahkku/) | The reference collection the PDFs link to, by Mikkel Berg-Nordlie. Contains the Lágesvuon chapter, the Unjárga (Vuonnamárkan) king rule, the "like odds" extra rule, and the movement diagram. |
| [Wikipedia: Sáhkku](https://en.wikipedia.org/wiki/S%C3%A1hkku) | The other link in the PDF. Contains the Lágesvuotna chapter and the `Sakkhu path norm.svg` track diagram. |
| [itch.io: Digital Sáhkku](https://zhamul.itch.io/digital-shkku) | The game's own page: confirms the ruleset is the Lágesvuon sáhkku with Unjárga king, "Vuonnamárkan málle", the rules used at the Sáhkku world cup. |

Both PDFs and both web chapters agree on the shape of the game. Where they disagree, the disagreements
are recorded in §5 rather than silently resolved.

## 2. What the rules are

The ruleset is the Lágesvuotna (Laksefjord) variant with the Unjárga king:

* **Board.** Three rows of fifteen lines (`sárgát`). The players' armies start on the rows nearest them;
  each side's queen stands on the marked line four lines in from its own end of the middle row, and the
  neutral king stands on the marked centre line, "the Castle".
* **Dice.** Three four-sided dice marked X, III, II and blank; X is worth one step, III three, II two,
  blank nothing. The faces are *not* optional: you must spend the X's first, then the III's, then the
  II's, and a die you cannot use ends your turn — you may not skip to a later die. When you roll X you
  may throw those dice again, before spending anything.
* **Activation.** A soldier cannot move until it is activated; activating costs an X and moves the
  soldier one line forwards. Soldiers must be activated in queue order, from the one at the front of the
  home row backwards. Unactivated pieces cannot be moved, captured, or have their line entered by
  anybody.
* **The track.** Right along your home row, left along the middle row, right along the enemy row, left
  along the middle row again, then down into your home row and round again: a figure of eight. A soldier
  that reaches the end of the enemy row turns onto the middle row rather than falling off the board, and
  the middle row is walked twice per lap.
* **Capturing.** Moving onto a line holding enemy pieces takes all of them. Active soldiers may share a
  line; royal pieces never may, except that a soldier or queen moving onto the king's line recruits it.
* **The king.** Neutral at the start and immobile until it is recruited. In this variant it is recruited
  the first time a soldier reaches the *opponent's home row*; after that, either side recruits it by
  moving onto its line. It never gets captured, only recruited. It moves like a queen — along the track
  or straight up/down between rows using the exact die value — but may not turn while spending one die;
  going around a bend between two rows counts as going straight.
* **The queen.** Unactivated at the start, activated by an X, then moves exactly like the king. Losing
  her loses the game.
* **Winning.** The opponent having no soldiers left loses, even if they still hold the king; capturing
  the opponent's queen also wins immediately. This is usually how games are decided.

## 3. What changed to make the ruleset the source of truth

The engine used to *look* data-driven while several decisions were still hard-coded, and the track could
not be expressed at all. All of the following now come from the JSON:

| Was hard-coded in the engine | Now in the ruleset |
| --- | --- |
| Movement was `placeIndex ± steps`, so soldiers fell off the end of the enemy row instead of looping (the old README's first known issue) | `track.legs`, and per-piece `Piece.arc` |
| The enemy home row was the index range `>= places.Count - width` / `< width` | derived from the track's legs |
| Unactivated pieces blocked entry through a hard-coded `isActive` check | `inactive.enterable` |
| Only pieces of type `Soldier` advanced the activation queue | `queuesNextOnActivation` per piece |
| Only pieces of type `Queen` ended the game when captured | `landingEndsGame` per piece, now honoured |
| Winning on the 15th capture, with `15` written in both the JSON and the UI | `win.opponentSoldiersExhausted`, checked against the board |
| Dice were ordered by their C# enum value; `dice.order` was validated but never read | `dice.useOrder` |
| The re-roll rule was `rerollFace` + `rerollRequiresFirstDie`, plus an undocumented "you must already have an active piece" condition | `dice.reroll.faces`, `dice.reroll.beforeUsingAnyDie` |
| Even-odds positions were a list of coordinates applied via a lookup that silently ignored cells that held nothing | `variants.*.soldiersActive`, i.e. "the first N soldiers in the queue are loose" |
| The king could be recruited by reaching the enemy home row because of a hard-coded soldier check | `recruitsKingOnEnemyHomeRow` per piece |

Two further guarantees were added, because the rules can only be *trusted* if they cannot be bypassed:

* `ApplyMove` now rejects illegal moves (`IllegalMoveException`) instead of trusting the cached
  `Piece.allowedPlaces`. Previously any caller — a UI bug, a replay file, a future LLM - could move a
  piece anywhere, move the opponent's piece, or move after the game had ended.
* `ValidateState` checks the invariants (each piece on the arc and cell it claims, no place mixing the
  two players, no royal sharing its line outside a recruitment, soldier conservation, a winner whenever
  the game is over) and is asserted after every step of two seeded full-game simulations.

The ruleset is verified headlessly (`npm test`), so it needs no game engine or Unity installation.
`NoSchemaFieldIsLeftUnread` fails if a ruleset key is added that the engine never consults.

The traceability table — one row per rule clause, mapping to the ruleset field and the test that pins it —
is in [rules-engine.md](rules-engine.md#rule-traceability).

## 4. Bugs found on the way

These were found in the C# implementation while it was being ported; each one is fixed in the
TypeScript code.

* **P2's soldier win showed P1's message.** The C# presentation picked the win text from a capture
  counter and used `Player_1_Win_Soldier` in the player-two branch. The engine now reports `WinReason`
  and the client selects one of four correct strings.
* **Capturing the queen scored a soldier.** The capture counter incremented for the queen too, while the
  UI renders the counter as captured *soldier* models. The counter now only counts soldiers.
* **A non-UTF-8 identifier.** `ìnteractionThisFrame` was written as Latin-1 (`0xEC`) in an otherwise
  ASCII C# file; any compiler that reads the file as UTF-8 rejects it. The TypeScript port does not
  carry the file.
* **The enemy-territory king recruitment was silent.** It now emits `KingRecruited`, so the host plays
  the recruitment sound.

## 5. Source conflicts and open questions

These are the places where the sources disagree or fall silent. None of them is currently blocking, and
each is recorded so that a later change is a decision rather than an accident.

1. **Where the queens stand.** Reaidu's Lágesvuon chapter and its board diagram both put each queen on
   the fourth line from its own end of the middle row (x = 11 and x = 3), which is what the ruleset and
   the game use. The English Wikipedia chapter of the same material says "five `sárgát` away" from the
   Castle, i.e. x = 12 and x = 2. **Kept: fourth line** (two independent sources plus the shipped board).
2. **Even-odds starting positions.** The "like odds" extra rule says only that "three of their soldiers
   are taken loose". Because activation also advances a soldier one line, this could mean the three
   foremost soldiers are loose *in place*, or that they have each already made their activation move.
   **Corrected: each initially loose soldier starts one step forward along its normal track**, for
   both players; the foremost one therefore starts on the middle row. The former "loose in place"
   decision was confirmed to be a bug. `soldiersActive` controls how many leading soldiers receive
   this activation step; the next soldier remains activatable in its original home-row position.
3. **What the blank face is worth.** Lágesvuon uses zero ("null flytt"), and the ruleset says 0. Some
   neighbouring variants use four. **Kept: 0**, per the Lágesvuon chapter and the PDFs.
4. **What the king does after being recruited.** The PDFs say the king can be recruited back and forth
   by moving onto its line. Reaidu's *Unjárga reconstruction* chapter notes that the sources are silent
   and suggests a player might take the king every time their soldier enters the enemy home row.
   **Kept: the PDF rule** (first recruitment by entering the enemy home row, then by moving onto it).
5. **Whether a move may jump over pieces.** No source states it either way for this variant, and the
   engine only ever looks at the destination line. Unchanged.
6. **Who starts.** The rules say the players throw dice and the first to roll an X starts; the game also
   lets the player choose in the menu. Both are the engine's (`RulesEngine.throwForStartingPlayer`,
   `start.mode`, tested) and the setup screen offers both: "throw for start" hands the choice to that
   throw and is the shipped default, while the manual pick (women or men) is
   `EngineOptions.startingPlayer`.
7. **Where the rules live in the client.** The retired Unity build opened `SahkkuRules.pdf` from disk,
   which is why its README asked for the PDFs to ship next to a build. The 2D client instead renders an
   illustrated rules dialog (`src/ui/help.ts`) from localized strings and inline SVG, so the rules travel
   with the client and follow the selected language.
8. **Can a royal piece be captured?** The English PDF says "In no other circumstance is it legal to
   move another piece onto a `sárggis` occupied by a royal piece", which read literally would make the
   queen uncapturable and render "if you lose your queen, you have lost the game" dead. Reaidu's
   Lágesvuon chapter says the restriction is *within your own army* — "kan dermed ikke dele linje med
   andre brikker på ditt lag" — and the rest of the rules (capture the queen to win; the queen is
   captured like a soldier) only work that way. **Kept: the restriction is per side**, i.e. a royal may
   not share a line with its own army, while an enemy piece may land on it to capture (queen) or recruit
   (king). This is also what the pre-engine code did.
