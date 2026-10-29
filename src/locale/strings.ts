/**
 * The tri-lingual string tables: North Sámi (`se`), Norwegian (`no`) and English (`en`).
 *
 * This module is *data only* — no DOM, no locale state, no lookup logic (that is `i18n.ts`). Splitting
 * it that way keeps the table shape the single source of truth: the English table is the canonical
 * shape, and the other two are declared `typeof englishStrings`, so a missing or misspelled key is a
 * compile error rather than an English string leaking into a Sámi screen.
 *
 * Key layout, by screen:
 *
 * | section               | what it covers                                                     |
 * |-----------------------|--------------------------------------------------------------------|
 * | `app`, `header`       | title, subtitle, toolbar and footer chrome                          |
 * | `mode`, `bot`, `speed`| the match-mode selector's option labels                             |
 * | `variant`, `starter`  | the match options (standard/even odds, throw for the start)         |
 * | `owners`, `pieces`    | player and piece terminology (Nisu, Almmái, Gonagas, …)             |
 * | `status`, `events`    | the turn line, the thinking line and the rule-event banner          |
 * | `dice`                | the tray, its buttons, its face names and its per-die labels        |
 * | `board`               | board aria labels, row labels and the carved-cell titles            |
 * | `legend`, `gameOver`  | the piece legend and the end-of-match modal                         |
 * | `settings`, `help`    | the two modal dialogs, section by section                           |
 * | `notifications`       | transient notices (an NPC that fell back to the heuristic)          |
 *
 * Placeholders are `{name}` and are interpolated by `I18n.t`. A translation must keep the *same* set of
 * placeholders as the English key it mirrors; `tests/locale/i18n.test.ts` enforces that.
 *
 * Translation note: the English and Norwegian strings are authored here directly. The North Sámi
 * strings are a community-facing best effort built from the terminology the game already uses
 * (`nisu`, `almmái`, `gonagas`, `birccu`, `sáhkku`) and should get a native-speaker review pass
 * before a public release; the keys are stable, so that pass is a pure text edit.
 */

/** The locales the client ships. `no` is Norwegian Bokmål. */
export const Locales = ["se", "no", "en"] as const;

export type Locale = (typeof Locales)[number];

/** The locale every lookup ultimately resolves through (see `I18n.t`). */
export const DefaultLocale: Locale = "en";

/** What a locale switcher needs to label its options. */
export interface LocaleInfo {
  code: Locale;
  /** The language's own name, for the dropdown. */
  nativeName: string;
  /** The English name, for documentation and logs. */
  englishName: string;
}

export const LocaleInfos: readonly LocaleInfo[] = [
  { code: "se", nativeName: "Davvisámegiella", englishName: "North Sámi" },
  { code: "no", nativeName: "Norsk", englishName: "Norwegian" },
  { code: "en", nativeName: "English", englishName: "English" },
];

