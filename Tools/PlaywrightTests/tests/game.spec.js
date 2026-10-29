// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * End-to-end verification of the 2D web client.
 *
 * Everything here runs against the real bundle in a real browser: the client is not mocked and no test
 * hooks are compiled into it. The suite drives the same DOM the player does and reads back the same
 * state the player sees, so a regression in the interaction model, the localization or the persisted
 * preferences fails here rather than on someone's screen.
 *
 * Two things make that practical:
 *
 * - **The dice are seeded.** `Math.random` is the client's only source of chance — the `RulesEngine`'s
 *   dice rolls and the bots' own draws both go through it — so pinning it makes a throw reproducible,
 *   and with it the legal-move set every assertion clicks through. The seeded plan is re-pointed once
 *   the match setup has settled, so the opening throws and the played turns are both exactly known.
 * - **The turn is played, not assumed.** A Sáhkku turn spends one die per move, so a test that wants a
 *   *turn transition* spends the whole throw move by move until the rules hand the turn over.
 */

/** Board geometry from the shipped ruleset: three rows of fifteen carved cells and three dice. */
const BOARD_COLUMNS = 15;
const BOARD_ROWS = 3;
const DICE_COUNT = 3;

/** Indices into the ruleset's `dice.faces` table (`sahhku`, `three`, `two`, `zero`). */
const SAHKKU_FACE = 0;
const THREE_FACE = 1;
const TWO_FACE = 2;
const ZERO_FACE = 3;

/** The four-sided sáhkku die, i.e. the divisor that turns a draw into a face index. */
const DIE_FACE_COUNT = 4;

/**
 * The opening throw: the shipped setup throws for the start, and a throw that never sees a sáhkku fails
 * outright — which takes the boot's bot driver down with it. The plan has to end that throw under
 * *either* `start.mode` the ruleset allows, from any point the drawer has reached:
 *
 * - `firstSahhku` hands the start to the first player whose throw shows a sáhkku, so every three-die
 *   window needs at least one sáhkku;
 * - `mostSahhku` counts three dice per player *and repeats on a tie*, so the two halves of every six-die
 *   window must disagree; a tie would spin the engine (and the page) forever.
 *
 * Five sáhkku and a three per cycle satisfy both: no window of three is all threes, and the halves of
 * every six-die window hold three sáhkku against two (or the reverse). A plan of sáhkku only would tie
 * both players forever in `mostSahhku`, and a plan whose tail is a three would starve a later throw of
 * the sáhkku it needs — the drawer cycles the plan rather than repeating its last face (see
 * {@link seedDice}), so both stay true however far the drawer has run.
 */
const OPENING_PLAN = [SAHKKU_FACE, SAHKKU_FACE, SAHKKU_FACE, SAHKKU_FACE, SAHKKU_FACE, THREE_FACE];

/** The die every played turn throws: a three, which the shipped setup can always spend. */
const PLAY_PLAN = [THREE_FACE];

/** The side names the client prints for player one and player two in the default (English) locale. */
const WOMEN = 'P1 · Women';
const MEN = 'P2 · Men';

/** The `localStorage` key the settings store owns. */
const SETTINGS_KEY = 'sahkku_settings';

// -------------------------------------------------------------------------------------- helpers

const statusBar = (page) => page.locator('#status-bar');
const rollButton = (page) => page.locator('#dice-actions [data-action="roll"]');
const banner = (page) => page.locator('#banner');
const settingsDialog = (page) => page.locator('#dialog-root [data-dialog="settings"]');
const piecesIn = (page, place) => page.locator(`#board .cell[data-place="${place}"] .piece--p1`);

/**
 * Pins `Math.random` to a plan of die faces before any client script runs. Each draw selects the next
 * face of the plan (`floor(random * faceCount)`, exactly how the client reads its own `IRandomSource`),
 * and the plan cycles, so it never runs out — and never collapses into one repeated face, which would
 * starve a throw for the starting player of the face it needs. The drawer is left on `window` for
 * {@link planDice}.
 */
