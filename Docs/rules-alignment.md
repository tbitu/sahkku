# Sáhkku rules and sources

The executable rules describe the Lágesvuotna (Laksefjord) variant with the Unjárga king,
Vuonnamárkan style. [SahkkuRules.json](../src/rules/SahkkuRules.json) is the authoritative
specification for the game. [rules-engine.md](rules-engine.md) documents the schema, shared engine
and rule traceability tests.

## Sources

| Source | Role |
| --- | --- |
| [SahkkuRules.pdf](SahkkuRules.pdf) | English player-facing rules |
| [SahkkuRegler.pdf](SahkkuRegler.pdf) | Norwegian player-facing rules |
| [Reaidu / UiT, "Sáhkku"](https://result.uit.no/reaidu/ressurser/aktiviteter/sahkku/) | Lágesvuon rules, Unjárga king, like-odds setup and movement diagram |
| [Wikipedia: Sáhkku](https://en.wikipedia.org/wiki/S%C3%A1hkku) | Lágesvuotna chapter and track diagram |
| [Digital Sáhkku](https://zhamul.itch.io/digital-shkku) | Identifies the Vuonnamárkan ruleset |

## Game rules

* **Board.** Three rows of fifteen lines. Each army starts on its nearest row. Each queen stands
  four lines in from its own end of the middle row; the neutral king stands at its centre.
* **Dice.** Three four-sided dice show X, III, II or blank, worth one, three, two or zero steps.
  Spend X first, then III, then II. An unusable die ends the turn; it cannot be skipped.
  Before spending any die, a player who owns an active piece may re-roll the current X.
  A player with no active pieces must use an X to activate a piece, not re-roll it.
  Active queens and recruited kings count as active pieces as well as soldiers.
* **Activation.** An inactive piece needs X to activate and move. Soldiers activate in queue order,
  foremost first, moving one line forwards and making the next soldier eligible for activation.
  The queen can activate in any legal direction. Inactive pieces cannot be captured or have their
  line entered.
* **Track.** Right along the home row, left along the middle row, right along the enemy row, left
  along the middle row again, then back to the home row. The middle row is visited twice per lap.
  The two players follow mirrored tracks.
* **Capture.** Landing on enemy pieces captures every capturable piece on the line. Active soldiers
  may stack. Royals cannot share a line with their own army except when recruiting the king.
* **King.** The neutral king is recruited when a soldier first reaches the opponent's home row.
  Thereafter either player recruits it by landing on its line. It cannot be captured.
  It moves forwards, backwards or straight between rows using the exact die value.
  Going around a bend counts as straight movement. Royals can use either middle-row track pass
  for along-track movement; soldiers follow their stored pass.
* **Queen.** Starts inactive and eligible for activation. Moves like the king. Capturing the queen
  wins immediately.
* **Winning.** Capturing the opponent's queen or exhausting their soldiers wins the game.
* **Starting player.** Both players throw three dice; most X starts. On a tie, both repeat all three
  dice. Manual starting-player selection bypasses these opening throws.
* **Like odds.** The three foremost soldiers start active and one step forward along their track.
  The next soldier remains eligible for activation at its home-row position.

## Source interpretation

* **Queen placement.** Reaidu's chapter and diagram place queens on the fourth line from their own
  end (x = 11 and x = 3). Wikipedia's wording suggests x = 12 and x = 2. The game uses the fourth line.
* **Like odds.** The sources say three soldiers are taken loose. The game includes their one-step
  activation move in the starting position.
* **Blank face.** Lágesvuon uses zero steps, although some neighbouring variants use four.
* **King recruitment.** The game follows the PDFs: initial recruitment by entering the enemy home
  row, subsequent recruitment by landing on the king. Reaidu's Unjárga reconstruction discusses
  recruitment on each entry into the enemy home row.
* **Jumping.** Movement checks the destination line, not intermediate lines; the sources do not
  explicitly restrict jumping for this variant.
* **Royal capture.** The restriction on sharing a royal's line applies within the same army.
  Enemy pieces can land on a queen to capture it or on a king to recruit it.

The browser's illustrated rules dialog uses [localized text](../src/locale/strings.ts) and inline
diagrams, and follows the selected language. Every legal action is checked by the shared engine,
including rerolls and moves submitted by human players or bots.
