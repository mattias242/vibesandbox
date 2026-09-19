import { describe, expect, it } from 'vitest';
import { formatFiles, parseResponse, PROTOCOL_LIMITS } from '../src/protokoll.ts';

function block(path: string, content: string): string {
  return `<vs-file path="${path}">\n${content}\n</vs-file>`;
}

function ok(text: string) {
  const outcome = parseResponse(text);
  if (!outcome.ok) throw new Error(`förväntade ok, fick: ${outcome.problems.join(' | ')}`);
  return outcome;
}

function problems(text: string): string {
  const outcome = parseResponse(text);
  if (outcome.ok) throw new Error('förväntade tolkfel');
  return outcome.problems.join('\n');
}

const APP = "export function App() {\n  return <p>Hej</p>;\n}";

describe('parseResponse', () => {
  it('tolkar sammanfattning, filer och slutmarkör', () => {
    const outcome = ok(`Jag har gjort en lista.\n\n${block('src/App.tsx', APP)}\n${block('src/styles.css', 'p { color: red; }')}\n<vs-done/>\n`);
    expect(outcome.summary).toBe('Jag har gjort en lista.');
    expect(outcome.files).toEqual({ 'src/App.tsx': APP, 'src/styles.css': 'p { color: red; }' });
  });

  it('bevarar filinnehållet exakt, inklusive tomrader och indrag', () => {
    const content = '\n  const a = 1;\n\n\n  const b = 2;\n';
    const outcome = ok(`${block('src/a.ts', content)}\n<vs-done/>`);
    expect(outcome.files['src/a.ts']).toBe(content);
  });

  it('klarar CRLF', () => {
    const outcome = ok(`Klart.\r\n<vs-file path="src/a.ts">\r\nconst a = 1;\r\n</vs-file>\r\n<vs-done/>\r\n`);
    expect(outcome.files['src/a.ts']).toBe('const a = 1;');
  });

  it('tål blanksteg runt taggarna', () => {
    const outcome = ok(`  <vs-file path="src/a.ts">  \nconst a = 1;\n  </vs-file>\n  <vs-done/>  `);
    expect(outcome.files['src/a.ts']).toBe('const a = 1;');
  });

  it('räknar taggar bara när de står ensamma på en rad', () => {
    const content = "const s = '<vs-file path=\"src/x.ts\">';\nconst t = 'text </vs-file> mer';\n// <vs-done/> i en kommentar";
    const outcome = ok(`${block('src/a.ts', content)}\n<vs-done/>`);
    expect(outcome.files['src/a.ts']).toBe(content);
  });

  it('skalar bort ett kodstaket direkt innanför blocket', () => {
    const outcome = ok(`${block('src/App.tsx', '```tsx\n' + APP + '\n```')}\n<vs-done/>`);
    expect(outcome.files['src/App.tsx']).toBe(APP);
  });

  it('skalar bort ett kodstaket utan språk', () => {
    const outcome = ok(`${block('src/styles.css', '```\np {}\n```')}\n<vs-done/>`);
    expect(outcome.files['src/styles.css']).toBe('p {}');
  });

  it('tål ett kodstaket runt hela svaret', () => {
    const outcome = ok(`Klart.\n\`\`\`\n${block('src/a.ts', 'const a = 1;')}\n<vs-done/>\n\`\`\``);
    expect(outcome.files['src/a.ts']).toBe('const a = 1;');
  });

  it('kräver slutmarkören', () => {
    expect(problems(`Klart.\n${block('src/App.tsx', APP)}\n`)).toMatch(/<vs-done\/>/);
  });

  it('underkänner ett block som aldrig stängs', () => {
    expect(problems(`<vs-file path="src/App.tsx">\n${APP}\n<vs-done/>`)).toMatch(/stängs aldrig/);
  });

  it('underkänner ett nytt block innan det förra stängts', () => {
    expect(problems(`<vs-file path="src/a.ts">\nconst a = 1;\n${block('src/b.ts', 'const b = 2;')}\n<vs-done/>`)).toMatch(/stängs aldrig/);
  });

  it('underkänner en stängningstagg utan block', () => {
    expect(problems(`Klart.\n</vs-file>\n<vs-done/>`)).toMatch(/<\/vs-file>/);
  });

  it('underkänner dubbla sökvägar', () => {
    expect(problems(`${block('src/a.ts', 'const a = 1;')}\n${block('src/a.ts', 'const a = 2;')}\n<vs-done/>`)).toMatch(/src\/a\.ts.*två gånger/);
  });

  it.each(['src/main.tsx', 'src/tsconfig.json', '../x.ts', 'src/../x.ts', '/etc/passwd', 'src/.env.ts', 'src/Åtgärd.tsx', 'App.tsx', 'src/a.js'])(
    'underkänner otillåten sökväg %s',
    (path) => {
      expect(problems(`${block(path, 'x')}\n<vs-done/>`)).toContain(path);
    },
  );

  it('förklarar att src/main.tsx ägs av mallen', () => {
    expect(problems(`${block('src/main.tsx', 'x')}\n<vs-done/>`)).toMatch(/mallen/);
  });

  it('underkänner fler än 30 filer', () => {
    const files = Array.from({ length: PROTOCOL_LIMITS.maxFiles + 1 }, (_, i) => block(`src/f${i}.ts`, `export const a${i} = ${i};`));
    expect(problems(`${files.join('\n')}\n<vs-done/>`)).toMatch(/30/);
  });

  it('underkänner en för stor fil, räknat i bytes', () => {
    const big = 'å'.repeat(PROTOCOL_LIMITS.maxFileBytes / 2 + 1);
    expect(problems(`${block('src/a.ts', `const a = '${big}';`)}\n<vs-done/>`)).toMatch(/src\/a\.ts.*för stor/);
  });

  it('underkänner för mycket kod totalt', () => {
    const chunk = 'a'.repeat(PROTOCOL_LIMITS.maxFileBytes - 100);
    const files = Array.from({ length: 5 }, (_, i) => block(`src/f${i}.ts`, `// ${chunk}`));
    expect(problems(`${files.join('\n')}\n<vs-done/>`)).toMatch(/totalt/);
  });

  it('underkänner ett svar utan filer', () => {
    expect(problems('Jag vet inte.\n<vs-done/>')).toMatch(/inga filer/);
  });

  it.each([
    ['// ...', '  // ...'],
    ['/* ... */', '  /* ... */'],
    ['JSX-kommentar', '      {/* ... */}'],
    ['resten av koden', '  // resten av koden är som förut'],
    ['rest of', '  // rest of the component'],
    ['ellips', '  // …'],
    ['existing code', '  // ... existing code ...'],
    ['CSS', '/* ... resten av stilarna ... */'],
    ['ensam ellips', '…'],
    ['ensamma punkter', '  ...'],
  ])('underkänner utelämningen %s', (_namn, line) => {
    const content = `export function App() {\n${line}\n  return null;\n}`;
    expect(problems(`${block('src/App.tsx', content)}\n<vs-done/>`)).toMatch(/utelämn|HELA/i);
  });

  it('godtar ellips och spridning i vanlig kod och text', () => {
    const content = [
      "const lista = [...gamla, ny];",
      "const kopia = { ...doc.data, klar: true };",
      '<p>Hämtar bokningar …</p>',
      '<p>Laddar...</p>',
      '// Sorterar resten av listan efter datum',
      'function f(...args: number[]) { return args; }',
    ].join('\n');
    const outcome = ok(`${block('src/App.tsx', content)}\n<vs-done/>`);
    expect(outcome.files['src/App.tsx']).toBe(content);
  });

  it('ignorerar tomrader efter slutmarkören men underkänner filer efter den', () => {
    ok(`${block('src/a.ts', 'const a = 1;')}\n<vs-done/>\n\n`);
    expect(problems(`${block('src/a.ts', 'const a = 1;')}\n<vs-done/>\n${block('src/b.ts', 'const b = 1;')}`)).toMatch(/efter <vs-done\/>/);
  });

  it('samlar ihop texten utanför blocken som sammanfattning', () => {
    const outcome = ok(`Rad ett.\n${block('src/a.ts', 'const a = 1;')}\nRad två.\n<vs-done/>`);
    expect(outcome.summary).toBe('Rad ett.\nRad två.');
  });
});

describe('formatFiles', () => {
  it('skriver filerna i protokollets format, sorterade', () => {
    expect(formatFiles({ 'src/b.ts': 'b', 'src/a.ts': 'a' })).toBe(`${block('src/a.ts', 'a')}\n${block('src/b.ts', 'b')}`);
  });

  it('går att tolka tillbaka', () => {
    const files = { 'src/App.tsx': APP, 'src/styles.css': 'p {}\n' };
    expect(ok(`${formatFiles(files)}\n<vs-done/>`).files).toEqual(files);
  });
});