async function seedDice(page, plan = OPENING_PLAN) {
  await page.addInitScript(
    ({ faces, faceCount }) => {
      window.__sahkkuDice = { faces, faceCount, draw: 0 };
      Math.random = () => {
        const dice = window.__sahkkuDice;
        const face = dice.faces[dice.draw % dice.faces.length];
        dice.draw += 1;
        return (face + 0.5) / dice.faceCount;
      };
    },
    { faces: plan, faceCount: DIE_FACE_COUNT },
  );
}

/** Re-points the seeded drawer, e.g. to the face every turn of the test should throw. */
async function planDice(page, faces) {
  await page.evaluate((next) => {
    window.__sahkkuDice = { ...window.__sahkkuDice, faces: next, draw: 0 };
  }, faces);
}

/** Collects everything a clean cold launch must not produce. */
function watchForFailures(page) {
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const uncaughtErrors = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  return {
    /** Fails with the client's own output, which is what makes a failure actionable. */
    expectClean() {
      expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
      expect(uncaughtErrors, `uncaught exceptions:\n${uncaughtErrors.join('\n')}`).toEqual([]);
    },
  };
}

/** Opens the client and waits until it has painted a board. */
async function openClient(page) {
  await page.goto('/');
  await expect(page.locator('#board .cell')).toHaveCount(BOARD_COLUMNS * BOARD_ROWS);
  await expect(statusBar(page)).not.toBeEmpty();
}

/** Applies a match setup through the toolbar, which is how a player re-seats a match. */
async function applySetup(page, { mode, starter, speed }) {
  if (mode != null) await page.selectOption('#mode-select', mode);
  if (starter != null) await page.selectOption('#starter-select', starter);
  if (speed != null) await page.selectOption('#speed-select', speed);
}

/** Throws the dice and waits until one of them is up for spending. */
async function rollDice(page) {
  await rollButton(page).click();
  await expect(page.locator('#dice-tray .die--active')).toHaveCount(1);
}

/** The text of the status line, i.e. whose turn it is and what the client asks of them. */
async function statusText(page) {
  return (await statusBar(page).textContent()) ?? '';
}

/** Selects the first offered piece of `pieceClass` and moves it to the first highlighted cell. */
async function moveFirstLegalPiece(page, pieceClass) {
  const selectable = page.locator(`#board .cell.is-actionable:has(${pieceClass})`);
  await expect(selectable.first()).toBeVisible();
  await selectable.first().click();

  const destination = page.locator('#board .cell.is-highlight').first();
  await expect(destination).toBeVisible();
  await destination.click();
}

/**
 * Plays `owner`'s turn to its end: throws when the tray offers it and keeps taking the first legal move
 * until the rules hand the turn over. The guard is generous because a turn spends one die per move.
 */
async function playTurn(page, owner, pieceClass, maxActions = 12) {
  for (let action = 0; action < maxActions; action += 1) {
    if (!(await statusText(page)).includes(owner)) return;
    if ((await statusBar(page).getAttribute('data-phase')) === 'roll') {
      await rollDice(page);
      continue;
    }
    const selectable = page.locator(`#board .cell.is-actionable:has(${pieceClass})`);
    if ((await selectable.count()) === 0) return;
    await moveFirstLegalPiece(page, pieceClass);
  }
}

/**
 * Every occupied cell and what stands on it, as `place:token-classes` entries. Two samples are equal
 * exactly when the position has not changed, which is what makes "the bot moved something" a check
 * rather than a guess.
 */
async function boardSignature(page) {
  return page.locator('#board .cell').evaluateAll((cells) =>
    cells
      .map(
        (cell) =>
          `${cell.dataset.place}:${[...cell.querySelectorAll('.cell-pieces .piece')]
            .map((piece) => piece.getAttribute('class'))
            .join(';')}`,
      )
      .filter((entry) => !entry.endsWith(':')),
  );
}

/** Sets a range input the way a player drags it: a value plus the `input` event the dialog listens for. */
async function setRange(range, value) {
  await range.evaluate((element, next) => {
    element.value = next;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
}

/** The settings store's persisted document, as the client wrote it. */
async function storedSettings(page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  }, SETTINGS_KEY);
}

// ---------------------------------------------------------------------------------------- tests

