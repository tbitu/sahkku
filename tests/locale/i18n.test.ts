/**
 * Localization tests — `T4_I18N_COMPLETENESS` and the lookup contract around it.
 *
 * The translation tables are *data*, and the two ways that data can go wrong are structural: a locale
 * that is missing a key, and a translation that dropped (or invented) a `{placeholder}`. Both are
 * asserted mechanically over every key of every locale rather than spot-checked, so a new string cannot
 * be added in English alone.
 *
 * The behavioural half covers what `I18n` promises the views: an English fallback, a live `t` that
 * follows the active locale, and a change notification carrying the new and the previous locale.
 */

import { describe, expect, it } from "vitest";

import {
  DefaultLocale,
  I18n,
  Locales,
  LocaleInfos,
  defaultTranslate,
  flattenLocale,
  interpolate,
  normalizeLocale,
  stringTables,
  translate,
} from "../../src/locale/i18n";

/** The `{placeholder}` names of a template, sorted, so two templates can be compared as sets. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("i18n: the shipped tables (T4_I18N_COMPLETENESS)", () => {
  it("ships exactly the three locales the contract names", () => {
    expect([...Locales].sort()).toEqual(["en", "no", "se"]);
    expect(DefaultLocale).toBe("en");

    for (const locale of Locales) {
      expect(stringTables[locale]).toBeDefined();
    }
    expect(LocaleInfos.map((info) => info.code).sort()).toEqual([...Locales].sort());
    for (const info of LocaleInfos) {
      expect(info.nativeName.length).toBeGreaterThan(0);
      expect(info.englishName.length).toBeGreaterThan(0);
    }
  });

  it("defines every English key in every locale, with no extra keys of its own", () => {
    const english = [...flattenLocale("en").keys()].sort();

    for (const locale of Locales) {
      const keys = [...flattenLocale(locale).keys()].sort();
      const missing = english.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !english.includes(key));

      expect(missing, `${locale} is missing keys`).toEqual([]);
      expect(extra, `${locale} has keys English does not`).toEqual([]);
    }
  });

  it("keeps the same placeholders in every locale, so no value can be dropped from a sentence", () => {
    const english = flattenLocale("en");

    for (const locale of Locales) {
      if (locale === DefaultLocale) continue;
      const table = flattenLocale(locale);

      for (const [key, text] of english) {
        const translated = table.get(key);
        expect(translated, `${locale} is missing ${key}`).toBeDefined();
        expect(placeholders(translated!), `${locale} placeholders of ${key}`).toEqual(
          placeholders(text),
        );
      }
    }
  });

  it("covers the sections the L1 contract names", () => {
    const english = flattenLocale("en");
    const sections = ["menu", "status", "pieces", "dice", "events", "settings", "help"];

    for (const section of sections) {
      const keys = [...english.keys()].filter((key) => key.startsWith(`${section}.`));
      expect(keys.length, `${section} has no strings`).toBeGreaterThan(0);
    }

    // ...and the pieces, dice faces and match modes the contract names inside them.
    for (const required of [
      "menu.start",
      "menu.modes.humanVsBot",
      "menu.modes.hotseat2p",
      "menu.modes.botVsBot",
      "status.thinking",
      "status.rerollPrompt",
      "pieces.soldier",
      "pieces.woman",
      "pieces.man",
      "pieces.queen",
      "pieces.king",
      "dice.face.sahkku",
      "dice.face.three",
      "dice.face.two",
      "dice.face.zero",
      "events.soldierCaptured",
      "events.kingRecruited",
      "events.gameWon",
      "settings.llm.endpoint",
      "settings.llm.model",
      "settings.llm.timeout",
      "settings.audio.sfxVolume",
      "settings.audio.mute",
      "help.intro.body",
      "help.start.title",
      "help.start.body",
    ]) {
      expect(english.has(required), `missing ${required}`).toBe(true);
    }
  });

  it("translates the terminology the game is about, not just the chrome", () => {
    const se = flattenLocale("se");
    const no = flattenLocale("no");
    const en = flattenLocale("en");

    // North Sámi keeps the traditional piece names.
    expect(se.get("pieces.woman")).toBe("Nisu");
    expect(se.get("pieces.king")).toBe("Gonagas");
    expect(se.get("dice.face.three")).toBe("III (golbma)");
    expect(se.get("dice.face.two")).toBe("II (guokte)");

    // Norwegian names the sides and the dice face differently from English.
    expect(no.get("owners.p1")).not.toBe(en.get("owners.p1"));
    expect(no.get("dice.roll")).not.toBe(en.get("dice.roll"));
    expect(se.get("menu.start")).not.toBe(en.get("menu.start"));
    expect(se.get("status.rollPrompt")).not.toBe(en.get("status.rollPrompt"));
  });
});

describe("i18n: lookup, fallback and interpolation", () => {
  it("resolves a key in the active locale", () => {
    expect(translate("en", "dice.roll")).toBe("Roll Dice");
    expect(translate("no", "dice.roll")).toBe("Kast terningene");
    expect(translate("se", "dice.roll")).toBe("Bálkke birccuid");
  });

  it("falls back to English for a key the locale does not define, and to the key itself as a last resort", () => {
    // The tables are typed complete, so this borrows the live map and puts the key back afterwards:
    // it is the only way to exercise the defensive fallback a partially loaded locale would hit.
    const se = flattenLocale("se");
    const english = flattenLocale("en");
    const key = "dice.roll";
    const original = se.get(key)!;
    expect(original).not.toBe(english.get(key));

    se.delete(key);
    try {
      expect(translate("se", key)).toBe(english.get(key));
    } finally {
      se.set(key, original);
    }

    expect(translate("se", "no.such.key")).toBe("no.such.key");
    expect(defaultTranslate("no.such.key")).toBe("no.such.key");
  });

  it("fills placeholders and leaves unknown ones alone", () => {
    expect(interpolate("{player}: roll the dice.", { player: "P1 · Women" })).toBe(
      "P1 · Women: roll the dice.",
    );
    expect(interpolate("Die {index}: {unknown}", { index: 3 })).toBe("Die 3: {unknown}");
    expect(interpolate("no placeholders", { ignored: 1 })).toBe("no placeholders");
    expect(interpolate("{n}", { n: 0 })).toBe("0");
  });

  it("interpolates through the lookup, and still fills an English fallback's placeholders", () => {
    expect(translate("no", "status.diceOrder", { die: 2, total: 3 })).toBe("Bruker terning 2 av 3.");
    expect(defaultTranslate("status.diceOrder", { die: 1, total: 3 })).toBe(
      "Spending die 1 of 3.",
    );
  });

  it("normalizes locale codes from untrusted input", () => {
    expect(normalizeLocale(null)).toBe("en");
    expect(normalizeLocale("")).toBe("en");
    expect(normalizeLocale("SE")).toBe("se");
    expect(normalizeLocale("se-NO")).toBe("se");
    expect(normalizeLocale("nb")).toBe("no");
    expect(normalizeLocale("nb-NO")).toBe("no");
    expect(normalizeLocale("nn")).toBe("no");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("de")).toBe("en");
  });
});

describe("i18n: the reactive locale", () => {
  it("starts on English and switches to a normalized locale", () => {
    const i18n = new I18n();
    expect(i18n.locale).toBe("en");

    expect(i18n.setLocale("nb-NO")).toBe("no");
    expect(i18n.locale).toBe("no");
    expect(i18n.setLocale("klingon")).toBe("en");
  });

  it("keeps `t` live: a translator handed out before a switch speaks the new language", () => {
    const i18n = new I18n("en");
    const t = i18n.t;

    expect(t("dice.roll")).toBe("Roll Dice");
    i18n.setLocale("se");
    expect(t("dice.roll")).toBe("Bálkke birccuid");
  });

  it("notifies subscribers with the new and the previous locale, and only on a real change", () => {
    const i18n = new I18n("en");
    const seen: Array<[string, string]> = [];
    const unsubscribe = i18n.subscribe((locale, previous) => {
      seen.push([locale, previous]);
    });

    i18n.setLocale("en");
    expect(seen).toEqual([]);

    i18n.setLocale("no");
    i18n.setLocale("no-NO");
    expect(seen).toEqual([["no", "en"]]);

    unsubscribe();
    i18n.setLocale("se");
    expect(seen).toEqual([["no", "en"]]);
  });

  it("lets a listener unsubscribe while it is being notified", () => {
    const i18n = new I18n("en");
    let calls = 0;

    const unsubscribe = i18n.subscribe(() => {
      calls++;
      unsubscribe();
    });

    i18n.setLocale("no");
    i18n.setLocale("se");
    expect(calls).toBe(1);
  });
});
