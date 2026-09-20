/**
 * Guiden "Vilka tjänster finns som appen kan använda?" — innehållet som data.
 *
 * Scenarierna (givet/när/så) står i testnamnen. Det som låses:
 *   - bara påslagna tjänster visas, och bara om det de bygger på också är påslaget
 *   - grundförmågorna visas alltid
 *   - varje tjänst i APP_SERVICE_NAMES har en beskrivning, så att en ny tjänst inte glöms
 *   - texterna är klarspråk utan tekniska ord, och säger det som faktiskt gäller
 */
import { describe, expect, it } from 'vitest';
import { APP_SERVICE_NAMES, type AppServiceName } from '@vibesandbox/contracts';
import {
  BASE_CAPABILITIES,
  GUIDE_LINK_SHORT,
  GUIDE_TITLE,
  SERVICE_CAPABILITIES,
  allGuideTexts,
  guideFor,
  type Capability,
} from '../src/formagor.ts';

const titles = (list: readonly Capability[]): string[] => list.map((capability) => capability.title);
const serviceTitle = (name: AppServiceName): string => SERVICE_CAPABILITIES[name].title;

describe('guidens namn', () => {
  it('rubriken är den fulla frågan, och den korta länktexten finns för trånga ställen', () => {
    expect(GUIDE_TITLE).toBe('Vilka tjänster finns som appen kan använda?');
    expect(GUIDE_LINK_SHORT).toBe('Tjänster för appar');
  });
});

describe('bara påslagna tjänster visas', () => {
  it('givet att inga tjänster är påslagna, så visar guiden bara grundförmågorna', () => {
    const guide = guideFor([]);
    expect(guide.services).toEqual([]);
    expect(titles(guide.base)).toEqual(titles(BASE_CAPABILITIES));
  });

  it('givet filer och AI-text påslagna, så visas de två och inga andra', () => {
    const guide = guideFor(['files', 'llm']);
    expect(titles(guide.services)).toEqual([serviceTitle('files'), serviceTitle('llm')]);
  });

  it('givet alla tjänster påslagna, så visas alla, i plattformens ordning', () => {
    const guide = guideFor([...APP_SERVICE_NAMES].reverse());
    expect(titles(guide.services)).toEqual(APP_SERVICE_NAMES.map(serviceTitle));
  });

  it('dubbletter och okända namn (en nyare server) ger ingen extra eller tom rubrik', () => {
    const guide = guideFor(['files', 'files', 'kaffebryggare']);
    expect(titles(guide.services)).toEqual([serviceTitle('files')]);
  });

  it('givet läsa text i bilder men inte filer, så visas den inte — den bygger på uppladdade filer', () => {
    expect(titles(guideFor(['ocr']).services)).toEqual([]);
    expect(titles(guideFor(['ocr', 'files']).services)).toContain(serviceTitle('ocr'));
  });

  it('givet tal till text men inte filer, så visas den inte', () => {
    expect(titles(guideFor(['transcribe']).services)).toEqual([]);
    expect(titles(guideFor(['transcribe', 'files']).services)).toContain(serviceTitle('transcribe'));
  });

  it('givet påminnelser men inte mejl, så visas de inte — påminnelser skickas som mejl', () => {
    expect(titles(guideFor(['schedule']).services)).toEqual([]);
    expect(titles(guideFor(['schedule', 'notify']).services)).toContain(serviceTitle('schedule'));
  });
});

describe('grundförmågorna visas alltid', () => {
  it('oavsett vilka tjänster som är påslagna', () => {
    for (const services of [[], ['files'], [...APP_SERVICE_NAMES]]) {
      expect(titles(guideFor(services).base)).toEqual(titles(BASE_CAPABILITIES));
    }
  });

  it('täcker gemensamma uppgifter, egna uppgifter, vem som är inloggad, delning och publicering', () => {
    const all = BASE_CAPABILITIES.map((capability) =>
      [capability.title, capability.about, capability.howTo ?? '', ...capability.goodToKnow].join(' '),
    ).join('\n');
    expect(all).toMatch(/alla som/i);
    expect(all).toMatch(/bara .*ser/i);
    expect(all).toMatch(/inloggad/i);
    expect(all).toMatch(/[Dd]ela/);
    expect(all).toMatch(/ta bort/i);
    expect(all).toMatch(/[Ff]örhandsvisning/);
    expect(all).toMatch(/[Pp]ublicera/);
  });
});