test('cold launch: the board renders and the console stays clean', async ({ page }) => {
  const failures = watchForFailures(page);

  await openClient(page);

  await expect(page).toHaveTitle(/Sáhkku/);

  // The figure-of-eight board: three rows of fifteen cells, each row labelled and tagged by role.
  const board = page.locator('#board');
  await expect(board.locator('.row-label')).toHaveCount(BOARD_ROWS);
  for (let row = 0; row < BOARD_ROWS; row += 1) {
    await expect(board.locator(`.cell[data-y="${row}"]`)).toHaveCount(BOARD_COLUMNS);
  }
  // Both players' home rows and the shared middle row.
  await expect(board.locator('.cell[data-row="home"]')).toHaveCount(2 * BOARD_COLUMNS);
  await expect(board.locator('.cell[data-row="middle"]')).toHaveCount(BOARD_COLUMNS);
  // Both players' fifteen soldiers, the two queens and the neutral king the shipped setup places.
  await expect(board.locator('.piece--soldier')).toHaveCount(2 * BOARD_COLUMNS);
  await expect(board.locator('.piece--queen')).toHaveCount(2);
  await expect(board.locator('.piece--king')).toHaveCount(1);

  // Three carved dice, each drawn and named for the player.
  const tray = page.locator('#dice-tray');
  await expect(tray.locator('.die')).toHaveCount(DICE_COUNT);
  await expect(tray.locator('.die svg.die-shape')).toHaveCount(DICE_COUNT);
  await expect(tray.locator('.die[aria-label]')).toHaveCount(DICE_COUNT);

  // The client is fully wired: the language selector is populated and the match is underway — the
  // shipped setup throws for the start, so either side may be to move by now.
  await expect(page.locator('#locale-select option')).toHaveCount(3);
  await expect(statusBar(page)).toHaveAttribute('data-phase', /^(roll|move)$/);

  failures.expectClean();
});

test('hotseat: selecting a piece highlights its destinations and a move advances the turn', async ({
  page,
}) => {
  await seedDice(page);
  await openClient(page);
  await applySetup(page, { mode: 'hotseat_2p', starter: 'P1' });
  await planDice(page, PLAY_PLAN);

  // Two local players: the Women are to throw first and the tray offers the throw.
  await expect(statusBar(page)).toHaveAttribute('data-phase', 'roll');
  await expect(statusBar(page)).toHaveAttribute('data-turn', 'human');
  await expect(statusBar(page)).toContainText(WOMEN);
  await expect(rollButton(page)).toBeVisible();

  await rollDice(page);
  // A three is spendable from the shipped setup, so the throw opens the move phase instead of passing.
  await expect(statusBar(page)).toHaveAttribute('data-phase', 'move');
  await expect(page.locator('#board .cell.is-actionable')).not.toHaveCount(0);

  // Select a loose soldier and verify the legal destinations are the cells the client highlights.
  const selectable = page.locator('#board .cell.is-actionable:has(.piece--p1)');
  await expect(selectable.first()).toBeVisible();
  const womenBefore = await page.locator('#board .piece--p1').count();
  const from = await selectable.first().getAttribute('data-place');
  const fromBefore = await piecesIn(page, from).count();
  await selectable.first().click();

  await expect(page.locator('#board .cell.is-selected')).toHaveCount(1);
  await expect(page.locator(`#board .cell[data-place="${from}"]`)).toHaveClass(/is-selected/);
  const destinations = page.locator('#board .cell.is-highlight');
  await expect(destinations.first()).toBeVisible();
  const to = await destinations.first().getAttribute('data-place');
  expect(to).not.toBe(from);

  await destinations.first().click();

  // The move landed: the piece left its old cell for the highlighted one and none was lost on the way
  // — and the client reported the action it just committed.
  await expect(piecesIn(page, from)).toHaveCount(fromBefore - 1);
  await expect(piecesIn(page, to)).not.toHaveCount(0);
  await expect(page.locator('#board .piece--p1')).toHaveCount(womenBefore);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(WOMEN);

  // Spend the rest of the throw; the last die ends the turn and hands it to the Men.
  await playTurn(page, WOMEN, '.piece--p1');
  await expect(statusBar(page)).toHaveAttribute('data-phase', 'roll');
  await expect(statusBar(page)).toContainText(MEN);
  await expect(rollButton(page)).toBeVisible();
});

