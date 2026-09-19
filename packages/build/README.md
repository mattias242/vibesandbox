# @vibesandbox/build

Bygger AI-genererad appkod med den låsta mallen (`packages/app-template`). Koden kommer från en
språkmodell och behandlas som **opålitlig**.

```ts
import { createBuildRunner, createSpoolBuildRunner, readTemplateKnowledge } from '@vibesandbox/build';

const runner = createBuildRunner({ driver: 'docker', templateDirectory });   // eller 'local' i utveckling
// i drift, utan Docker-socket: createSpoolBuildRunner({ jobsDirectory: '/jobs', timeoutMs: 180_000 })

const result = await runner.build(files, { signal });
if (result.ok) await control.importVersion(appId, result.outputDirectory);
await result.dispose();   // tar bort outputDirectory; idempotent

const { starterFiles, exampleFiles } = await readTemplateKnowledge(templateDirectory);
```

## Pipeline

1. **Policy** (`checkSourceFiles` ur `@vibesandbox/policy`). Brott ⇒ `ok: false` direkt. Ingen
   process startas, ingen katalog skapas, inget jobb lämnas.
2. **Färsk arbetskatalog.** Mallens låsta filer (`index.html`, `package.json`, `tsconfig.json`,
   `vite.config.ts`, `src/main.tsx`) skrivs FÖRST, appens filer därefter med `wx` — en appfil kan
   aldrig skriva över en mallfil. Sökvägsregeln kontrolleras igen. `node_modules` är symboliska
   länkar till mallens installerade paket (närmaste vinner, som i Nodes upplösning).
3. **`tsc --noEmit -p tsconfig.json`** → diagnoser med fil, rad och meddelande.
4. **`vite build`** med mallens låsta konfiguration → diagnoser.
5. **Tak på utdatan** (standard 5 MB) och bara vanliga filer — symboliska länkar följs aldrig.
6. **`checkBuiltBundle`**: filtyper, inline-skript, externa adresser, `eval`.
7. `ok` ⇒ `outputDirectory` i en katalog som bara anroparen äger. Arbetskatalogen städas alltid.

Diagnoser: högst 20 (+ en rad om hur många som utelämnades), trimmade, med värdens absoluta
sökvägar utbytta (`src/App.tsx` i stället för `/tmp/…/app/src/App.tsx`, `…/` för övriga).
Regler för bygget: `timeout`, `memory-limit`, `output-too-large`, `output-invalid`, `build-failed`.

Högst **ett bygge åt gången**, FIFO. En avbruten `signal` tar bort ett väntande bygge ur kön;
ett pågående avbryts (processerna dödas) och `build` avvisas med `AbortError`. Tidsgräns ger i
stället `ok: false` med regeln `timeout`.

## Drivrutiner

| | `local` | `docker` | `spool` |
|---|---|---|---|
| Var | Barnprocesser på värden | Engångscontainer per bygge | Långlivad byggarbetare i egen container |
| Kräver | — | Docker-daemonen (= root på värden) | En delad katalog |
| Drift | **Nej** — vägrar `NODE_ENV=production` | Om plattformen får tala med Docker | **Ja** — plattformen saknar Docker-socket |

### `local` (utveckling)

tsc och Vite som barnprocesser: `spawn` med argumentlista (aldrig ett skal), minimal miljö (inte
`process.env` — inga hemligheter), tidsgräns och avbrott som dödar hela processgruppen, tak på
fångad utdata. Rimlig lokalt eftersom mallens konfiguration är låst: appens kod **transformeras
men körs inte** vid bygget. Det som saknas är isoleringen om det antagandet brister.

### `docker`

```
docker run --rm --name vibesandbox-bygge-<slumpat> --network none --read-only
  --tmpfs /work:rw,size=256m,mode=1777 --tmpfs /tmp:rw,size=64m,mode=1777
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256
  --memory 1536m --memory-swap 1536m --cpus 1.5 --user 10001:10001 [--runtime runsc]
  --env BUILD_TIMEOUT_MS=… --env BUILD_MEMORY_MB=… --env BUILD_MAX_OUTPUT_BYTES=…
  -v <in>:/in:ro -v <ut>:/out:rw vibesandbox/build-worker:dev
```

