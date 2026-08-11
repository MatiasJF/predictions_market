// UI-010 — the design tokens are a contract, and contracts get checked.
//
// Two failure modes here are invisible until someone hits them in the wrong theme, which is exactly
// when nobody is looking:
//
//   1. THE DARK PALETTE IS DEFINED TWICE, on purpose — once behind `prefers-color-scheme` so the app
//      follows the OS, once under `[data-theme="dark"]` so an explicit choice can override a system
//      that says otherwise. Duplication drifts. If someone tunes a colour in one block and not the
//      other, half the users get the old value and the bug reproduces for nobody who investigates.
//
//   2. A COLOUR DEFINED ONLY INSIDE A MEDIA QUERY cannot be overridden by the toggle at all — the
//      light theme would inherit a dark value or nothing. Every token must exist on bare `:root`.
//
// Neither is caught by typecheck, by the journey test, or by looking at the app in one theme.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

/**
 * Comments are stripped BEFORE anything is parsed.
 *
 * Learned the hard way: the first version of this file found its blocks with `indexOf(selector)`,
 * and tokens.css opens with a comment explaining the theming rules — which quotes every selector it
 * describes. So each lookup matched the prose, parsed from the wrong offset, and ended up comparing
 * the light palette against itself. All five tests passed and none of them tested anything.
 *
 * It was caught by deliberately drifting one dark value and checking the suite went red. It didn't.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokensCss = strip(readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8'));

/** The body of the first block matching `selector`, brace-matched so nesting cannot truncate it. */
function blockOf(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(open, i); }
  }
  throw new Error(`unterminated block for ${selector}`);
}

/** Variable names declared inside the first block matching `selector`. */
function declaredIn(css: string, selector: string): Set<string> {
  return new Set([...blockOf(css, selector).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

const light = declaredIn(tokensCss, ':root {');
const darkAuto = declaredIn(tokensCss, ':root:not([data-theme="light"])');
const darkExplicit = declaredIn(tokensCss, ':root[data-theme="dark"]');

describe('design tokens', () => {
  it('defines the two dark palettes identically — duplication that drifts is worse than none', () => {
    const onlyAuto = [...darkAuto].filter((v) => !darkExplicit.has(v));
    const onlyExplicit = [...darkExplicit].filter((v) => !darkAuto.has(v));
    expect(onlyAuto, 'declared for prefers-color-scheme but NOT for the explicit toggle').toEqual([]);
    expect(onlyExplicit, 'declared for the explicit toggle but NOT for prefers-color-scheme').toEqual([]);
  });

  it('gives the two dark palettes the same VALUES, not just the same names', () => {
    const values = (selector: string) => {
      const out = new Map<string, string>();
      for (const m of blockOf(tokensCss, selector).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        out.set(m[1]!, m[2]!.trim());
      }
      return out;
    };
    const a = values(':root:not([data-theme="light"])');
    const b = values(':root[data-theme="dark"]');
    for (const [name, value] of a) {
      expect(b.get(name), `${name} differs between the two dark blocks`).toBe(value);
    }
  });

  it('declares every dark token on bare :root too, so the light theme can never inherit a dark value', () => {
    const missing = [...darkAuto].filter((v) => !light.has(v));
    expect(missing, 'defined only inside a media query — the toggle cannot override these').toEqual([]);
  });

  it('keeps NO and DANGER different — the defect this palette was designed to fix', () => {
    const val = (css: string, sel: string, name: string) =>
      blockOf(css, sel).match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
    for (const sel of [':root {', ':root[data-theme="dark"]']) {
      const no = val(tokensCss, sel, '--negative');
      const danger = val(tokensCss, sel, '--danger');
      expect(no, `${sel}: --negative missing`).toBeTruthy();
      // The old stylesheet gave --no and --err the same hex, so a market's NO side was
      // indistinguishable from an error. Never again, in either theme.
      expect(no, `${sel}: a market's NO side must not look like an error`).not.toBe(danger);
    }
  });

  /**
   * Glass duplicates its dark block for the same reason the base palette does — follow-the-OS and
   * explicit-choice need separate selectors — so it carries the same drift risk and gets the same check.
   */
  it('keeps the two dark GLASS blocks in step, name and value', () => {
    const auto = blockOf(tokensCss, ':root[data-surface="glass"]:not([data-theme="light"])');
    const explicit = blockOf(tokensCss, ':root[data-surface="glass"][data-theme="dark"]');
    const decls = (body: string) => {
      const m = new Map<string, string>();
      for (const d of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) m.set(d[1]!, d[2]!.trim());
      return m;
    };
    const a = decls(auto); const b = decls(explicit);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [k, v] of a) expect(b.get(k), `${k} differs between the dark glass blocks`).toBe(v);
  });

  it('changes only SURFACES in glass — never text or meaning colours', () => {
    const glass = declaredIn(tokensCss, ':root[data-surface="glass"]');
    // Readable-contrast decisions were made once. Glass is a finish, not a reason to revisit them.
    const forbidden = [...glass].filter((v) => /^--(text|positive|negative|danger|warning|accent)/.test(v));
    expect(forbidden, 'glass must not redefine text or meaning colours').toEqual([]);
  });

  it('uses only tokens that exist — a typo in a var() name fails silently in the browser', () => {
    const cssFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith('.css')) cssFiles.push(join(dir, e.name));
      }
    };
    walk(SRC);

    // Everything declared anywhere, plus the locally-scoped ones components set for themselves.
    const declared = new Set<string>([...light, ...darkAuto, ...darkExplicit]);
    for (const f of cssFiles) {
      for (const m of strip(readFileSync(f, 'utf8')).matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1]!);
    }

    const unknown = new Set<string>();
    for (const f of cssFiles) {
      const css = strip(readFileSync(f, 'utf8'));
      for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!declared.has(m[1]!)) unknown.add(`${m[1]} (in ${f.split('/').pop()})`);
      }
    }
    expect([...unknown], 'var() referencing a token nothing declares').toEqual([]);
  });
});

