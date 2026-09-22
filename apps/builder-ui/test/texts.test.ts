/**
 * Påståendena i "Trygghet och kontroll" måste vara sanna. Testet låser vad som sägs och
 * fäller på sådant plattformen INTE gör (att namn tas bort, att något är garanterat).
 *
 * Mänsklig granskning stod länge i den listan. Den gör det inte längre: sedan granskningen
 * byggdes läser en förvaltare koden innan en app går ut, och punkten om vem som ser appen är
 * ändrad därefter. Ett löfte som blivit sant ska sägas, inte förtigas.
 */
import { describe, expect, it } from 'vitest';
import { REVIEW_STATES } from '@vibesandbox/contracts';
import {
  PUBLISH_REQUEST_AGAIN_BUTTON,
  PUBLISH_REQUEST_BUTTON,
  PUBLISH_REQUEST_HINT,
  REVIEW_OWNER_TEXTS,
  REVIEW_REASON_LEAD,
  SAFETY_POINTS,
  SUGGESTIONS,
  reviewOwnerText,
} from '../src/texts.ts';

const all = SAFETY_POINTS.join('\n');

describe('Trygghet och kontroll', () => {
  it('säger det som gäller', () => {
    expect(all).toMatch(/plattformens egen server/);
    expect(all).toMatch(/kan inte skicka uppgifter vidare till andra adresser på internet/);
    expect(all).toMatch(/AI-modell hos en svensk leverantör/);
    expect(all).toMatch(/[Pp]ersonnummer, telefonnummer, e-postadresser, kortnummer och IBAN/);
    expect(all).toMatch(/[Nn]amn tas inte bort/);
    expect(all).toMatch(/skriv inte in personuppgifter/i);
    expect(all).toMatch(/kontrolleras automatiskt innan den byggs/);
    expect(all).toMatch(/egen lagring som andra appar inte kommer åt/);
    expect(all).toMatch(/[Bb]ara du ser din app medan du bygger den/);
    expect(all).toMatch(/de du delar den med, efter att de loggat in/);
  });

  // Appen är bara din, men återkopplingen på byggverktyget är det inte: säger du att
  // byggverktyget inte hjälpte mejlas hela konversationen vidare. Står det inte här blir
  // punkten ovan om att "bara du ser din app" missvisande.
  it('säger vad som händer när man lämnar återkoppling på byggverktyget', () => {
    expect(all).toMatch(/[Bb]yggverktyget inte hjälpte/);
    expect(all).toMatch(/hela er konversation om appen/);
    expect(all).toMatch(/till den som driver plattformen/);
    expect(all).toMatch(/[Tt]ummen upp räknas bara/);
  });

  /**
   * Den här skivan gör ett av påståendena sant: ett önskemål prövas mot de röda linjerna innan
   * språkmodellen får skriva en rad kod, och en träff betyder att jobbet aldrig startar.
   *
   * Prövningen är mönsterbaserad. Den får därför inte läsas som ett löfte om att allt fångas —
   * står inte förbehållet kvar är punkten inte längre sann.
   */
  it('säger att förbjuden användning stoppas innan något byggs', () => {
    expect(all).toMatch(/förbjud/i);
    expect(all).toMatch(/stoppas/);
    expect(all).toMatch(/innan någon kod skrivs/);
    expect(all).toMatch(/fångar inte allt/);
  });

  /**
   * Den här skivan gör ett påstående till: appen får en känslighetsnivå, och nivån sätts ÅT den
   * som bygger. Det är den bärande regeln — den som bygger ska inte kunna välja bort sitt eget
   * skydd — och den syns i AI-registret i kontrollrummet.
   *
   * Förbehållet är inte en artighet. Nivån sätts utifrån det önskemålet BESKRIVER, inte utifrån
   * vad appen sedan matas med. Står inte den sista meningen kvar lovar punkten mer än plattformen
   * kan hålla, precis som punkten om de röda linjerna utan sitt "fångar inte allt".
   */
  it('säger att appen klassas åt en, och att fel faller åt det försiktiga hållet', () => {
    expect(all).toMatch(/klass/i);
    expect(all).toMatch(/hur känsliga uppgifter den ska hantera/);
    expect(all).toMatch(/[Kk]lassen sätts åt dig/);
    expect(all).toMatch(/väljer den aldrig själv/);
    expect(all).toMatch(/höjer den/);
    expect(all).toMatch(/behandlas appen som den känsligaste/);
    expect(all).toMatch(/inte av det appen sedan används till/);
  });

  /**
   * Den bärande ändringen i publiceringen: hon publicerar inte längre själv. Står det inte här
   * tror hon att appen går ut i samma ögonblick som hon trycker — och att ingen annan sett den.
   */
  it('säger att en förvaltare läser koden innan appen går ut', () => {
    expect(all).toMatch(/begär/);
    expect(all).toMatch(/läser/);
    expect(all).toMatch(/innan appen går ut/);
  });

  it('påstår inte mer än så', () => {
    expect(all).not.toMatch(/namn tas bort|anonymiser/i);
    expect(all).not.toMatch(/helt säker|100 ?%|garanter/i);
    // Granskningen läser koden. Den lovar inte att den hittar allt — ingen sådan mening här.
    expect(all).not.toMatch(/fångar allt|hittar allt|alltid säker/i);
  });
});

