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
import type { AppExport, BuilderReviewStatus, DecommissionEvidence } from '@vibesandbox/contracts';
import {
  DECOMMISSION_BUSY,
  DECOMMISSION_BUTTON,
  DECOMMISSION_CONFIRM_LABEL,
  DECOMMISSION_DONE_BODY,
  DECOMMISSION_DONE_HEADING,
  DECOMMISSION_DONE_LINK,
  DECOMMISSION_REMAINS,
  DECOMMISSION_WARNING,
  EXPORT_BUSY,
  EXPORT_BUTTON,
  EXPORT_WHY,
  PUBLISH_REQUEST_AGAIN_BUTTON,
  PUBLISH_REQUEST_BUTTON,
  PUBLISH_REQUEST_HINT,
  PUBLISH_REQUEST_SENDING,
  REVIEW_OWNER_TEXTS,
  REVIEW_REASON_LEAD,
  decommissionConfirmHint,
  decommissionEvidenceText,
  exportFileName,
} from '../src/texts.ts';
import { DecommissionDone, DecommissionPanel, PublishPanel, exportFile } from '../src/Workspace.tsx';

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


/**
 * Avvecklingsrutan. Tre saker låses här.
 *
 * Exporten står FÖRE avvecklingen, i samma ruta. Det är inte en smaksak: uppgifter i en app hos en
 * kommun kan vara allmän handling, och vägen ut ska erbjudas innan vägen bort.
 *
 * Knappen är STÄNGD tills appens namn står ordagrant i rutan — fel skiftläge inräknat. Den som
 * skriver "bokning av mötesrum" om appen heter "Bokning av mötesrum" har inte läst namnet, och den
 * som inte läst namnet har inte den app hon tror framför sig.
 *
 * Och ägaren ska ha fått veta både vad som raderas och vad som INTE gör det, innan hon trycker.
 */
describe('avvecklingsrutan', () => {
  const APP_NAME = 'Bokning av mötesrum';

  function renderPanel(props: Partial<Parameters<typeof DecommissionPanel>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(DecommissionPanel, {
        appName: APP_NAME,
        confirmText: '',
        onConfirmText: () => {},
        onExport: () => {},
        exporting: false,
        exportError: null,
        onDecommission: () => {},
        decommissioning: false,
        error: null,
        ...props,
      }),
    );
  }

  /** Texten i knappen med det givna märket, utan märkspråket runt den. */
  function buttons(html: string): readonly string[] {
    return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1] ?? '');
  }

  it('erbjuder exporten i samma ruta, och före knappen som raderar', () => {
    const html = renderPanel();
    expect(html).toContain(EXPORT_BUTTON);
    expect(html).toContain(DECOMMISSION_BUTTON);
    expect(html.indexOf(EXPORT_BUTTON), 'vägen ut ska erbjudas först').toBeLessThan(html.indexOf(DECOMMISSION_BUTTON));
    // Och skälet står med den, inte någon annanstans: utan det ser nedladdningen ut som en
    // bekvämlighet i stället för något någon kan vara skyldig att göra.
    expect(html).toContain(EXPORT_WHY);
    expect(html.indexOf(EXPORT_WHY)).toBeLessThan(html.indexOf(EXPORT_BUTTON));
  });

  it('säger vad som raderas och vad som står kvar, innan bekräftelserutan', () => {
    const html = renderPanel();
    expect(html).toContain(DECOMMISSION_WARNING);
    expect(html).toContain(DECOMMISSION_REMAINS);
    expect(html.indexOf(DECOMMISSION_WARNING)).toBeLessThan(html.indexOf('<input'));
    expect(html.indexOf(DECOMMISSION_REMAINS)).toBeLessThan(html.indexOf('<input'));
    // Ingenting har gått fel — det är ägaren som är på väg att göra något. De två ska inte se lika ut.
    expect(html, 'en varning är inte ett fel').not.toContain('notice-error');
  });

  it('knappen är stängd innan något skrivits', () => {
    const html = renderPanel();
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Avveckla/);
  });

  it.each([
    ['fel namn', 'Enkät om fikat'],
    ['fel skiftläge', 'bokning av mötesrum'],
    ['nästan rätt', 'Bokning av mötesrummet'],
    ['rätt namn med mellanslag runt', ' Bokning av mötesrum '],
    ['tomt', ''],
  ])('%s räcker inte — knappen är fortfarande stängd', (_case, confirmText) => {
    expect(renderPanel({ confirmText })).toMatch(/<button[^>]*disabled[^>]*>Avveckla/);
  });

  it('knappen öppnas när namnet står ordagrant', () => {
    const html = renderPanel({ confirmText: APP_NAME });
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Avveckla/);
    expect(buttons(html)).toContain(DECOMMISSION_BUTTON);
  });

  it('rutan säger vad som ska skrivas, och hör ihop med sitt fält', () => {
    const html = renderPanel();
    expect(html).toContain(DECOMMISSION_CONFIRM_LABEL);
    expect(html).toContain(decommissionConfirmHint(APP_NAME));
    const field = /<input[^>]*>/.exec(html)?.[0] ?? '';
    const labelFor = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    expect(field).toContain(`id="${labelFor}"`);
    expect(field, 'hjälptexten ska läsas upp med fältet').toMatch(/aria-describedby=/);
  });

  it('medan något skickas går varken knappen eller rutan att röra', () => {
    const exporting = renderPanel({ exporting: true });
    expect(buttons(exporting)).toContain(EXPORT_BUSY);
    expect(exporting).toMatch(/<button[^>]*disabled/);

    const going = renderPanel({ confirmText: APP_NAME, decommissioning: true });
    expect(buttons(going)).toContain(DECOMMISSION_BUSY);
    expect(going).toMatch(/<input[^>]*disabled/);
  });

  it('en installation utan appdata säger det, i stället för att knappen tiger', () => {
    const message = 'Export och avveckling är inte inkopplade i den här installationen.';
    const html = renderPanel({ exportError: message, error: message });
    expect(html).toContain(message);
    expect(html).toMatch(/status-error/);
    expect(html).toMatch(/aria-live="polite"/);
    // Och bara felet: rutan påstår inte samtidigt att något är avvecklat.
    expect(html).not.toContain(DECOMMISSION_DONE_HEADING);
  });
});

