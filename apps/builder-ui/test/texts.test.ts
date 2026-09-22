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
  DECOMMISSION_BUTTON,
  DECOMMISSION_DONE_BODY,
  DECOMMISSION_LEAD,
  DECOMMISSION_REMAINS,
  DECOMMISSION_WARNING,
  EXPORT_BUTTON,
  EXPORT_WHY,
  PUBLISH_REQUEST_AGAIN_BUTTON,
  PUBLISH_REQUEST_BUTTON,
  PUBLISH_REQUEST_HINT,
  REVIEW_OWNER_TEXTS,
  REVIEW_REASON_LEAD,
  SAFETY_POINTS,
  SUGGESTIONS,
  decommissionConfirmHint,
  decommissionEvidenceText,
  exportFileName,
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


/**
 * Avvecklingens texter. Det här är den enda ytan i byggverktyget där ingenting går att ångra, och
 * det som låses här är att ägaren får veta TRE saker innan hon trycker — att det inte går att
 * ångra, exakt vad som raderas, och exakt vad som blir kvar.
 *
 * Den tredje är den som är lätt att tappa. Registerposten står kvar med flit, och läser ägaren
 * "appen tas bort" och sedan upptäcker att den står kvar i ett register har plattformen sagt
 * något osant till henne. Det är värre än att texten blev lite längre.
 */
describe('avvecklingens texter', () => {
  it('säger att det inte går att ångra, utan att skrika', () => {
    expect(DECOMMISSION_WARNING).toMatch(/går inte att ångra/);
    // Ingen skrämsel: inga versaler, inga utropstecken. Allvaret ligger i vad som står, inte i hur.
    expect(DECOMMISSION_WARNING).not.toMatch(/!/);
    expect(`${DECOMMISSION_WARNING}\n${DECOMMISSION_LEAD}\n${DECOMMISSION_REMAINS}`).not.toMatch(/\b[A-ZÅÄÖ]{3,}\b/);
  });

  it('räknar upp exakt vad som raderas — inte bara "appen tas bort"', () => {
    expect(DECOMMISSION_WARNING, 'uppgifterna i appen').toMatch(/uppgifter/i);
    expect(DECOMMISSION_WARNING, 'filerna').toMatch(/filer/i);
    expect(DECOMMISSION_WARNING, 'koden').toMatch(/kod/i);
    expect(DECOMMISSION_WARNING, 'samtalet hör till appen och följer med').toMatch(/samtalet/i);
  });

  it('säger vad som blir kvar, och att det är med flit', () => {
    expect(DECOMMISSION_REMAINS).toMatch(/står kvar|finns kvar/);
    expect(DECOMMISSION_REMAINS, 'det är registret posten står kvar i').toMatch(/register/i);
    expect(DECOMMISSION_REMAINS, 'inte något plattformen glömt').toMatch(/med flit|avsiktligt/);
    // Och att det som står kvar är SPÅRET, inte uppgifterna. Annars läses meningen tvärtom.
    expect(DECOMMISSION_REMAINS).toMatch(/[Uu]ppgifterna i appen finns inte kvar/);
  });

  it('erbjuder exporten som en väg ut, och säger varför den finns', () => {
    expect(EXPORT_WHY, 'skälet är att det kan vara allmän handling').toMatch(/allmän handling/);
    expect(EXPORT_WHY, 'plattformen VET inte, och ska inte låtsas veta').toMatch(/kan inte avgöra/);
    expect(EXPORT_WHY).toMatch(/alltid finnas en väg ut/);
    // Och vad filen innehåller, så att hon vet om den räcker.
    expect(EXPORT_WHY).toMatch(/samtalet/i);
  });

  it('knapparna säger vad de gör, inte "ta bort" som om det vore att stänga en flik', () => {
    expect(EXPORT_BUTTON).toBe('Ladda ner appens innehåll');
    expect(DECOMMISSION_BUTTON).toMatch(/[Aa]vveckla/);
    expect(DECOMMISSION_BUTTON, 'det är för alltid, och det ska stå på knappen').toMatch(/för alltid/);
  });

  it('bekräftelsen ber om appens namn ordagrant, med skiftläget utskrivet', () => {
    const hint = decommissionConfirmHint('Bokning av mötesrum');
    expect(hint).toContain('Bokning av mötesrum');
    expect(hint).toMatch(/precis som det står/);
    expect(hint, 'fel skiftläge räcker inte, och det ska sägas').toMatch(/stora och små bokstäver/);
  });

  it('beskedet efteråt säger samma två saker som varningen gjorde', () => {
    expect(DECOMMISSION_DONE_BODY).toMatch(/raderade/);
    expect(DECOMMISSION_DONE_BODY).toMatch(/register/i);
  });
});

describe('gallringsbeviset i ord', () => {
  it('räknar i klarspråk, med mellanrum i stora tal', () => {
    expect(decommissionEvidenceText(1240, 3)).toContain('3 filer');
    expect(decommissionEvidenceText(1240, 3)).toMatch(/1\s240/);
    expect(decommissionEvidenceText(1240, 3)).toMatch(/raderades/);
  });

  it('böjer entalet — "1 filer" läser som ett fel i räkningen', () => {
    const one = decommissionEvidenceText(1, 1);
    expect(one).toContain('1 sparad uppgift');
    expect(one).toContain('1 fil ');
    expect(one).not.toContain('1 filer');
  });

  it('en tom app får en nolla, inte en tystnad', () => {
    expect(decommissionEvidenceText(0, 0)).toMatch(/0 sparade uppgifter och 0 filer/);
  });
});

describe('filen ägaren får', () => {
  const AT = new Date('2026-09-22T08:00:00Z');

  it('bär appens namn och datumet — annars går två exporter inte att skilja åt', () => {
    expect(exportFileName('Bokning av mötesrum', AT)).toBe('Bokning-av-mötesrum-2026-09-22.json');
  });

  it('behåller svenska bokstäver — "Anmälan" ska inte bli "Anm-lan"', () => {
    expect(exportFileName('Anmälan till städdagen', AT)).toBe('Anmälan-till-städdagen-2026-09-22.json');
  });

  it('tecken som inte hör hemma i ett filnamn blir bindestreck, aldrig sökvägar', () => {
    const name = exportFileName('../etc/passwd: "allt"', AT);
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).not.toContain('"');
    expect(name).toBe('etc-passwd-allt-2026-09-22.json');
  });

  it('ett namn utan en enda bokstav ger ändå ett filnamn som går att spara', () => {
    expect(exportFileName('###', AT)).toBe('app-2026-09-22.json');
    expect(exportFileName('', AT)).toBe('app-2026-09-22.json');
  });

  it('ett orimligt långt namn kapas, så att filen går att spara på riktiga filsystem', () => {
    const name = exportFileName('å'.repeat(400), AT);
    expect(name.length).toBeLessThan(90);
    expect(name).toMatch(/\.json$/);
  });
});