/**
 * UI-021 — contrast, measured rather than eyeballed.
 *
 * The market fact row (`#8 · deployed · b=20 · pool v0`) shipped as `--text-subtle` at 12px and the
 * report was blunt: "they are too low contrast and they are not seen". Measured afterwards it is
 * 3.03:1 on white — under the 4.5:1 floor, and 12px is not large text, so there is no exemption.
 * Nobody spotted it in review because a palette looks fine until you ask it for a number.
 *
 * So the floor is now arithmetic. `--text-strong` and `--text-muted` are the two colours anything a
 * person must READ is allowed to use, and both must clear 4.5:1 on every surface, in both themes.
 * `--text-subtle` is held to 3:1 and is for decoration — it is deliberately NOT cleared for prose.
 *
 * Glass surfaces are skipped: they are `color-mix(... transparent)`, so their effective contrast
 * depends on whatever shows through, which no static check can know. The solid palette underneath is
 * what this pins down.
 */
const HEX = /^#([0-9a-f]{6})$/i;
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('contrast', () => {
  const themes = { light: ':root {', dark: ':root[data-theme="dark"]' };
  const valueOf = (sel: string, name: string) =>
    blockOf(tokensCss, sel).match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim() ?? '';

  for (const [theme, sel] of Object.entries(themes)) {
    for (const surface of ['--surface-app', '--surface-raised', '--surface-sunken']) {
      const bg = valueOf(sel, surface);
      if (!HEX.test(bg)) continue;

      it(`${theme}: readable text clears 4.5:1 on ${surface}`, () => {
        for (const fg of ['--text-strong', '--text-muted']) {
          const c = contrast(valueOf(sel, fg), bg);
          expect(c, `${fg} on ${surface} in ${theme} is ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it(`${theme}: --text-subtle clears 3:1 on ${surface} — decoration, never prose`, () => {
        const c = contrast(valueOf(sel, '--text-subtle'), bg);
        expect(c, `--text-subtle on ${surface} in ${theme} is ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

/**
 * UI-021 — no emoji or stray Unicode glyphs in the rendered UI.
 *
 * They were used as icons throughout (🔍 ◈ ◎ ⚠ ✓ ↗). Each renders as a different picture per platform,
 * carries its own colour so it ignores the palette, sits on its own baseline, and gets announced by
 * name to a screen reader. `Icon.tsx` replaced them. This stops them coming back one convenient
 * character at a time.
 *
 * Comments are stripped first — the ones explaining WHY the glyphs went are allowed to name them.
 * A line may opt out with a `glyph-ok` marker, for the rare character that is genuinely punctuation
 * rather than an icon ("2 buys → 512"). The marker is checked against the RAW line, so the exemption
 * has to be written down next to the thing it exempts and shows up in review.
 */
describe('iconography', () => {
  it('uses drawn icons, not glyphs, in every component', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith('.tsx')) files.push(join(dir, e.name));
      }
    };
    walk(SRC);

    // Pictographs, dingbats, arrows and the geometric shapes that were standing in for icons.
    const GLYPH = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2460}-\u{27BF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}]/u;
    const offenders: string[] = [];
    for (const f of files) {
      // Line-by-line, tracking block-comment state, so the index of a stripped line is ALWAYS the
      // index of the raw line it came from. A whole-file regex looked equivalent and silently lost a
      // line, which slid every reported number by one and made the `glyph-ok` lookup read its neighbour.
      const rawLines = readFileSync(f, 'utf8').split('\n');
      let inBlock = false;
      const lines = rawLines.map((raw) => {
        let out = '';
        for (let i = 0; i < raw.length; i++) {
          if (inBlock) {
            if (raw.startsWith('*/', i)) { inBlock = false; i++; }
          } else if (raw.startsWith('/*', i)) { inBlock = true; i++; }
          else if (raw.startsWith('//', i)) break;
          else out += raw[i];
        }
        return out;
      });

      for (const [i, line] of lines.entries()) {
        if (rawLines[i]?.includes('glyph-ok')) continue;
        if (GLYPH.test(line)) offenders.push(`${f.split('/').pop()}:${i + 1} ${line.trim().slice(0, 60)}`);
      }
    }
    expect(offenders, 'use <Icon name="…" /> instead of a glyph').toEqual([]);
  });
});
