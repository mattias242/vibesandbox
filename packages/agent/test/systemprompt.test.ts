import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, SYSTEM_PROMPT_VERSION } from '../src/index.ts';
import { KNOWLEDGE } from './stod.ts';

const prompt = buildSystemPrompt(KNOWLEDGE);

describe('systemprompten', () => {
  it('har en version', () => {
    expect(SYSTEM_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('innehåller SDK-referensen ordagrant', () => {
    expect(prompt).toContain(KNOWLEDGE.sdkReference);
  });

  it('visar exempelappen i protokollets format, som ett fullständigt svar', () => {
    expect(prompt).toContain(`<vs-file path="src/App.tsx">\n${KNOWLEDGE.exampleFiles['src/App.tsx']}\n</vs-file>`);
    expect(prompt).toContain(`<vs-file path="src/styles.css">\n${KNOWLEDGE.exampleFiles['src/styles.css']}\n</vs-file>`);
    expect(prompt).toContain('<vs-done/>');
  });

  it.each([
    ['React och TypeScript', /React.*TypeScript/],
    ['tillåtna importer', /`react`.*`react-dom`.*`@vibesandbox\/sdk`/s],
    ['förbjudna nätverks-API:er', /fetch.*XMLHttpRequest.*WebSocket.*EventSource/s],
    ['window.open och eval', /window\.open.*eval/s],
    ['lagring i webbläsaren', /localStorage.*sessionStorage.*cookies/s],
    ['service workers', /service workers/i],
    ['data bara via SDK:t', /ENBART via SDK/],
    ['kollektionsnamn utan å/ä/ö', /å, ä eller ö/],
    ['personliga kollektioner', /personal: true/],
    ['svensk text', /svenska/],
    ['etiketter', /etikett/],
    ['stil i styles.css', /src\/styles\.css/],
    ['inte inline-stil', /style=/],
    ['aldrig main.tsx', /src\/main\.tsx/],
    ['entrypoint', /export function App\(\)/],
    ['laddning och fel', /laddar|laddning/i],
    ['hela filer', /HELA/],
    ['utelämningar', /\/\/ \.\.\./],
    ['slutmarkör', /<vs-done\/>/],
  ])('har regeln om %s', (_namn, pattern) => {
    expect(prompt).toMatch(pattern);
  });

  it('är på svenska och nämner inga riktiga domäner', () => {
    expect(prompt).toMatch(/Du skriver/);
    expect(prompt).not.toMatch(/https?:\/\//);
  });
});
