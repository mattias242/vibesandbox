/**
 * Tummarna och rutan, renderade till märkspråk (ingen webbläsare behövs), efter samma mönster
 * som `servicesGuide.test.ts`. Testfilen är .ts, inte .tsx, så vyerna skapas med createElement.
 *
 * Det viktigaste som låses här: innan man kan skicka står det i rutan att HELA konversationen
 * följer med, och den går att fälla ut och läsa. Det är ett löfte, inte en formalia.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BuilderMessage } from '@vibesandbox/contracts';
import { FeedbackForm, ToolFeedback } from '../src/Feedback.tsx';
import { FEEDBACK_SHARE_NOTICE } from '../src/feedback.ts';

const MESSAGES: readonly BuilderMessage[] = [
  { role: 'user', text: 'En lista där vi bokar mötesrum', createdAt: '2026-09-20T10:00:00Z' },
  { role: 'assistant', text: 'Nu finns en första version.', createdAt: '2026-09-20T10:01:00Z' },
];

function renderThumbs(): string {
  return renderToStaticMarkup(createElement(ToolFeedback, { appId: 'app-1', messages: MESSAGES }));
}

function renderForm(overrides: Partial<Parameters<typeof FeedbackForm>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(FeedbackForm, {
      messages: MESSAGES,
      text: '',
      sending: false,
      error: null,
      onTextChange: () => {},
      onSubmit: () => {},
      onCancel: () => {},
      ...overrides,
    }),
  );
}

describe('tummarna', () => {
  it('är två riktiga knappar med namn som säger vad de gör', () => {
    const html = renderThumbs();
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(html).toMatch(/[Jj]a, det hjälpte/);
    expect(html).toMatch(/[Nn]ej, det hjälpte inte/);
    for (const button of buttons) expect(button).toContain('type="button"');
  });

  it('gäller byggverktyget, inte appen — och frågan hör ihop med knapparna', () => {
    const html = renderThumbs();
    expect(html).toMatch(/byggverktyget/i);
    const labelled = /<div[^>]*role="group"[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelled, 'knapparna ska peka ut frågan de svarar på').toBeDefined();
    expect(html).toContain(`id="${labelled ?? ''}"`);
  });

  it('ritar tummen med märkspråk och låter den vara stum för uppläsning', () => {
    const html = renderThumbs();
    expect(html).toContain('<svg');
    expect(html.match(/<svg[^>]*aria-hidden="true"/g) ?? []).toHaveLength(2);
    expect(html, 'inga ikoner eller typsnitt utifrån (CSP)').not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('öppnar inget textfält förrän man tryckt tumme ner', () => {
    expect(renderThumbs()).not.toContain('<textarea');
  });

  it('har en kvittorad som läses upp när den fylls', () => {
    expect(renderThumbs()).toMatch(/aria-live="polite"/);
  });
});

describe('rutan för tumme ner', () => {
  it('säger att hela konversationen följer med, innan knappen att skicka', () => {
    const html = renderForm();
    const notice = html.indexOf(FEEDBACK_SHARE_NOTICE);
    const submit = html.indexOf('type="submit"');
    expect(notice, 'löftet ska stå i rutan').toBeGreaterThanOrEqual(0);
    expect(submit).toBeGreaterThan(notice);
  });

  it('kopplar löftet till textfältet, så att det läses upp med fältet', () => {
    const html = renderForm();
    const described = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeDefined();
    const ids = (described ?? '').split(' ');
    for (const id of ids) expect(html).toContain(`id="${id}"`);
    const noticeId = ids.find((id) => {
      const block = new RegExp(`id="${id}"[^>]*>([^<]*)`).exec(html)?.[1] ?? '';
      return block.includes(FEEDBACK_SHARE_NOTICE.slice(0, 20));
    });
    expect(noticeId, 'ett av de utpekade elementen ska vara löftet').toBeDefined();
  });

  it('går att fälla ut och läsa vad som skickas med', () => {
    const html = renderForm();
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    for (const message of MESSAGES) expect(html).toContain(message.text);
  });

  it('har ett textfält, en skicka-knapp och ett sätt att ångra sig', () => {
    const html = renderForm();
    expect(html).toContain('<textarea');
    expect(html).toContain('type="submit"');
    expect(html).toMatch(/[Aa]vbryt/);
  });

  it('visar felet som en varning som läses upp, och märker fältet som fel', () => {
    const html = renderForm({ error: 'Skriv några ord om vad som inte hjälpte.' });
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain('Skriv några ord om vad som inte hjälpte.');
    expect(html).toMatch(/<textarea[^>]*aria-invalid="true"/);
  });

  it('låser rutan medan den skickas, så att inget går iväg två gånger', () => {
    const html = renderForm({ sending: true, text: 'Den förstod inte vad jag menade.' });
    expect(html.match(/<button[^>]*disabled/g) ?? []).toHaveLength(2);
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });
});