Containern får bara gränserna i miljön. Den skriver resultatet som en rad JSON på standard ut;
värden läser det som opålitlig data (bara väntade fält, trimmade), mäter och kopierar `/out` med
`O_NOFOLLOW` till en egen katalog och kör `checkBuiltBundle` själv. Tidsgräns ⇒ `docker kill`.
Utgångskod 137 (OOM) ⇒ `memory-limit`.

### `spool` (drift)

Plattformen kör i en container på ett internt nät **utan Docker-socket**. Den lämnar jobb i en
delad katalog; en separat byggarbetare (samma avbild, kommando
`node images/build-worker/spool-worker.ts`) bygger dem med samma pipeline som `local`.

```
<jobb>/tmp/        halvfärdigt; syns först efter rename (atomiskt)
<jobb>/incoming/   <tidsstämpel>-<slump>.json   jobb som väntar (FIFO via namnet)
<jobb>/running/    arbetaren har tagit jobbet (rename — bara en kan lyckas)
<jobb>/done/<id>/  result.json + dist/          svaret (hela katalogen via rename)
<jobb>/cancel/<id> plattformen har gett upp (tidsgräns/avbrott); arbetaren avbryter bygget
```

- Plattformen: policy först, jobb via tmpfil + `rename`, väntar med tidsgräns (inklusive kötid).
  Tidsgräns eller avbrott: ett väntande jobb dras tillbaka, ett pågående avbryts via `cancel/`.
  Svaret läses som opålitlig data och granskas som för `docker`.
- Arbetaren: ett jobb i taget, policy igen, egen tidsgräns (min av egen och jobbets), städar
  resultat/tmp/ogiltiga jobb äldre än 10 minuter, lägger tillbaka ett jobb om den stängs mitt i,
  och **får köras med `NODE_ENV=production`** — den ÄR sandlådan.

Förslag till tjänst i `deploy/compose.yml` (ägs av driftsättningen, inte av det här paketet):

```yaml
  build-worker:
    image: vibesandbox/build-worker:dev    # images/build-worker/Dockerfile
    command: ["node", "images/build-worker/spool-worker.ts"]
    user: "10001:10001"                     # samma uid som plattformen: båda läser och skriver /jobs
    network_mode: none
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    tmpfs: ["/tmp:rw,size=512m"]            # arbetskataloger
    volumes: [byggjobb:/jobs]
    mem_limit: 1536m
    memswap_limit: 1536m
    pids_limit: 256
    cpus: 1.5
    restart: unless-stopped
    init: true
    # Inga environment-hemligheter. Valfritt: BUILD_TIMEOUT_MS, BUILD_MEMORY_MB, BUILD_MAX_OUTPUT_BYTES.
```

## Avbilden (`images/build-worker/`)

Node 24 slim, pinnad på index-sammanfattning. Innehåller bara mallen, SDK:t, kontrakten,
policyn och byggkedjan; beroenden installeras med `npm ci --ignore-scripts` när avbilden byggs
(det enda tillfället något hämtas från nätet). Körs som uid 10001, allt i `/opt/vibesandbox` ägs
av root. `Dockerfile.dockerignore` begränsar kontexten till just de filerna.

```
npm run image -w @vibesandbox/build                              # värdens arkitektur
npm run image -w @vibesandbox/build -- --platform linux/amd64    # för servern, även från en Mac
```

Beroendena installeras på byggmaskinens plattform med `npm ci --os=linux --cpu=<mål>`, och
slutsteget bara kopierar — ingen emulering behövs för att bygga amd64-avbilden på en Mac.

## Gränser (standard, `DEFAULT_LIMITS`)