describe('varje förmåga är komplett', () => {
  it('varje tjänst i APP_SERVICE_NAMES har en beskrivning — en ny tjänst kan inte glömmas', () => {
    expect(Object.keys(SERVICE_CAPABILITIES).sort()).toEqual([...APP_SERVICE_NAMES].sort());
  });

  const every: Array<[string, Capability]> = [
    ...BASE_CAPABILITIES.map((capability): [string, Capability] => [capability.title, capability]),
    ...APP_SERVICE_NAMES.map((name): [string, Capability] => [name, SERVICE_CAPABILITIES[name]]),
  ];

  it.each(every)('%s: rubrik, 1–3 meningar, exempel eller instruktion, och "Bra att veta"', (_name, capability) => {
    expect(capability.title.trim()).not.toBe('');
    const sentences = capability.about.split(/(?<=[.!?])\s+/).filter((part) => part.trim() !== '');
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.length).toBeLessThanOrEqual(3);
    if (capability.examples.length === 0) {
      expect(capability.howTo?.trim() ?? '').not.toBe('');
    } else {
      expect(capability.examples.length).toBeGreaterThanOrEqual(2);
      expect(capability.examples.length).toBeLessThanOrEqual(3);
    }
    expect(capability.goodToKnow.length).toBeGreaterThanOrEqual(1);
  });

  it('varje tjänst har exempelmeningar att skriva i chatten', () => {
    for (const name of APP_SERVICE_NAMES) expect(SERVICE_CAPABILITIES[name].examples.length).toBeGreaterThanOrEqual(2);
  });

  it('rubrikerna är unika', () => {
    const all = [...titles(BASE_CAPABILITIES), ...APP_SERVICE_NAMES.map(serviceTitle)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('klarspråk', () => {
  const texts = allGuideTexts();

  it('texterna finns', () => {
    expect(texts.length).toBeGreaterThan(50);
  });

  // Ord som den som inte är utvecklare inte ska behöva kunna. Hela ord, oavsett skiftläge.
  const FORBIDDEN = [
    'API',
    'endpoint',
    'JSON',
    'SDK',
    'token',
    'tokens',
    'kollektion',
    'kollektioner',
    'kollektionen',
    'dokument',
    'dokumentet',
    'databas',
    'databasen',
    'backend',
    'frontend',
    'server',
    'servern',
    'HTTP',
    'URL',
    'id',
    'userId',
    'LLM',
    'OCR',
    'vektor',
    'vektorer',
    'kvot',
    'kvoten',
    'cursor',
    'fetch',
    'localStorage',
    'SdkError',
    ...APP_SERVICE_NAMES,
  ];

  it.each(FORBIDDEN)('innehåller inte ordet "%s"', (word) => {
    const pattern = new RegExp(`(?<![\\p{L}\\d])${word}(?![\\p{L}\\d])`, 'iu');
    expect(texts.filter((text) => pattern.test(text))).toEqual([]);
  });

  it('har inga kodtecken', () => {
    expect(texts.filter((text) => /[{}<>`=_]|=>|\(\)/.test(text))).toEqual([]);
  });

  it('har korta meningar: högst 25 ord', () => {
    const long: string[] = [];
    for (const text of texts) {
      for (const sentence of text.split(/(?<=[.!?:])\s+/)) {
        if (sentence.split(/\s+/).filter(Boolean).length > 25) long.push(sentence);
      }
    }
    expect(long).toEqual([]);
  });

  it('skriver å, ä och ö — inte a och o i stället', () => {
    const asciiWords = /(?<![\p{L}])(ar|nar|pa|fran|aven|maste|ocksa|forsta|pamin\p{L}*|anvand\p{L}*|forhands\p{L}*)(?![\p{L}])/iu;
    expect(texts.filter((text) => asciiWords.test(text))).toEqual([]);
  });
});

describe('texterna säger det som gäller', () => {
  const about = (name: AppServiceName): string => {
    const capability = SERVICE_CAPABILITIES[name];
    return [capability.title, capability.about, capability.howTo ?? '', ...capability.examples, ...capability.goodToKnow].join('\n');
  };

  it('roller styr vad som visas men skyddar inte uppgifter', () => {
    expect(about('roles')).toMatch(/styr vad appen visar/);
    expect(about('roles')).toMatch(/skyddar inte/);
  });

  it('mejl går bara till dem appen är delad med, och i förhandsvisningen bara till dig själv', () => {
    expect(about('notify')).toMatch(/bara till dem som appen är delad med/);
    expect(about('notify')).toMatch(/[Ii] förhandsvisningen går mejlet bara till dig själv/);
    expect(about('schedule')).toMatch(/[Ii] förhandsvisningen går påminnelserna bara till dig själv/);
  });

  it('påminnelser går även när ingen har appen öppen', () => {
    expect(about('schedule')).toMatch(/även när ingen har appen öppen/);
  });

  it('text från AI ska märkas och granskas, och namn tas inte bort', () => {
    expect(about('llm')).toMatch(/granska/i);
    expect(about('llm')).toMatch(/[Nn]amn och adresser tas inte bort/);
    expect(about('llm')).toMatch(/personnummer/i);
  });

  it('den som spelas in ska få veta det innan inspelningen börjar', () => {
    expect(about('transcribe')).toMatch(/[Bb]erätta för alla som hörs/);
    expect(about('transcribe')).toMatch(/innan/);
  });

  it('bilder och ljud kan inte maskas, och skickas till en svensk leverantör', () => {
    expect(about('ocr')).toMatch(/svensk leverantör/);
    expect(about('ocr')).toMatch(/känsliga personuppgifter/);
    expect(about('transcribe')).toMatch(/svensk leverantör/);
  });

  it('påstår inte mer än plattformen gör', () => {
    const all = allGuideTexts().join('\n');
    expect(all).not.toMatch(/helt säker|100 ?%|garanter|alltid rätt|anonymiser/i);
    expect(all).not.toMatch(/sms/i);
  });
});

describe('det här kan appar inte göra', () => {
  it('nämner internet, andra webbplatser och mejl till valfria adresser', () => {
    const limits = guideFor([]).limits.join('\n');
    expect(limits).toMatch(/andra webbplatser/);
    expect(limits).toMatch(/internet/);
    expect(limits).toMatch(/mejl till vilka adresser som helst/);
  });

  it('givet att påminnelser är påslagna, så nämns de som undantaget när ingen har appen öppen', () => {
    const without = guideFor([]).limits.join('\n');
    const withReminders = guideFor(['notify', 'schedule']).limits.join('\n');
    expect(without).toMatch(/när ingen har appen öppen/);
    expect(without).not.toMatch(/påminnelser/);
    expect(withReminders).toMatch(/när ingen har appen öppen/);
    expect(withReminders).toMatch(/påminnelser/);
  });
});