test('speed changes preserve the current board, dice, turn and selection', async ({ page }) => {
  const failures = watchForFailures(page);
  await seedDice(page);
  await openClient(page);
  await applySetup(page, { mode: 'human_vs_bot', starter: 'P1' });
  await planDice(page, PLAY_PLAN);

  await rollDice(page);
  await moveFirstLegalPiece(page, '.piece--p1');
  await page.locator('#board .cell.is-actionable:has(.piece--p1)').first().click();
  await expect(page.locator('#board .cell.is-highlight').first()).toBeVisible();

  const snapshot = () => page.locator('#board, #dice-tray, #dice-actions, #status-bar, #banner')
    .evaluateAll((elements) => elements.map((element) => element.outerHTML));
  const before = await snapshot();

  for (const speed of ['kajsa', 'slow', 'normal', 'fast']) {
    await page.selectOption('#speed-select', speed);
    await expect(page.locator('#speed-select')).toHaveValue(speed);
    expect(await snapshot()).toEqual(before);
  }

  await page.locator('#board .cell.is-highlight').first().click();
  await playTurn(page, WOMEN, '.piece--p1');
  await expect(statusBar(page)).toContainText(MEN);
  await expect(statusBar(page)).toHaveAttribute('data-turn', 'bot');
  await expect(statusBar(page)).toContainText(WOMEN);
  failures.expectClean();
});

for (const variant of ['evenOdds', 'standard']) {
  test(`hotseat: ${variant} opening has exact positions for both players`, async ({ page }) => {
    await seedDice(page);
    await openClient(page);
    await applySetup(page, { mode: 'hotseat_2p', starter: 'P1' });
    await page.selectOption('#variant-select', variant);

    const actual = await page.locator('#board .cell').evaluateAll((cells) =>
      cells.flatMap((cell) =>
        [...cell.querySelectorAll('.cell-pieces .piece')].map((piece) => ({
          place: Number(cell.dataset.place),
          type: ['soldier', 'queen', 'king'].find((type) => piece.classList.contains(`piece--${type}`)),
          owner: ['p1', 'p2', 'neutral'].find((owner) => piece.classList.contains(`piece--${owner}`)),
          active: piece.classList.contains('piece--active'),
        })),
      ).sort((a, b) => a.place - b.place),
    );
    const expected = [];
    for (let arc = 0; arc < BOARD_COLUMNS; arc += 1) {
      const active = variant === 'evenOdds' && arc >= 12;
      expected.push({ place: arc + (active ? 1 : 0), type: 'soldier', owner: 'p1', active });
      expected.push({ place: 44 - arc - (active ? 1 : 0), type: 'soldier', owner: 'p2', active });
    }
    expected.push(
      { place: 18, type: 'queen', owner: 'p1', active: false },
      { place: 26, type: 'queen', owner: 'p2', active: false },
      { place: 22, type: 'king', owner: 'neutral', active: false },
    );
    expect(actual).toEqual(expected.sort((a, b) => a.place - b.place));
    await expect(statusBar(page)).toHaveAttribute('data-phase', 'roll');
    await expect(statusBar(page)).toContainText(WOMEN);
  });
}

