/**
 * classify: modellens svar tolkas mot det golv önskemålets egna ord sätter.
 *
 * Riktningen på tveksamheten är den OMVÄNDA mot röda linjer. En för sträng klass kostar nästan
 * ingenting — appen byggs ändå. En för MILD klass betyder att uppgifter om enskilda hanteras som
 * om de vore offentliga. Därför prövar testerna framför allt att det aldrig går att komma UNDER
 * golvet, och att allt som inte går att tolka landar på den strängaste klassen.
 *
 * Samtidigt får golvet inte trigga på vad som helst: en mötesrumsbokning ska inte hamna i
 * registret som en app med personuppgifter bara för att den nämner ett rum och en tid.
 */
import { describe, expect, it } from 'vitest';
import { CLASSIFICATIONS, CLASSIFICATION_SOURCES } from '@vibesandbox/contracts';
import { classify, CLASSIFICATION_LIMITS, signalFloor } from '../src/index.ts';

/** Ett önskemål utan ett enda signalord. Används när bara modellens svar ska prövas. */
const NEUTRAL = 'En todo-lista där arbetsgruppen kan bocka av uppgifter.';

describe('modellens svar tolkas', () => {
  it.each(CLASSIFICATIONS)('läser %s ur ett rent svar', (classification) => {
    expect(classify({ request: NEUTRAL, answer: classification })).toEqual({
      classification,
      source: 'modell',
    });
  });

  it.each([
    'INTERN',
    'Intern',
    '  intern  ',
    '\n intern \n',
    'intern.',
    '"intern"',
    "'intern'",
    '**intern**',
    '`intern`',
  ])('bryr sig inte om formateringen %j', (answer) => {
    expect(classify({ request: NEUTRAL, answer })).toEqual({
      classification: 'intern',
      source: 'modell',
    });
  });

  it('svarar alltid med en klass och en källa ur kontraktet', () => {
    const answer = classify({ request: NEUTRAL, answer: 'intern' });
    expect(CLASSIFICATIONS).toContain(answer.classification);
    expect(CLASSIFICATION_SOURCES).toContain(answer.source);
  });
});

describe('ett svar som inte går att tolka blir den strängaste klassen', () => {
  it.each([
    ['inget svar alls', null],
    ['ett tomt svar', ''],
    ['bara blanktecken', '   \n\t '],
    ['bara skiljetecken', '"".'],
    ['två klassord', 'oppen kanslig'],
    ['två klassord med en reservation emellan', 'oppen, men hälsouppgifterna gör den kanslig'],
    ['en hel mening', 'Appen är intern eftersom den bara rör verksamheten.'],
    ['en mening som inleds med klassordet', 'Intern, eftersom inga personuppgifter förekommer.'],
    ['ett ord som inte är en klass', 'offentlig'],
    ['klassordet med svensk stavning', 'känslig'],
    ['ett resonemang utan klassord', 'Det beror på vilka uppgifter som samlas in.'],
  ])('faller till kanslig när svaret är %s', (_beskrivning, answer) => {
    expect(classify({ request: NEUTRAL, answer })).toEqual({
      classification: 'kanslig',
      source: 'fail-closed',
    });
  });
});

