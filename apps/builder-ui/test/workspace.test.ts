/**
 * Arbetsytans publiceringsdel, renderad till märkspråk (ingen webbläsare behövs), efter samma
 * mönster som `adminPage.test.ts` och `feedbackPanel.test.ts`. Testfilen är .ts, inte .tsx, så
 * vyn skapas med createElement.
 *
 * Det som låses här är vad ägaren FÅR VETA. Hon publicerar inte längre själv — hon begär det, och
 * någon läser koden — och det enda hon har att gå på under tiden är den här ytan. Tre av de fyra
 * lägena är lätta att missförstå, och ett av dem är farligt att missförstå: `tillbakadragen`
 * betyder att ingen hann läsa den version hon begärde, inte att någon sagt nej. Läser hon det som
 * ett underkännande tror hon att appen är fel, när det enda som hänt är att hon byggde om.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BuilderReviewStatus } from '@vibesandbox/contracts';
import {
  PUBLISH_REQUEST_AGAIN_BUTTON,
  PUBLISH_REQUEST_BUTTON,
  PUBLISH_REQUEST_HINT,
  PUBLISH_REQUEST_SENDING,
  REVIEW_OWNER_TEXTS,
  REVIEW_REASON_LEAD,
} from '../src/texts.ts';
import { PublishPanel } from '../src/Workspace.tsx';

function review(state: BuilderReviewStatus['state'], reason: string | null = null): BuilderReviewStatus {
  return {
    state,
    requestedAt: '2026-09-21T09:00:00Z',
    decidedAt: state === 'vantar' || state === 'tillbakadragen' ? null : '2026-09-21T11:00:00Z',
    reason,
  };
}

function render(props: Partial<Parameters<typeof PublishPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PublishPanel, {
      canRequest: true,
      published: false,
      review: null,
      busy: false,
      error: null,
      onRequest: () => {},
      ...props,
    }),
  );
}

/** Knappens text, utan märkspråket runt den. */
function buttonText(html: string): string {
  return /<button[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '';
}

describe('knappen som förut publicerade', () => {
  it('begär publicering — den påstår inte att ägaren publicerar själv', () => {
    const html = render();
    expect(buttonText(html)).toBe(PUBLISH_REQUEST_BUTTON);
    expect(buttonText(html)).toMatch(/[Bb]egär/);
    expect(buttonText(html), 'hon släpper inte ut appen').not.toMatch(/^Publicera$|^Publicerar/);
  });

  it('säger vad som händer när hon trycker, innan hon trycker', () => {
    expect(render()).toContain(PUBLISH_REQUEST_HINT);
  });

  it('en app som redan är ute begär att den NYA versionen ska ersätta den', () => {
    expect(buttonText(render({ published: true }))).toBe(PUBLISH_REQUEST_AGAIN_BUTTON);
  });

  it('går inte att trycka när det inte finns något att begära — eller medan något skickas', () => {
    expect(render({ canRequest: false })).toMatch(/<button[^>]*disabled/);
    const busy = render({ busy: true });
    expect(busy).toMatch(/<button[^>]*disabled/);
    expect(buttonText(busy)).toBe(PUBLISH_REQUEST_SENDING);
  });

  it('utan begäran finns inget läge att visa — ytan påstår ingenting', () => {
    const html = render();
    expect(html).not.toContain(REVIEW_OWNER_TEXTS.vantar.heading);
    expect(html).not.toContain(REVIEW_OWNER_TEXTS.godkand.heading);
  });

  it('ett fel står som ett fel, och läses upp', () => {
    const html = render({ error: 'Det finns ingen färdig version att publicera än.' });
    expect(html).toContain('status-error');
    expect(html).toContain('Det finns ingen färdig version att publicera än.');
    expect(html).toContain('aria-live="polite"');
  });
});

describe('ägarens fyra lägen', () => {
  it('väntar: hon ser att det är igång, och att hon inte behöver göra något', () => {
    const html = render({ canRequest: false, review: review('vantar') });
    expect(html).toContain(REVIEW_OWNER_TEXTS.vantar.heading);
    expect(html).toContain(REVIEW_OWNER_TEXTS.vantar.body);
    expect(html, 'att vänta är inget fel').not.toContain('notice-error');
    // Knappen är stängd medan ärendet ligger i kö: servern svarar ändå att appen redan väntar.
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('godkänd: appen är läst och publicerad, och det syns som en god nyhet', () => {
    const html = render({ published: true, review: review('godkand') });
    expect(html).toContain(REVIEW_OWNER_TEXTS.godkand.heading);
    expect(html).toContain(REVIEW_OWNER_TEXTS.godkand.body);
    expect(html).toContain('notice-ok');
  });

  it('avvisad: granskarens skäl står ordagrant, och det syns vems orden är', () => {
    const reason = 'Appen sparar personnummer i klartext. Ta bort fältet först.';
    const html = render({ review: review('avvisad', reason) });
    expect(html).toContain(REVIEW_OWNER_TEXTS.avvisad.heading);
    expect(html).toContain(REVIEW_REASON_LEAD);
    expect(html, 'skälet sammanfattas aldrig').toContain(reason);
    expect(html.indexOf(REVIEW_REASON_LEAD)).toBeLessThan(html.indexOf(reason));
    // Och vad hon kan göra härnäst, annars är avslaget en återvändsgränd.
    expect(html).toMatch(/begär publicering igen/);
  });

  it('avvisad utan skäl visar ingen tom citatruta', () => {
    const html = render({ review: review('avvisad', '') });
    expect(html).toContain(REVIEW_OWNER_TEXTS.avvisad.heading);
    expect(html).not.toContain(REVIEW_REASON_LEAD);
    expect(html).not.toContain('<blockquote');
  });

  it('tillbakadragen läses inte som ett avslag: ingen sa nej, ingen hann läsa', () => {
    const html = render({ review: review('tillbakadragen') });
    expect(html).toContain(REVIEW_OWNER_TEXTS.tillbakadragen.heading);
    expect(html).toMatch(/[Ii]ngen har alltså sagt nej/);
    expect(html).toMatch(/byggde om/);
    expect(html).toMatch(/begär publicering igen/);
    // Inget i läget är ett avslag, och inget av orden för ett avslag får stå här.
    expect(html).not.toMatch(/avvisad|underkänd|nekad/i);
    expect(html, 'ingenting har gått sönder').not.toContain('notice-error');
    expect(html).not.toContain(REVIEW_OWNER_TEXTS.avvisad.heading);
  });

  it('ett läge vi inte känner igen hittar inte på ett besked åt henne', () => {
    const odd = { ...review('vantar'), state: 'utskickad' } as unknown as BuilderReviewStatus;
    const html = render({ review: odd });
    expect(html).toContain(REVIEW_OWNER_TEXTS.vantar.heading);
    expect(html).not.toContain('utskickad');
    expect(html).not.toContain(REVIEW_OWNER_TEXTS.godkand.heading);
  });

  it('läget läses upp när det ändras — hon kan stå kvar på sidan i timmar', () => {
    const html = render({ review: review('vantar') });
    expect(html).toMatch(/<div aria-live="polite">/);
  });
});
