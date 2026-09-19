# @vibesandbox/policy

Vad appens kod får innehålla. Två kontroller:

```ts
import { checkSourceFiles, checkBuiltBundle } from '@vibesandbox/policy';

checkSourceFiles(files);            // → Diagnostic[] — appens källfiler, innan något byggs
await checkBuiltBundle(directory);  // → Diagnostic[] — det byggda, innan det importeras
```

Alla diagnoser har `source: 'policy'`, ett `rule`-id, `file` och (för källfiler) `line`.
Meddelandet säger vad som är förbjudet och vad modellen ska göra i stället.

## Det här är försvar på djupet — inte det bärande skyddet

Policyn är **mönstermatchning på text**. Den går att kringgå: den som vill kan sätta ihop
`'fe' + 'tch'` och nå den via ett alias som mönstren inte känner igen. Det bärande skyddet är
**webbläsarens CSP** som plattformen sätter på varje app (`APP_CONTENT_SECURITY_POLICY` i
contracts): `connect-src 'self'`, `script-src 'self'`, `worker-src 'none'`, `frame-src 'none'`.

Policyn finns ändå, av tre skäl:

1. **Modellen får ett begripligt besked.** Under CSP:n slutar en app som använder `fetch` mot en
   extern adress bara att fungera. Här får modellen veta varför, och vad den ska använda i stället
   (`db.collection(...)` ur `@vibesandbox/sdk`).
2. **De vanligaste omskrivningarna fastnar:** `window['fetch']`, `globalThis.fetch`, `self.fetch`,
   alias för `window`/`globalThis`, hakparentes med uttryck, `\u`-escapes i namn, escape-sekvenser
   i adresser (`'\x68ttps://'`), och CSS-escapes (`\75rl(`).
3. **Sökvägar och importer är skarpa regler**, inte heuristik: bygget ser aldrig en fil eller en
   import utanför det mallen tillåter.

## Regler för källfiler

Regel-id:na är ett gränssnitt: agenten (`packages/agent/src/klarsprak.ts`) avbryter turen direkt
vid säkerhetsbrotten `external-url`, `network-api`, `dynamic-code`, `browser-storage`,
`window-open` och `service-worker`, och förklarar `forbidden-import` i klarspråk. Byt inte namn
på dem utan att ändra där samtidigt.

| Regel | Vad |
|---|---|
| `path-not-allowed` | Sökvägen följer inte `isAllowedSourcePath` ur contracts (EN regel). Stänger `src/tsconfig.json`, `src/vite.config.ts`, `src/.env`, `src/postcss.config.js`, `src/main.tsx` m.fl. |
| `too-many-files`, `file-too-large`, `total-too-large`, `invalid-content` | Storlek (60 filer, 200 kB/fil, 1 MB totalt) och styrtecken/NUL. |
| `forbidden-import` | Bara `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@vibesandbox/sdk` (härlett ur mallens `approved-packages.json`) och relativa sökvägar som stannar i `src/`, utan `?raw`/`?worker`. |
| `dynamic-import`, `require`, `import-meta`, `triple-slash` | `import()` bara med fast relativ sökväg; ingen `require`; `import.meta` bara som `.env`; inga `/// <reference>` (typkontrollen skulle läsa filer utanför appen). |
| `network-api`, `window-open`, `dynamic-code`, `browser-storage`, `document-domain`, `service-worker`, `frame-escape`, `navigation` | Förbjudna API:er per grupp. |
| `global-access`, `escape-sequence` | Hakparentes eller alias för `window`/`globalThis`/`self`; `\u` i namn. |
| `external-url`, `url-in-comment`, `javascript-url`, `data-html-url` | Absoluta `http(s)://`, `ws(s)://`, protokollrelativa `//värd`, `javascript:`, `data:text/html`. Undantag: XML-namnrymder (`ALLOWED_SOURCE_URLS`, kommenterad lista). En adress i en kommentar ger det lindrigare `url-in-comment`. |
| `css-import`, `css-url`, `css-plugin`, `css-expression`, `css-behavior`, `css-binding`, `css-escape` | CSS. `url()` bara med `data:` eller `#id`. `@plugin`/`@config` (Tailwind v4) kör JavaScript vid bygge. |

### Kommentarer och strängar

Kommentarer skalas bort före API-kontrollen, så att "vi använder inte localStorage" i en kommentar
inte fälls. Utan en riktig parser kan skannern ta fel — JSX-text som `<p>//</p>` eller `<p>Don't</p>`
ser ut som kommentar respektive sträng. Därför granskas allt som lades undan som text **ändå**, med
mönster formade som anrop (`fetch(`, `localStorage.`). Kod som gömts i något som ser ut som en
kommentar fastnar alltså; vanlig prosa gör det inte. Adresser granskas i hela källan, även kommentarer.

## Regler för det byggda (`checkBuiltBundle`)

`bundle-file-type` (bara `index.html` och `assets/*.js|css`; symboliska länkar och specialfiler
nekas och följs aldrig), `bundle-inline-script`, `bundle-external-url` (samma lista som mallens
`test/build.test.ts`, plus Reacts felsida som står i felmeddelandenas text), `bundle-eval`.

## Känt som INTE fångas

- Strängar som sätts ihop vid körning (`'ht' + 'tps://'`, `['fe', 'tch'].join('')`) och åtkomst
  via ett alias som skapats indirekt (`Reflect.get`, `Object.getOwnPropertyDescriptor`, en
  funktionsparameter som råkar vara `window`). CSP:n stoppar nätanropen ändå.
- HTML-injektion i appens egen data (`dangerouslySetInnerHTML`) — CSP:n stoppar skript och
  externa resurser, men inte t.ex. ett falskt formulär som postar till appen själv.