describe('signalord sätter ett golv', () => {
  it.each([
    ['personnummer i ett formulär', 'Ett formulär där den sökande fyller i sitt personnummer.'],
    ['diagnos', 'En översikt över vilken diagnos varje deltagare i gruppen har.'],
    ['sjukfrånvaro', 'En rapport över sjukfrånvaro per avdelning och månad.'],
    ['sjukskrivning', 'Ett stöd för att följa upp sjukskrivningar på enheten.'],
    ['journal', 'En läsvy över journalanteckningar från hemtjänsten.'],
    ['elevhälsa', 'En kö där elevhälsan ser vilka ärenden som väntar.'],
    ['LSS', 'En planering av insatser enligt LSS för varje person.'],
    ['socialtjänst', 'Ett stöd till socialtjänsten för att följa upp insatser.'],
    ['orosanmälan', 'En blankett för orosanmälan som går vidare till mottagningen.'],
    ['facklig tillhörighet', 'En lista över vilket fackförbund var och en tillhör.'],
    ['etnicitet', 'En uppföljning av etnicitet bland de sökande.'],
    ['religion', 'En anmälan om vilken religion måltiden ska anpassas efter.'],
    ['fingeravtryck', 'En lista över vilka fingeravtryck som är registrerade.'],
    ['brottsregister', 'En kontroll mot belastningsregistret inför anställning.'],
    ['missbruk', 'En uppföljning av behandling vid missbruk.'],
    ['skyddad identitet', 'En markering för den som har skyddad identitet.'],
  ])('kanslig: %s', (_beskrivning, request) => {
    expect(signalFloor(request)).toBe('kanslig');
  });

  it.each([
    ['e-postadress', 'Ett utskick till alla som anmält sin e-postadress.'],
    ['personuppgift', 'En vy över vilka personuppgifter som lagrats om varje ärende.'],
    ['medarbetare', 'En översikt över vilka medarbetare som är på plats i dag.'],
    ['anställd', 'En lista över anställda per enhet.'],
    ['elev', 'En närvarolista där läraren prickar av eleverna.'],
    ['invånare', 'En sida där invånarna kan felanmäla en gatlykta.'],
    ['brukare', 'En kö där brukarna ser sin plats i turordningen.'],
    ['vårdnadshavare', 'Ett meddelande till vårdnadshavarna inför utvecklingssamtalet.'],
    ['kund', 'Ett register över våra kunder och deras beställningar.'],
    ['namn och adress', 'Ett formulär där man fyller i namn och adress.'],
  ])('personuppgift: %s', (_beskrivning, request) => {
    expect(signalFloor(request)).toBe('personuppgift');
  });

  it.each([
    'Ett formulär där personnumret fylls i av handläggaren.',
    'En kontroll mot brottsregistret inför uppdraget.',
    'En läsvy över journalen för varje insats.',
    'En markering för elevhälsans pågående ärenden.',
  ])('läser den bestämda formen: %s', (request) => {
    // Svenskan böjer: `personnummer` blir `personnumret` och `register` blir `registret`. Ett
    // signalord som bara matchar grundformen missar hälften av hur folk faktiskt skriver.
    expect(signalFloor(request)).toBe('kanslig');
  });

  it('väljer det strängaste golvet när flera signalord finns', () => {
    expect(signalFloor('En kö där elevhälsan ser vilka elever som väntar.')).toBe('kanslig');
  });
});

describe('vanliga önskemål sätter inget golv', () => {
  it.each([
    'Bokning av mötesrum: visa lediga tider per rum och låt en kollega boka ett pass.',
    'En checklista inför uppstart av ett nytt projekt, med ansvarig person per rad.',
    'En enkät om vad deltagarna tycker om lunchmenyn i personalmatsalen.',
    'En todo-lista där arbetsgruppen kan bocka av uppgifter och se vad som är kvar.',
    'En protokollmall för nämndens möten, med närvarolista och beslutspunkter.',
    'En karta över var klotter har anmälts det senaste året.',
    'Vi brukar boka rummet på fredagar — visa vilka pass som är lediga.',
    'En timer som räknar ner sekunder och piper när tiden är slut.',
    'En presslista över vilka journalister som bevakar nämnden.',
    'En statistiksida över hur många ärenden som avslutats per vecka.',
  ])('inget golv för %s', (request) => {
    expect(signalFloor(request)).toBeNull();
  });

  it('låter modellen bestämma helt när inget signalord finns', () => {
    expect(classify({ request: 'Bokning av mötesrum per våningsplan.', answer: 'oppen' })).toEqual({
      classification: 'oppen',
      source: 'modell',
    });
  });
});

