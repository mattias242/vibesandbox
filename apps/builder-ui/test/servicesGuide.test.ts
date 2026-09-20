/**
 * Panelen med guiden, renderad till märkspråk (ingen webbläsare behövs). Det som kontrolleras är
 * att vyn visar det data säger: rubrikstruktur, bara påslagna tjänster och gränserna.
 *
 * Testfilen är .ts, inte .tsx (vitest plockar upp .test.ts), så vyn skapas med createElement.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BASE_CAPABILITIES, GUIDE_TITLE, LIMITS_HEADING, SERVICES_NONE, SERVICE_CAPABILITIES } from '../src/formagor.ts';
import { ServicesGuide } from '../src/ServicesGuide.tsx';

function render(services: readonly ('files' | 'llm' | 'search' | 'notify' | 'schedule')[]): string {
  return renderToStaticMarkup(createElement(ServicesGuide, { open: true, services, onClose: () => {} }));
}

describe('panelen', () => {
  it('har en rubrik, en nivå per avsnitt och en förmåga per rubrik', () => {
    const html = render(['files']);
    expect(html).toContain(`<h2 id=`);
    expect(html).toContain(GUIDE_TITLE);
    expect(html.match(/<h3/g) ?? []).toHaveLength(3);
    expect(html.match(/<h4/g) ?? []).toHaveLength(BASE_CAPABILITIES.length + 1);
    expect(html).toContain(LIMITS_HEADING);
  });

  it('visar bara de påslagna tjänsterna', () => {
    const html = render(['files', 'llm']);
    expect(html).toContain(SERVICE_CAPABILITIES.files.title);
    expect(html).toContain(SERVICE_CAPABILITIES.llm.title);
    expect(html).not.toContain(SERVICE_CAPABILITIES.search.title);
  });

  it('säger till när inga tjänster är påslagna, men visar ändå grundförmågorna', () => {
    const html = render([]);
    expect(html).toContain(SERVICES_NONE);
    for (const capability of BASE_CAPABILITIES) expect(html).toContain(capability.title);
  });

  it('gränserna nämner påminnelser bara när de är påslagna', () => {
    expect(render([])).not.toContain('påminnelser');
    expect(render(['notify', 'schedule'])).toContain('påminnelser');
  });

  it('knappen Använd visas inte när ingen chattruta är öppen', () => {
    expect(render(['files'])).not.toContain('>Använd<');
  });

  it('panelen är en dialogruta som pekar ut sin egen rubrik', () => {
    const html = render(['files']);
    const labelled = /<dialog[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelled).toBeDefined();
    expect(html).toContain(`<h2 id="${labelled ?? ''}"`);
  });
});