/** The canonical English table. Its shape defines `StringTable` and every other locale. */
const englishStrings = {
  app: {
    title: "Sáhkku",
    subtitle: "Traditional Sámi running-fight board game — open-license 2D client",
    footer:
      "Sáhkku is a traditional game of the Sámi people. Rules engine, agents and this 2D client are open source.",
  },
  menu: {
    start: "New game",
    language: "Language",
    settings: "Settings",
    help: "Rules & help",
    setup: "Match setup",
    modeLabel: "Match mode",
    bot1Label: "Bot (Women)",
    bot2Label: "Bot (Men)",
    speedLabel: "Speed",
    variantLabel: "Variant",
    starterLabel: "Starting player",
    modes: {
      humanVsBot: "Single player (you vs bot)",
      hotseat2p: "Local 2-player hotseat",
      botVsBot: "Spectator (bot vs bot)",
    },
    bots: {
      heuristic: "Heuristic",
      easy: "Easy — developing player",
      medium: "Medium — turn planner",
      hard: "Hard — tactical opponent",
      random: "Random",
      llm: "LLM agent (OpenAI-compatible)",
    },
    speeds: {
      kajsa: "Kajsa mode",
      slow: "Slow",
      normal: "Normal",
      fast: "Fast",
    },
    variants: {
      standard: "Standard (no loose soldiers)",
      evenOdds: "Even odds (3 loose soldiers)",
    },
    starters: {
      throw: "Throw for it",
      p1: "Women (P1) start",
      p2: "Men (P2) start",
    },
  },
  owners: {
    p1: "P1 · Women",
    p2: "P2 · Men",
    none: "Neutral",
  },
  pieces: {
    soldier: "Soldier",
    woman: "Woman",
    man: "Man",
    queen: "Queen",
    king: "King",
    neutralKing: "Neutral king",
    active: "active",
    seated: "seated",
    describe: "{piece} ({state})",
  },
  status: {
    rollPrompt: "{player}: roll the dice.",
    rerollPrompt:
      "{player}: {faces} is showing — reroll that die, or keep the dice and move.",
    pieceSelected: "{player}: {piece} selected — click a highlighted cell to move it.",
    selectPiece: "{player}: select a piece to move with die {die} of {total}.",
    thinking: "{player} is thinking…",
    thinkingElapsed: "{seconds}s elapsed",
    gameOver: "{player} wins — {reason}.",
    diceOrder: "Spending die {die} of {total}.",
    diceUnrolled: "The dice are still to be thrown this turn.",
    matchOver: "The match is over.",
  },
  events: {
    pieceMoved: "moved",
    soldierCaptured: "captured a soldier",
    kingRecruited: "recruited the king",
    queenCaptured: "captured the queen",
    gameWon: "{player} wins",
    acted: "acted",
  },
  win: {
    reason: {
      soldiersExhausted: "the opponent has no soldiers left",
      queenCaptured: "the queen was captured",
      none: "the game is over",
    },
  },
  dice: {
    panelTitle: "Sáhkku dice",
    trayLabel: "Dice tray",
    hintPrefix: "Faces",
    hintSahhku: "one step / activate / reroll",
    hintThree: "three steps",
    hintTwo: "two steps",
    hintZero: "blank",
    roll: "Roll Dice",
    reroll: "Reroll Die",
    keep: "Keep & Move",
    face: {
      sahkku: "X (sáhkku)",
      three: "III (three)",
      two: "II (two)",
      zero: "blank",
    },
    die: {
      notThrown: "Die {index}: not thrown yet",
      state: "Die {index}: {face}, {state}",
    },
    state: {
      spent: "spent",
      active: "up for spending",
      waiting: "waiting",
    },
  },
  board: {
    label: "Sáhkku board: three rows of fifteen carved cells",
    row: {
      home: "{player} home",
      middle: "Shared middle row",
    },
    carving: {
      king: "Sacred king cell",
      queenP1: "Sacred P1 queen cell",
      queenP2: "Sacred P2 queen cell",
      turning: "Track turning",
    },
    cell: {
      position: "Line {x}, row {y}",
      empty: "{position}: empty",
      emptyDestination: "{position}: empty, legal destination",
      stack: "{count} pieces stacked",
      cycle: "Click again or press Enter or Space to select the next movable piece",
      selectable: "selectable",
      legalDestination: "legal destination",
    },
  },
  legend: {
    label: "Piece legend",
    woman: "Woman (P1 soldier)",
    man: "Man (P2 soldier)",
    queenP1: "P1 queen",
    queenP2: "P2 queen",
    king: "King (neutral, recruitable)",
    seated: "Seated in the home row",
    carving: "Sacred carved cell",
  },
  gameOver: {
    label: "Game over",
    title: "{player} wins",
    body: "Victory: {reason}.",
    playAgain: "Play Again",
  },
  settings: {
    title: "Settings",
    label: "Settings",
    llm: {
      section: "LLM opponent",
      endpoint: "Endpoint URL",
      endpointHint:
        "OpenAI-compatible base URL, e.g. http://localhost:1234/v1 for LM Studio or Ollama.",
      model: "Model name",
      modelHint: "Sent as the model field of every chat-completion request.",
      timeout: "Request timeout (seconds)",
      timeoutHint: "How long the NPC may think before the heuristic takes over.",
      fallbackNotice: "Announce when the NPC falls back to the heuristic",
    },
    audio: {
      section: "Sound",
      masterVolume: "Master volume",
      sfxVolume: "Sound effects volume",
      mute: "Mute all sound",
      hint:
        "Effects are synthesised in the browser with the Web Audio API — no audio files are downloaded.",
    },
    save: "Save",
    close: "Close",
  },
  help: {
    title: "Rules & help",
    label: "Rules and help",
    close: "Close",
    intro: {
      title: "About Sáhkku",
      body: "Sáhkku is a traditional running-fight board game of the Sámi people. Two players march their armies around a board shaped like a figure of eight, hunt each other's soldiers and fight over the king who stands between them.",
    },
    board: {
      title: "The board and the track",
      body: "The board is three rows of fifteen carved cells. The two outer rows are the home rows and the row between them is shared. Every piece walks the figure-of-eight lap: forward along its own row, across to the opponent's half and back again. The cells cut with an X are sacred.",
    },
    dice: {
      title: "The dice (birccu)",
      body: "Three four-sided dice are thrown each turn. X (sáhkku) is one step and also wakes a sleeping soldier; III is three steps, II two steps and the blank side nothing at all. The dice must be spent in the order the ruleset declares, and a sáhkku may be thrown again before any die has been spent.",
    },
    pieces: {
      title: "The pieces",
      body: "Player one fields the Women (nisu) and player two the Men (almmái); each side also has a queen. The King (gonagas) stands neutral on his sacred cell until a soldier reaches the opponent's home row and recruits him to that side.",
    },
    activation: {
      title: "The activation queue",
      body: "Soldiers wait in the queue of their home row. A sáhkku activates the foremost waiting soldier, and moving a piece still in the queue wakes the next one behind it — so an army is released from the front towards the rear.",
    },
    win: {
      title: "How the match is won",
      body: "You win as soon as your opponent has no soldiers left on the board, or as soon as you capture your opponent's queen.",
    },
    credit:
      "Sáhkku is a traditional game of the Sámi people. This client, its rules engine and its agents are open source.",
  },
  notifications: {
    searchFallback: "AI search failed — using the emergency heuristic.",
    llmFallback: "The LLM endpoint did not answer — playing the heuristic move.",
    dismiss: "Dismiss",
  },
} as const;