describe('golvet går aldrig att underskrida', () => {
  const HEALTH = 'En kö där elevhälsan ser vilka ärenden som väntar.';
  const PEOPLE = 'En närvarolista där läraren prickar av eleverna.';

  it.each(['oppen', 'intern', 'personuppgift'])('höjer ett för milt svar (%s) till golvet', (answer) => {
    expect(classify({ request: HEALTH, answer })).toEqual({
      classification: 'kanslig',
      source: 'signalord',
    });
  });

  it('säger signalord också när modellen råkade svara exakt golvet', () => {
    expect(classify({ request: PEOPLE, answer: 'personuppgift' })).toEqual({
      classification: 'personuppgift',
      source: 'signalord',
    });
  });

  it('låter modellen höja över golvet, och källan blir modell', () => {
    expect(classify({ request: PEOPLE, answer: 'kanslig' })).toEqual({
      classification: 'kanslig',
      source: 'modell',
    });
  });

  it('faller till kanslig och fail-closed när svaret är otolkbart, inte till golvet', () => {
    expect(classify({ request: PEOPLE, answer: null })).toEqual({
      classification: 'kanslig',
      source: 'fail-closed',
    });
    expect(classify({ request: PEOPLE, answer: 'personuppgift eller oppen' })).toEqual({
      classification: 'kanslig',
      source: 'fail-closed',
    });
  });
});

describe('samma indata ger samma svar', () => {
  const request = 'En kö där brukarna ser sin plats i turordningen.';

  it('svarar likadant varje gång', () => {
    const answers = new Set(
      [1, 2, 3].map(() => JSON.stringify(classify({ request, answer: 'oppen' }))),
    );
    expect(answers.size).toBe(1);
  });

  it('bryr sig inte om i vilken ordning signalorden står i texten', () => {
    const health = 'Elevhälsan ska se vilka ärenden som väntar.';
    const people = 'Vårdnadshavarna ska få ett meddelande.';
    expect(signalFloor(`${health} ${people}`)).toBe('kanslig');
    expect(signalFloor(`${people} ${health}`)).toBe('kanslig');
  });
});

describe('fientliga och trasiga indata', () => {
  it('klarar ett tomt önskemål', () => {
    expect(signalFloor('')).toBeNull();
    expect(classify({ request: '', answer: 'oppen' })).toEqual({
      classification: 'oppen',
      source: 'modell',
    });
  });

  it('låter sig inte luras av NUL och styrtecken mitt i signalordet', () => {
    expect(signalFloor('Ett formulär med person\u0000nummer.')).toBe('kanslig');
  });

  it('låter sig inte luras av osynliga tecken', () => {
    expect(signalFloor('Ett formulär med person​nummer.')).toBe('kanslig');
  });

  it('läser ett signalord som brutits över flera rader', () => {
    expect(signalFloor('Ett formulär\nmed personnummer\nför den sökande.')).toBe('kanslig');
  });

  it('bryr sig inte om skiftläge i önskemålet', () => {
    expect(signalFloor('ETT FORMULÄR MED PERSONNUMMER')).toBe('kanslig');
  });

  it('prövar bara de första CLASSIFICATION_LIMITS.maxCheckedChars tecknen — se filhuvudet', () => {
    const padding = 'En helt vanlig checklista för uppstart av projekt. '.repeat(1000);
    expect(padding.length).toBeGreaterThan(CLASSIFICATION_LIMITS.maxCheckedChars);
    expect(signalFloor(`Ett formulär med personnummer. ${padding}`)).toBe('kanslig');
    expect(signalFloor(`${padding} Ett formulär med personnummer.`)).toBeNull();
  });

  it('krånglar inte med en text på 1 MB', () => {
    const long = 'Vi vill bygga en todo-lista för arbetsgruppen. '.repeat(22_000);
    expect(long.length).toBeGreaterThan(1_000_000);
    const start = performance.now();
    expect(signalFloor(long)).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('tolkar inte ett enormt modellsvar som en klass', () => {
    expect(classify({ request: NEUTRAL, answer: `${'oppen '.repeat(100_000)}kanslig` })).toEqual({
      classification: 'kanslig',
      source: 'fail-closed',
    });
  });
});