describe('förslagen', () => {
  it('finns och innehåller todo-listan', () => {
    expect(SUGGESTIONS).toContain('En todo-lista för vårt team');
    expect(SUGGESTIONS.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * Ägarens fyra lägen efter att hon begärt publicering.
 *
 * Texterna är det enda hon har att gå på medan hon väntar, och `tillbakadragen` är den som måste
 * sitta: ingen har sagt nej där, ingen hann ens läsa. Läser hon det som ett underkännande tror
 * hon att appen är fel, när det enda som hänt är att hon byggde om medan ärendet låg i kö.
 */
describe('ägarens lägen för en begärd publicering', () => {
  it('täcker alla lägen kontraktet har, och inga fler', () => {
    expect(Object.keys(REVIEW_OWNER_TEXTS).sort()).toEqual([...REVIEW_STATES].sort());
  });

  it('väntar: inget hon behöver göra, och ingen antydan om att hon missat ett steg', () => {
    const text = reviewOwnerText('vantar');
    expect(text.body).toMatch(/behöver inte göra något/);
    expect(text.body).toMatch(/läser koden/);
    expect(`${text.heading} ${text.body}`).not.toMatch(/fel|misslyck|tyvärr/i);
  });

  it('godkänd: appen är läst och ute, och nästa steg är att dela den', () => {
    const text = reviewOwnerText('godkand');
    expect(text.heading).toMatch(/[Pp]ublicerad/);
    expect(text.body).toMatch(/dela/);
  });

  it('avvisad: något ska ändras, och vägen vidare står där — inte bara ett nej', () => {
    const text = reviewOwnerText('avvisad');
    expect(text.body).toMatch(/[Ää]ndra/);
    expect(text.body).toMatch(/begär publicering igen/);
    expect(text.body, 'appen är inte borta').toMatch(/finns kvar/);
  });

  it('tillbakadragen läses inte som ett avslag: ingen sa nej, ingen hann läsa', () => {
    const text = reviewOwnerText('tillbakadragen');
    expect(text.body, 'skillnaden mot ett nej måste stå med ord').toMatch(/[Ii]ngen har alltså sagt nej/);
    expect(text.body).toMatch(/ingen hann läsa|hann läsa/);
    expect(text.body).toMatch(/byggde om/);
    expect(text.body).toMatch(/begär publicering igen/);
    // Inget i läget är ett fel, och inget av orden för avslag hör hemma här.
    expect(`${text.heading} ${text.body}`).not.toMatch(/avvisad|underkänd|nekad|fel|tyvärr/i);
  });

  it('inget av lägena skriver maskintext eller skyller på ägaren', () => {
    for (const state of REVIEW_STATES) {
      const text = reviewOwnerText(state);
      expect(`${text.heading} ${text.body}`).not.toContain(state);
      expect(text.heading.length).toBeGreaterThan(3);
      expect(text.body).not.toMatch(/\b(?:API|status|JSON|HTTP)\b/i);
    }
  });

  it('ett läge vi inte känner igen hittar inte på ett besked — det läses som väntande', () => {
    for (const odd of ['klar', '', 'GODKAND', 'toString', '__proto__']) {
      expect(reviewOwnerText(odd)).toBe(REVIEW_OWNER_TEXTS.vantar);
    }
  });

  it('knappen begär publicering, den publicerar inte', () => {
    expect(PUBLISH_REQUEST_BUTTON).toMatch(/[Bb]egär/);
    expect(PUBLISH_REQUEST_AGAIN_BUTTON).toMatch(/[Bb]egär/);
    expect(PUBLISH_REQUEST_HINT, 'säg vad som händer innan hon trycker').toMatch(/läser en människa koden/);
    expect(REVIEW_REASON_LEAD, 'det ska synas vems orden är').toMatch(/den som läste koden/);
  });
});