/**
 * Beskedet efteråt. Appen finns inte längre, så det finns ingenting att stanna kvar på — och
 * siffrorna står med, eftersom "appen är borta" annars är ett påstående ägaren inte kan pröva.
 */
describe('beskedet när appen är avvecklad', () => {
  const EVIDENCE: DecommissionEvidence = {
    appIdPrefix: '01jabcde',
    decommissionedAt: '2026-09-22T08:30:00Z',
    documentsDeleted: 148,
    filesDeleted: 3,
  };

  function renderDone(evidence: DecommissionEvidence = EVIDENCE): string {
    return renderToStaticMarkup(createElement(DecommissionDone, { evidence }));
  }

  it('säger att det är gjort, vad som raderades och vad som står kvar', () => {
    const html = renderDone();
    expect(html).toContain(DECOMMISSION_DONE_HEADING);
    expect(html).toContain(DECOMMISSION_DONE_BODY);
    expect(html).toContain(decommissionEvidenceText(148, 3));
    expect(html, 'beskedet ska läsas upp').toMatch(/role="status"/);
  });

  it('leder tillbaka till listan — appen finns inte kvar att stanna på', () => {
    const html = renderDone();
    expect(html).toContain(DECOMMISSION_DONE_LINK);
    expect(html).toMatch(/href="#\/"/);
    // Ingen väg tillbaka in i appen: den finns inte.
    expect(html).not.toContain('#/app/');
  });

  it('påstår ingenting om vad som fanns när det inte fanns något', () => {
    expect(renderDone({ ...EVIDENCE, documentsDeleted: 0, filesDeleted: 0 })).toContain(
      decommissionEvidenceText(0, 0),
    );
  });
});

/**
 * Filen som erbjuds. Ren funktion, så att det som faktiskt hamnar på ägarens disk går att pröva
 * utan webbläsare: namnet, typen och innehållet.
 */
describe('exporten som en fil', () => {
  const DATA = {
    format: 1,
    exportedAt: '2026-09-22T08:00:00Z',
    app: { name: 'Bokning av mötesrum', classification: 'personuppgift', classificationSource: 'signalord', published: true },
    collections: { bokningar: { documents: [{ id: 'r1', rum: 'Stora salen' }], truncated: false } },
    files: [{ id: 'f1', name: 'dagordning.pdf', size: 1024 }],
    conversation: [{ role: 'user', text: 'En lista där vi bokar mötesrum', createdAt: '2026-09-18T08:00:00Z' }],
  } as unknown as AppExport;

  it('får appens namn och datumet i filnamnet', () => {
    const file = exportFile('Bokning av mötesrum', DATA, new Date('2026-09-22T08:00:00Z'));
    expect(file.name).toBe(exportFileName('Bokning av mötesrum', new Date('2026-09-22T08:00:00Z')));
    expect(file.name).toContain('Bokning');
    expect(file.name).toContain('2026-09-22');
    expect(file.type).toBe('application/json');
  });

  it('innehåller allt appen bar, och går att läsa tillbaka', () => {
    const file = exportFile('Bokning av mötesrum', DATA, new Date('2026-09-22T08:00:00Z'));
    expect(JSON.parse(file.contents)).toEqual(DATA);
    // Samtalet hör till handlingen: det visar VARFÖR appen ser ut som den gör.
    expect(file.contents).toContain('En lista där vi bokar mötesrum');
    // Med indrag: den som öppnar filen för att se efter ska inte mötas av en enda oändlig rad.
    expect(file.contents.split('\n').length).toBeGreaterThan(5);
  });
});
