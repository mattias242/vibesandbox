/**
 * Granskar stilmallens källtext mot de regler som inte syns i den renderade sidan, efter samma
 * idé som `packages/policy/test/source.test.ts`: läs texten, pröva den mot regler.
 *
 * Det här fångar inte hur gränssnittet ser ut — brytpunkter och layout går bara att se med ögat.
 * Det fångar tillgänglighetsgolvet, som annars är osynligt: rotens textstorlek är satt i procent
 * så att användarens egen webbläsarinställning slår igenom, ingen text hamnar under 13 px, och
 * ingen klickyta mäts i rem (då krymper den när rotens textstorlek sänks).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Minsta faktiska textstorlek. Under det blir småtexten svårläst för den som ser lite sämre. */
const MIN_TEXT_PX = 13;

/** Minsta klickyta i CSS-pixlar (WCAG 2.5.5). */
const MIN_TAP_PX = 44;

/** Webbläsarens grundstorlek, som rotens procentsats räknas mot. */
const BROWSER_DEFAULT_PX = 16;

/** Selektorer vars block beskriver något man klickar eller skriver i. */
const CONTROL_SELECTORS = ['.button', '.chip', '.input', '.link-button'];

const cssPath = fileURLToPath(new URL('../src/styles.css', import.meta.url));

/** Kommentarerna är prosa och kan innehålla klammer — de ska inte läsas som CSS. */
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Block {
  readonly selector: string;
  readonly body: string;
}

/**
 * Plockar ut de innersta blocken, alltså även dem som ligger inuti en @media-fråga:
 * `[^{}]+` kan inte passera en klammer, så matchningen stannar på den närmaste selektorn.
 * Stilmallen är handskriven, platt och utan CSS-nästling, så det räcker.
 */
function blocks(): readonly Block[] {
  const found: Block[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector = '', body = ''] = match;
    found.push({ selector: selector.trim().replace(/\s+/g, ' '), body });
  }
  return found;
}

/** Rotens textstorlek i px, räknad ur den procentsats stilmallen själv sätter. */
function rootPx(): number {
  const root = blocks().find((block) => block.selector === ':root');
  expect(root, ':root-blocket ska finnas').toBeDefined();
  const percent = /font-size:\s*([\d.]+)%/.exec(root!.body);
  expect(percent, 'rotens font-size ska stå i :root').not.toBeNull();
  return (Number(percent![1]) / 100) * BROWSER_DEFAULT_PX;
}

describe('rotens textstorlek', () => {
  it('anges i procent, så att användarens egen inställning slår igenom', () => {
    const root = blocks().find((block) => block.selector === ':root');
    expect(root?.body).toMatch(/font-size:\s*[\d.]+%/);
    expect(root?.body ?? '').not.toMatch(/font-size:\s*[\d.]+px/);
  });
});

describe('textgolvet', () => {
  it(`ingen text blir mindre än ${MIN_TEXT_PX} px`, () => {
    const rot = rootPx();
    const small: string[] = [];
    for (const block of blocks()) {
      for (const match of block.body.matchAll(/font-size:\s*([\d.]+)rem/g)) {
        const px = Number(match[1]) * rot;
        if (px < MIN_TEXT_PX) small.push(`${block.selector} → ${match[1]}rem = ${px.toFixed(2)} px`);
      }
    }
    expect(small, `rot ${rot} px; höj värdet eller rotens procentsats`).toEqual([]);
  });

  it('ingen textstorlek anges i px, eftersom px inte följer användarens inställning', () => {
    const fixed: string[] = [];
    for (const block of blocks()) {
      if (/font-size:\s*[\d.]+px/.test(block.body)) fixed.push(block.selector);
    }
    expect(fixed).toEqual([]);
  });
});

describe('klickytorna', () => {
  it(`--tap är minst ${MIN_TAP_PX} px`, () => {
    const root = blocks().find((block) => block.selector === ':root');
    const tap = /--tap:\s*(\d+)px/.exec(root?.body ?? '');
    expect(tap, '--tap ska finnas i :root och anges i px').not.toBeNull();
    expect(Number(tap![1])).toBeGreaterThanOrEqual(MIN_TAP_PX);
  });

  it('mäts i px, inte i rem — annars krymper de när rotens textstorlek sänks', () => {
    const relative: string[] = [];
    for (const block of blocks()) {
      if (!CONTROL_SELECTORS.some((name) => block.selector.includes(name))) continue;
      for (const match of block.body.matchAll(/min-height:\s*([\d.]+)rem/g)) {
        relative.push(`${block.selector} → min-height: ${match[1]}rem`);
      }
    }
    expect(relative, 'använd px eller var(--tap)').toEqual([]);
  });
});