for (const touch of [false, true]) {
  test.describe(`shared position (${touch ? 'narrow touch screen' : 'desktop'})`, () => {
    test.use({ hasTouch: touch, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 720 } });

    test('cycles king and soldier visibly and by keyboard, then moves the soldier alone', async ({ page }) => {
      const failures = watchForFailures(page);
      await seedDice(page);
      await openClient(page);
      await applySetup(page, { mode: 'hotseat_2p', starter: 'P2' });
      const cell = (place) => page.locator(`#board .cell[data-place="${place}"]`);
      const activate = async (target) => {
        if (touch) await target.tap();
        else await target.click();
      };
      const move = async (from, to) => {
        await activate(cell(from));
        await expect(cell(to)).toHaveClass(/is-highlight/);
        await activate(cell(to));
      };
      const roll = async (faces) => {
        await planDice(page, faces);
        await activate(rollButton(page));
      };

      // P2 reaches the enemy home row, recruiting and activating the neutral king.
      // Blanks pass P1's intervening turns without changing its remaining soldiers.
      await roll([TWO_FACE]);
      await move(29, 27);
      await move(27, 25);
      await move(25, 23);
      await roll([ZERO_FACE]);
      await roll([TWO_FACE]);
      await move(23, 21);
      await move(21, 19);
      await move(19, 17);
      await roll([ZERO_FACE]);
      await roll([TWO_FACE]);
      await move(17, 15);
      await move(15, 13);
      await move(30, 28);
      await expect(cell(22).locator('.piece--king.piece--p2.piece--active')).toHaveCount(1);

      // P1 lands on the now-active enemy king to recruit it, leaving the two pieces together.
      await roll([THREE_FACE, THREE_FACE, TWO_FACE]);
      await move(14, 17);
      await move(17, 20);
      await move(20, 22);
      await roll([ZERO_FACE]); // P2 passes.
      await roll([THREE_FACE]);
      const shared = cell(22);
      await expect(shared.locator('.stack-badge')).toHaveText('×2');
      await expect(shared).toHaveAttribute('title', /Click again/);
      const before = await boardSignature(page);

      await activate(shared);
      await expect(shared.locator('.piece--king.piece--selected')).toHaveCount(1);
      await expect(shared).toHaveAccessibleName(/King/);
      await expect(cell(19)).toHaveClass(/is-highlight/); // Only the king can go backward.

      await activate(shared);
      await expect(shared.locator('.piece--soldier.piece--selected')).toHaveCount(1);
      await expect(shared).toHaveAccessibleName(/Woman/);
      await expect(cell(19)).not.toHaveClass(/is-highlight/);
      await expect(cell(25)).toHaveClass(/is-highlight/);

      await shared.focus();
      await shared.press('Enter');
      await expect(shared.locator('.piece--king.piece--selected')).toHaveCount(1);
      await shared.press('Space');
      await expect(shared.locator('.piece--soldier.piece--selected')).toHaveCount(1);
      await expect(shared).toBeFocused();
      await expect(page.locator('#dice-tray .die').nth(0)).toHaveClass(/die--active/);
      // Selection changes the visible token, but no occupant or destination has moved.
      await expect(cell(22).locator('.stack-badge')).toHaveText('×2');
      await expect(cell(25).locator('.piece')).toHaveCount(0);

      await activate(cell(25));
      await expect(shared.locator('.piece--king.piece--p1')).toHaveCount(1);
      await expect(shared.locator('.stack-badge')).toHaveCount(0);
      await expect(cell(25).locator('.piece--soldier.piece--p1')).toHaveCount(1);
      await expect(page.locator('#dice-tray .die').nth(1)).toHaveClass(/die--active/);
      expect(await boardSignature(page)).not.toEqual(before);
      failures.expectClean();
    });
  });
}

test('a bot seat answers the human move and hands the turn back', async ({ page }) => {
  await seedDice(page);
  await openClient(page);
  await applySetup(page, { mode: 'human_vs_bot', starter: 'P1', speed: 'fast' });
  await planDice(page, PLAY_PLAN);

  await expect(statusBar(page)).toHaveAttribute('data-phase', 'roll');
  await expect(statusBar(page)).toContainText(WOMEN);

  await rollDice(page);
  await playTurn(page, WOMEN, '.piece--p1');

  // The Men are the bot's seat now, and the board offers the human nothing to click.
  await expect(statusBar(page)).toContainText(MEN);
  const beforeBot = await boardSignature(page);

  // The bot plays its own throw and the turn comes back to the human, which is the whole loop.
  await expect(statusBar(page)).toHaveAttribute('data-turn', 'human', { timeout: 30000 });
  await expect(statusBar(page)).toContainText(WOMEN);
  await expect(statusBar(page)).toHaveAttribute('data-phase', 'roll');
  await expect(rollButton(page)).toBeVisible();

  // It answered with a real move rather than passing, and the client reported it.
  const afterBot = await boardSignature(page);
  expect(afterBot, 'the bot did not change the position').not.toEqual(beforeBot);
  await expect(banner(page)).toContainText(MEN);
});

