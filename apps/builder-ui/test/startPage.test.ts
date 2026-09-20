/**
 * Startsidan renderad till märkspråk (ingen webbläsare behövs), efter samma mönster som
 * `servicesGuide.test.ts`. Testfilen är .ts, inte .tsx, så vyn skapas med createElement.
 *
 * Det som kontrolleras är läsordningen. På bred skärm ligger Mina appar bredvid skrivrutan i
 * stället för under den, men placeringen sker med grid-column/grid-row som speglar ordningen i
 * DOM — aldrig med `order` eller `grid-auto-flow: dense`, som hade fått tangentbordet att hoppa
 * någon annanstans än ögat. Det här testet går sönder om någon flyttar delarna i stället.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StartPage } from '../src/StartPage.tsx';

/** Effekter körs inte vid serverrendering, så api.listApps() anropas aldrig och behöver ingen mock. */
function render(): string {
  return renderToStaticMarkup(createElement(StartPage));
}

describe('startsidan', () => {
  it('samlar sina tre delar i ett spaltblock', () => {
    const html = render();
    expect(html.match(/class="start-columns"/g) ?? []).toHaveLength(1);
  });

  it('har skrivrutan före Mina appar före Trygghet och kontroll i DOM', () => {
    const html = render();
    const columns = html.indexOf('class="start-columns"');
    const wish = html.indexOf('class="wish"');
    const myApps = html.indexOf('class="my-apps"');
    const safety = html.indexOf('class="safety"');

    expect(columns).toBeGreaterThanOrEqual(0);
    expect(wish).toBeGreaterThan(columns);
    expect(myApps).toBeGreaterThan(wish);
    expect(safety).toBeGreaterThan(myApps);
  });
});