/**
 * The English table with its literal values widened to `string`: the shape every locale must provide.
 * Because it is derived from the English object key by key and nested key by nested key, a locale that
 * forgets (or misspells) even the deepest key fails to compile.
 */
type WidenShape<T> = { [K in keyof T]: T[K] extends string ? string : WidenShape<T[K]> };

export type StringTable = WidenShape<typeof englishStrings>;

/** A flattened `dotted.key` path, e.g. `"status.rollPrompt"`. */
export type StringKey = string;

const northSamiStrings: StringTable = {
  app: {
    title: "Sáhkku",
    subtitle: "Sámi árbevirolaš viehkanstallan-speallu — rabas 2D-klienta",
    footer:
      "Sáhkku lea sámi álbmoga árbevirolaš speallu. Njuolggadusmotora, agenttat ja dán 2D-klienta leat rabas gáldokoda.",
  },
  menu: {
    start: "Ođđa speallu",
    language: "Giella",
    settings: "Asahusat",
    help: "Njuolggadusat ja veahkki",
    setup: "Speallu-ásahusat",
    modeLabel: "Speallomode",
    bot1Label: "Botta (nisut)",
    bot2Label: "Botta (almmát)",
    speedLabel: "Lekti",
    variantLabel: "Variantta",
    starterLabel: "Álggu-spealli",
    modes: {
      humanVsBot: "Okto-spealli (don botta vuostá)",
      hotseat2p: "Báikkálaš 2-spealli (seamma rusttegis)",
      botVsBot: "Geahčči (botta botta vuostá)",
    },
    bots: {
      heuristic: "Heuristtalaš",
      easy: "Álki",
      medium: "Gaskamearálaš",
      hard: "Váttis",
      random: "Soaittáhagas",
      llm: "LLM-agentta (OpenAI-heivvolaš)",
    },
    speeds: {
      kajsa: "Kajsa mode",
      slow: "Njozet",
      normal: "Dábálaš",
      fast: "Fáhkka",
    },
    variants: {
      standard: "Standárda (eai luhtte-sotnjehat)",
      evenOdds: "Seamma vejolašvuohta (3 luhtte-sotnjehat)",
    },
    starters: {
      throw: "Bálkke álggu",
      p1: "Nisut (P1) álget",
      p2: "Almmát (P2) álget",
    },
  },
  owners: {
    p1: "P1 · Nisut",
    p2: "P2 · Almmát",
    none: "Neutrála",
  },
  pieces: {
    soldier: "Sotnjehat",
    woman: "Nisu",
    man: "Almmái",
    queen: "Dronninga",
    king: "Gonagas",
    neutralKing: "Neutrála gonagas",
    active: "aktiiiva",
    seated: "sajus",
    describe: "{piece} ({state})",
  },
  status: {
    rollPrompt: "{player}: bálkke birccuid.",
    rerollPrompt:
      "{player}: {faces} čájeha — bálkke dan birccu ođđasit, dahje doala birccuid ja sirdde.",
    pieceSelected: "{player}: {piece} válljejuvvon — coahkkal merkejuvvon saji sirdit.",
    selectPiece: "{player}: vállje bierggu, mon sirdá birccuin {die} / {total}.",
    thinking: "{player} jurddaša…",
    thinkingElapsed: "{seconds} s",
    gameOver: "{player} vuoitá — {reason}.",
    diceOrder: "Geavaha birccu {die} / {total}.",
    diceUnrolled: "Birccut eai leat vel bálkkejuvvon dán vuorus.",
    matchOver: "Speallu lea loahpahuvvon.",
  },
  events: {
    pieceMoved: "sirddii",
    soldierCaptured: "gávnnai sotnjeha",
    kingRecruited: "vurkii gonagasa",
    queenCaptured: "gávnnai dronninga",
    gameWon: "{player} vuoitá",
    acted: "spealai",
  },
  win: {
    reason: {
      soldiersExhausted: "vuostášeaddjiis eai leat šat sotnjehat",
      queenCaptured: "dronninga gávnnahuvvui",
      none: "speallu lea loahpahuvvon",
    },
  },
  dice: {
    panelTitle: "Sáhkku-birccut",
    trayLabel: "Birccuid gáddi",
    hintPrefix: "Sierat",
    hintSahhku: "okta lávki / aktiveret / bálkke ođđasit",
    hintThree: "golbma lávki",
    hintTwo: "guokte lávki",
    hintZero: "guoros",
    roll: "Bálkke birccuid",
    reroll: "Bálkke ođđasit",
    keep: "Doala ja sirdde",
    face: {
      sahkku: "X (sáhkku)",
      three: "III (golbma)",
      two: "II (guokte)",
      zero: "guoros",
    },
    die: {
      notThrown: "Birccu {index}: ii leat vel bálkkejuvvon",
      state: "Birccu {index}: {face}, {state}",
    },
    state: {
      spent: "geavahuvvon",
      active: "geavahuvvo dál",
      waiting: "vuordá",
    },
  },
  board: {
    label: "Sáhkku-heasta: golbma ráiddu vihttanlogi čuollojuvvon saji",
    row: {
      home: "{player} ruoktaráiddu",
      middle: "Juhkkojuvvon gaskaráiddu",
    },
    carving: {
      king: "Gonagasa bassi saji",
      queenP1: "P1 dronninga bassi saji",
      queenP2: "P2 dronninga bassi saji",
      turning: "Báni jorru",
    },
    cell: {
      position: "Linjá {x}, ráiddu {y}",
      empty: "{position}: guoros",
      emptyDestination: "{position}: guoros, lohpi mihttu",
      stack: "{count} bierggu čikŋoduvvon",
      cycle: "Deaddil fas dahje deaddil Enter dahje Space válljet čuovvovaš sirddehahtti bierggu",
      selectable: "válljehahtti",
      legalDestination: "lohpi mihttu",
    },
  },
  legend: {
    label: "Biergguid čájeheapmi",
    woman: "Nisu (P1-sotnjehat)",
    man: "Almmái (P2-sotnjehat)",
    queenP1: "P1-dronninga",
    queenP2: "P2-dronninga",
    king: "Gonagas (neutrála, vurkejuvvo)",
    seated: "Čohkká ruoktaráiddus",
    carving: "Bassi čuollojuvvon saji",
  },
  gameOver: {
    label: "Speallu loahpahuvvon",
    title: "{player} vuoitá",
    body: "Vuoitamuš: {reason}.",
    playAgain: "Speallu ođđasit",
  },
  settings: {
    title: "Asahusat",
    label: "Asahusat",
    llm: {
      section: "LLM-vuostášeaddji",
      endpoint: "Čujuhusa URL",
      endpointHint:
        "OpenAI-heivvolaš vuođđo-URL, omd. http://localhost:1234/v1 LM Studio dahje Ollama várás.",
      model: "Málle-namma",
      modelHint: "Sáddejuvvo málle-gieddin juohke chat-completion-jearus.",
      timeout: "Jearu áigemearri (sekunddat)",
      timeoutHint: "Man guhká botta sáhttá jurddašit ovdal heuristtalaš botta váldá badjel.",
      fallbackNotice: "Diedihit, go botta vuolgá heuristihkkii",
    },
    audio: {
      section: "Jietna",
      masterVolume: "Váldo-jietnagassodat",
      sfxVolume: "Jietnaefektajd gassodat",
      mute: "Jaskkut buot jietna",
      hint:
        "Jietnaefektat ráhkaduvvojit neahttalohkkis Web Audio API bokte — ii oktage jietnafiilla viežžá.",
    },
    save: "Vurke",
    close: "Gidde",
  },
  help: {
    title: "Njuolggadusat ja veahkki",
    label: "Njuolggadusat ja veahkki",
    close: "Gidde",
    intro: {
      title: "Sáhkku birra",
      body: "Sáhkku lea sámi álbmoga árbevirolaš viehkanstallan-speallu. Guokte spealli jođihit iežaset soahteheasta gávtti, mii lea gávccahađan hámis, gávdnaba vuostášeaddji sotnjehiid ja gilvaleba gonagasa.",
    },
    board: {
      title: "Heasta ja báni",
      body: "Heasttas leat golbma ráiddu, juohke ráiddus vihttanlogi čuollojuvvon saji. Olgoráiddut leat ruoktaráiddut ja gaskkas lea juhkkojuvvon ráiddu, mon goappašagat rasttilit. Juohke bierggu manná gávccahađan-šleaippa: ovddos iežaset ráiddus, rastá vuostášeaddji beallái ja ruovttoluotta. Sajit, main lea čuollojuvvon X, leat bastit.",
    },
    dice: {
      title: "Birccut",
      body: "Golbma njealljesierat birccu bálkkejuvvojit juohke vuorus. X (sáhkku) lea okta lávki ja heruhta nađe sotnjeha; III lea golbma lávki, II guokte lávki ja guoros sierra ii masa ge. Birccut geavahuvvojit dan ortnegis, mon njuolggadusat mearridit, ja sáhkku sáhttá bálkkejuvvot ođđasit ovdal go oktage birccu lea geavahuvvon.",
    },
    pieces: {
      title: "Bierggut",
      body: "Spealli 1 jođiha nisuid ja spealli 2 almmáid; goappašagis lea maid dronninga. Gonagas čohkká neutrála iežas bassi sajis, gitta dassážii go sotnjehat, mii olaha vuostášeaddji ruoktaráiddu, dan vurká.",
    },
    activation: {
      title: "Aktiverenvuorru",
      body: "Ruoktaráiddus čohkkájit sotnjehat vuorus. Sáhkku aktivera ovdámuš nađe sotnjeha, ja go nađe bierggu sirdá, dat heruhta bohtosiid vuorus.",
    },
    win: {
      title: "Mo vuoitit",
      body: "Vuoitit, go vuostášeaddjiis eai leat šat sotnjehat heasttas, dahje go gávnnat vuostášeaddji dronninga.",
    },
    credit:
      "Sáhkku lea sámi álbmoga árbevirolaš speallu. Dát klienta, njuolggadusmotora ja agenttat leat rabas gáldokoda.",
  },
  notifications: {
    searchFallback: "AI-ohcan ii lihkostuvvan — geavaha heuristtalaš sirdima.",
    llmFallback: "LLM-čujuhus ii vástidan — spealá heuristtalaš sirdima.",
    dismiss: "Čiega",
  },
};