| | Värde | Varför |
|---|---|---|
| `timeoutMs` | 120 000 | Startappen tar under 1 s varm; tiofaldig marginal för stora appar och en belastad server. |
| `memoryMb` | 1536 | Uppmätt topp 164 MB för startappen; lämnar gott om plats på 4 GB för plattform och databas. |
| `cpus` | 1,5 | Av 2 vCPU; plattformen svarar fortfarande under ett bygge. |
| `pidsLimit` | 256 | Uppmätt topp 31 (tsc och rolldown använder trådar). |
| `workTmpfsMb` / `tmpTmpfsMb` | 256 / 64 | Mallens filer + appen + dist är några hundra kB. |
| `maxOutputBytes` | 5 MB | Startappen blir ~190 kB. |

## Mätningar (2026-09-19, MacBook M-serie, Docker Desktop 29, Node 26)

Startappen (`starter/`), tid för `build()` inklusive policy och granskning:

| Drivrutin | Kall | Varm |
|---|---|---|
| `local` | 0,56 s | 0,34 s |
| `docker` | 0,94 s (2,3 s första containern direkt efter avbildsbygget) | 0,67–0,76 s |
| `spool` (arbetare i container) | 0,53 s | 0,6 s |

Minnestopp i containern 164 MB, högst 31 processer/trådar. Byggavbilden 459 MB (varav 73 MB
beroenden; resten är Node-basen). Serverns (2 vCPU, amd64) siffror är **inte uppmätta**.

## Hotbild

Angriparen är den som styr modellens utdata (prompt-injektion via användarens text eller
data). Målen och vad som står emot:

| Mål | Skydd |
|---|---|
| Köra kod på byggservern vid bygget | Låst Vite-konfiguration: bara `src/` läses, inga `postcss.config.*`, `.env`, `public/`, ingen Tailwind. Sökvägsregeln stänger `src/tsconfig.json` (oxc läser närmaste tsconfig), `src/vite.config.ts` m.fl. Policyn stänger `@plugin`/`@config`, `/// <reference>`, `import.meta.glob`, `?raw`/`?worker`. |
| …och om det ändå lyckas | Container/arbetare utan nät, skrivskyddad, utan rättigheter och hemligheter, med gränser. Prövat med en fientlig testmall (`test/docker.test.ts`). |
| Läsa filer på värden | Inga importer eller `url()` utanför `src/`; ingen `triple-slash`; checkBuiltBundle och kopieringen följer aldrig länkar. |
| Läcka data från den färdiga appen | Plattformens CSP (bärande), policyn (försvar på djupet), checkBuiltBundle. |
| Störa andra byggen | En färsk arbetskatalog per bygge, ett bygge åt gången, allt städas. |
| Fylla disk/minne | Tak på källfiler, utdata, fångad utdata, tmpfs, minne, processer och tid. |
| Lura plattformen via arbetarens svar | Svaret är opålitlig data: tvättade diagnoser, `O_NOFOLLOW`, egen granskning. |

## OTESTAT

- **`runsc` (gVisor)**: flaggan skickas med, men gVisor finns inte i testmiljön. Bygget under
  gVisor är inte prövat.
- **amd64-avbilden körd**: byggd från Mac och innehållet kontrollerat (linux-x64-binärer), men den
  går inte att köra här utan emulering. CI-jobbet `docker` kör avbilden på amd64.
- **Byggarbetaren i `deploy/compose.yml`**: tjänsten ovan är ett förslag; den finns inte i stacken.
  Arbetaren är prövad i en container med `--network none --read-only` och en delad katalog,
  men inte under userns-remap på servern (uid 10001 → 110001).
- **Två arbetare samtidigt** mot samma katalog: `rename` gör anspråket atomiskt, men det är inte
  testat.
- **Byggtider och minne på servern** (2 vCPU/4 GB) — bara uppmätt på en Mac.
- **Symboliska länkar i `/out` på Linux** när containern är komprometterad: prövat för `spool`
  med en falsk arbetare; för `docker` bara via samma kod.