test('the language switcher re-letters the client, including an open dialog', async ({ page }) => {
  await openClient(page);
  const html = page.locator('html');
  const localeSelect = page.locator('#locale-select');
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(localeSelect).toHaveValue('en');

  // A language switch has to reach the chrome that is already on screen, not only the next repaint.
  await page.locator('#settings-button').click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText('Settings');

  await localeSelect.selectOption('se');
  await expect(html).toHaveAttribute('lang', 'se');
  await expect(localeSelect).toHaveValue('se');
  await expect(page.locator('[data-i18n="app.subtitle"]')).toHaveText(/Sámi árbevirolaš/);
  await expect(page.locator('[data-i18n="menu.settings"]')).toHaveText('Asahusat');
  await expect(page.locator('#board')).toHaveAttribute('aria-label', /Sáhkku-heasta/);
  await expect(page.locator('#dice-tray')).toHaveAttribute('aria-label', 'Birccuid gáddi');
  await expect(dialog.locator('h2')).toHaveText('Asahusat');
  await expect(dialog.locator('[data-action="save"]')).toHaveText('Vurke');

  await localeSelect.selectOption('no');
  await expect(html).toHaveAttribute('lang', 'no');
  await expect(page.locator('[data-i18n="app.subtitle"]')).toHaveText(/Tradisjonelt samisk/);
  await expect(page.locator('[data-i18n="menu.settings"]')).toHaveText('Innstillinger');
  await expect(page.locator('#dice-tray')).toHaveAttribute('aria-label', 'Terningbrett');
  await expect(dialog.locator('h2')).toHaveText('Innstillinger');
  await expect(dialog.locator('[data-action="save"]')).toHaveText('Lagre');

  await localeSelect.selectOption('en');
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(page.locator('[data-i18n="menu.settings"]')).toHaveText('Settings');
  // The chosen language is a preference like any other, so it outlives the dialog.
  expect(await storedSettings(page)).toMatchObject({ locale: 'en' });
});

test('the settings dialog persists the LLM endpoint and the volumes across a reload', async ({
  page,
}) => {
  await openClient(page);

  await page.locator('#settings-button').click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();

  await dialog.locator('input[name="endpoint"]').fill('http://localhost:9999/v1');
  await dialog.locator('input[name="model"]').fill('e2e-model');
  await dialog.locator('input[name="timeout"]').fill('12');
  await setRange(dialog.locator('input[name="master-volume"]'), 42);
  await setRange(dialog.locator('input[name="sfx-volume"]'), 13);
  await dialog.locator('input[name="mute"]').check();
  await expect(dialog.locator('output[for="settings-master-volume"]')).toHaveText('42%');

  await dialog.locator('[data-action="save"]').click();
  await expect(dialog).toHaveCount(0);

  // The store normalizes what it writes, e.g. a bare base URL gains its chat-completions path.
  expect(await storedSettings(page)).toMatchObject({
    llmEndpoint: 'http://localhost:9999/v1/chat/completions',
    llmModel: 'e2e-model',
    llmTimeoutSeconds: 12,
    masterVolume: 42,
    sfxVolume: 13,
    muted: true,
  });

  await page.reload();
  await expect(page.locator('#board .cell')).toHaveCount(BOARD_COLUMNS * BOARD_ROWS);
  await page.locator('#settings-button').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[name="endpoint"]')).toHaveValue(
    'http://localhost:9999/v1/chat/completions',
  );
  await expect(dialog.locator('input[name="model"]')).toHaveValue('e2e-model');
  await expect(dialog.locator('input[name="timeout"]')).toHaveValue('12');
  await expect(dialog.locator('input[name="master-volume"]')).toHaveValue('42');
  await expect(dialog.locator('input[name="sfx-volume"]')).toHaveValue('13');
  await expect(dialog.locator('input[name="mute"]')).toBeChecked();
});