const norwegianStrings: StringTable = {
  app: {
    title: "Sáhkku",
    subtitle: "Tradisjonelt samisk løpe- og fangebrettspill — åpen 2D-klient",
    footer:
      "Sáhkku er et tradisjonelt spill for det samiske folket. Regelmotoren, agentene og denne 2D-klienten er åpen kildekode.",
  },
  menu: {
    start: "Nytt spill",
    language: "Språk",
    settings: "Innstillinger",
    help: "Regler og hjelp",
    setup: "Kamppsett",
    modeLabel: "Spillmodus",
    bot1Label: "Bot (kvinner)",
    bot2Label: "Bot (menn)",
    speedLabel: "Fart",
    variantLabel: "Variant",
    starterLabel: "Startspiller",
    modes: {
      humanVsBot: "Enkeltspiller (du mot bot)",
      hotseat2p: "Lokal 2-spiller (hjemme)",
      botVsBot: "Tilskuer (bot mot bot)",
    },
    bots: {
      heuristic: "Heuristisk",
      easy: "Lett — under utvikling",
      medium: "Middels — planlegger hele turen",
      hard: "Vanskelig — taktisk motstander",
      random: "Tilfeldig",
      llm: "LLM-agent (OpenAI-kompatibel)",
    },
    speeds: {
      kajsa: "Kajsa mode",
      slow: "Treg",
      normal: "Normal",
      fast: "Rask",
    },
    variants: {
      standard: "Standard (ingen løse soldater)",
      evenOdds: "Lik sjanse (3 løse soldater)",
    },
    starters: {
      throw: "Kast om starten",
      p1: "Kvinnene (P1) starter",
      p2: "Mennene (P2) starter",
    },
  },
  owners: {
    p1: "P1 · Kvinner",
    p2: "P2 · Menn",
    none: "Nøytral",
  },
  pieces: {
    soldier: "Soldat",
    woman: "Kvinne",
    man: "Mann",
    queen: "Dronning",
    king: "Konge",
    neutralKing: "Nøytral konge",
    active: "aktiv",
    seated: "på plass",
    describe: "{piece} ({state})",
  },
  status: {
    rollPrompt: "{player}: kast terningene.",
    rerollPrompt:
      "{player}: {faces} viser — kast den terningen på nytt, eller behold og flytt.",
    pieceSelected: "{player}: {piece} valgt — klikk på en markert rute for å flytte.",
    selectPiece: "{player}: velg en brikke å flytte med terning {die} av {total}.",
    thinking: "{player} tenker…",
    thinkingElapsed: "{seconds} s brukt",
    gameOver: "{player} vinner — {reason}.",
    diceOrder: "Bruker terning {die} av {total}.",
    diceUnrolled: "Terningene er ikke kastet ennå denne turen.",
    matchOver: "Kampen er over.",
  },
  events: {
    pieceMoved: "flyttet",
    soldierCaptured: "fanget en soldat",
    kingRecruited: "vervet kongen",
    queenCaptured: "fanget dronningen",
    gameWon: "{player} vinner",
    acted: "spilte",
  },
  win: {
    reason: {
      soldiersExhausted: "motstanderen har ingen soldater igjen",
      queenCaptured: "dronningen ble fanget",
      none: "spillet er over",
    },
  },
  dice: {
    panelTitle: "Sáhkkuterninger",
    trayLabel: "Terningbrett",
    hintPrefix: "Sider",
    hintSahhku: "ett steg / aktivere / kaste på nytt",
    hintThree: "tre steg",
    hintTwo: "to steg",
    hintZero: "blank",
    roll: "Kast terningene",
    reroll: "Kast på nytt",
    keep: "Behold og flytt",
    face: {
      sahkku: "X (sáhkku)",
      three: "III (tre)",
      two: "II (to)",
      zero: "blank",
    },
    die: {
      notThrown: "Terning {index}: ikke kastet ennå",
      state: "Terning {index}: {face}, {state}",
    },
    state: {
      spent: "brukt",
      active: "skal brukes nå",
      waiting: "venter",
    },
  },
  board: {
    label: "Sáhkku-brett: tre rader med femten skårne ruter",
    row: {
      home: "{player}s hjemrad",
      middle: "Delt midtrad",
    },
    carving: {
      king: "Kongens hellige rute",
      queenP1: "Hellig rute for P1s dronning",
      queenP2: "Hellig rute for P2s dronning",
      turning: "Banens sving",
    },
    cell: {
      position: "Linje {x}, rad {y}",
      empty: "{position}: tom",
      emptyDestination: "{position}: tom, lovlig mål",
      stack: "{count} brikker stablet",
      cycle: "Klikk igjen eller trykk Enter eller mellomrom for å velge neste flyttbare brikke",
      selectable: "valgbar",
      legalDestination: "lovlig mål",
    },
  },
  legend: {
    label: "Brikkeoversikt",
    woman: "Kvinne (P1-soldat)",
    man: "Mann (P2-soldat)",
    queenP1: "P1-dronning",
    queenP2: "P2-dronning",
    king: "Konge (nøytral, kan ververs)",
    seated: "Sitter i hjemraden",
    carving: "Hellig skåret rute",
  },
  gameOver: {
    label: "Spillet er over",
    title: "{player} vinner",
    body: "Seier: {reason}.",
    playAgain: "Spill igjen",
  },
  settings: {
    title: "Innstillinger",
    label: "Innstillinger",
    llm: {
      section: "LLM-motstander",
      endpoint: "Endepunkt-URL",
      endpointHint:
        "OpenAI-kompatibel basis-URL, f.eks. http://localhost:1234/v1 for LM Studio eller Ollama.",
      model: "Modellnavn",
      modelHint: "Sendes som modellfeltet i hver chat-fullføring.",
      timeout: "Tidsgrense for forespørsel (sekunder)",
      timeoutHint: "Hvor lenge boten kan tenke før den heuristiske botten tar over.",
      fallbackNotice: "Varsle når boten faller tilbake til heuristikk",
    },
    audio: {
      section: "Lyd",
      masterVolume: "Hovedvolum",
      sfxVolume: "Volum for lydeffekter",
      mute: "Demp all lyd",
      hint:
        "Lydeffektene genereres i nettleseren med Web Audio API — ingen lydfiler lastes ned.",
    },
    save: "Lagre",
    close: "Lukk",
  },
  help: {
    title: "Regler og hjelp",
    label: "Regler og hjelp",
    close: "Lukk",
    intro: {
      title: "Om Sáhkku",
      body: "Sáhkku er et tradisjonelt brettspill for det samiske folket. To spillere fører hver sin hær rundt et brett formet som et åttetall, jager hverandres soldater og kjemper om kongen som står mellom dem.",
    },
    board: {
      title: "Brettet og banen",
      body: "Brettet har tre rader med femten skårne ruter. Ytterradene er hjemradene, og raden mellom dem er delt. Hver brikke følger åttetallssløyfen: framover langs sin egen rad, over til motstanderens halvdel og tilbake igjen. Rutene med et skåret X er hellige.",
    },
    dice: {
      title: "Terningene (birccu)",
      body: "Tre firekantede terninger kastes hver tur. X (sáhkku) er ett steg og vekker dessuten en sovende soldat; III er tre steg, II to steg og den blanke siden ingenting. Terningene må brukes i den rekkefølgen reglene bestemmer, og en sáhkku kan kastes på nytt før noen terning er brukt.",
    },
    pieces: {
      title: "Brikkene",
      body: "Spiller én fører kvinnene (nisu) og spiller to mennene (almmái); hver side har også en dronning. Kongen (gonagas) står nøytral på sin hellige rute til en soldat når motstanderens hjemrad og verver ham.",
    },
    activation: {
      title: "Aktiveringskøen",
      body: "Soldatene venter i kø i hjemraden sin. En sáhkku aktiverer den fremste ventende soldaten, og når en brikke som fortsatt står i køen flyttes, vekker den neste brikke bak den — hæren slippes løs bakfra og framover.",
    },
    win: {
      title: "Slik vinner du",
      body: "Du vinner så snart motstanderen ikke har flere soldater igjen på brettet, eller så snart du fanger motstanderens dronning.",
    },
    credit:
      "Sáhkku er et tradisjonelt spill for det samiske folket. Denne klienten, regelmotoren og agentene er åpen kildekode.",
  },
  notifications: {
    searchFallback: "AI-søket feilet — bruker nødheuristikken.",
    llmFallback: "LLM-endepunktet svarte ikke — spiller det heuristiske trekket.",
    dismiss: "Skjul",
  },
};

/** Every locale's table, keyed by locale code. */
export const stringTables: Record<Locale, StringTable> = {
  se: northSamiStrings,
  no: norwegianStrings,
  en: englishStrings,
};

/**
 * Flattens a table to `dotted.key -> text`, which is what `I18n` looks up and what the completeness
 * test walks. Non-string leaves are skipped, so a partially filled nested node can never be mistaken
 * for a complete one.
 */
export function flattenStringTable(table: StringTable | Record<string, unknown>): Map<string, string> {
  const flat = new Map<string, string>();

  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      if (typeof value === "string") {
        flat.set(path, value);
      } else if (typeof value === "object" && value !== null) {
        walk(value as Record<string, unknown>, path);
      }
    }
  };

  walk(table as Record<string, unknown>, "");
  return flat;
}
