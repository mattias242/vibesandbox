# @vibesandbox/sdk

Så lagrar en app sin data. Det här är HELA gränssnittet — det finns inget mer.

```ts
import { db, whoami, SdkError } from '@vibesandbox/sdk';
```

## Regler

- Appen är ren frontend. All data sparas genom `db`. Använd aldrig `fetch`, `localStorage`
  eller någon adress — plattformen vet själv vilken app det gäller.
- Data är **dokument**: vanliga objekt med JSON-värden (text, tal, `true`/`false`, `null`,
  listor, objekt). Inga `Date`, `Map`, klasser eller funktioner. Spara datum som text
  (`"2026-10-01"`). Ett dokument får vara högst 256 kB.
- Dokument ligger i **kollektioner**. Namnet: små bokstäver `a–z`, siffror, `-` och `_`,
  börjar med en bokstav, högst 64 tecken. Rätt: `'bokningar'`. Fel: `'Bokningar'`, `'mina svar'`, `'frågor'`.
- En kollektion är antingen **gemensam** (alla som får öppna appen ser och kan ändra allt)
  eller **personlig** (`{ personal: true }`: varje användare ser bara sina egna dokument).
  Valet görs första gången kollektionen används och kan aldrig ändras. Använd samma val
  överallt för samma namn, annars kastas felet `scope_mismatch`.
- Alla funktioner är asynkrona (`await`). Fel kastas som `SdkError`.

## API

```ts
// Skapa en kollektion (gör det en gång, överst i filen)
db.collection<T>(name: string, options?: { personal?: boolean }): Collection<T>

interface Collection<T> {
  add(data: T): Promise<Doc<T>>;               // sparar nytt dokument, ger tillbaka det med id
  list(): Promise<Doc<T>[]>;                   // alla dokument (högst 1000). Sortera själv.
  get(id: string): Promise<Doc<T>>;            // ett dokument; 'not_found' om det saknas
  update(id: string, data: T): Promise<Doc<T>>; // ERSÄTTER hela dokumentet
  remove(id: string): Promise<void>;           // tar bort; 'not_found' om det saknas
}

interface Doc<T> {
  id: string;          // sätts av plattformen
  data: T;             // det appen sparade
  createdAt: string;   // ISO-tid, t.ex. "2026-09-18T09:30:00.000Z"
  updatedAt: string;
}

whoami(): Promise<{ userId: string; displayName: string }>  // den inloggade användaren

class SdkError extends Error {
  code: 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid_request' | 'scope_mismatch'
      | 'quota_exceeded' | 'too_large' | 'rate_limited' | 'internal' | 'network';
  message: string;     // klarspråk på svenska — visa det för användaren som det är
}
```

**`update` ersätter hela dokumentet.** Fält som inte skickas med försvinner. Ändra ett fält så här:

```ts
await bokningar.update(doc.id, { ...doc.data, rum: 'Lilla salen' });
```

Det appen sparade ligger i `doc.data` — skriv `doc.data.rum`, inte `doc.rum`.

## Exempel 1: gemensam lista

```ts
import { db, SdkError } from '@vibesandbox/sdk';

interface Bokning {
  rum: string;
  datum: string; // "2026-10-01"
  vem: string;
}

const bokningar = db.collection<Bokning>('bokningar');

async function visaBokningar() {
  const alla = await bokningar.list();
  alla.sort((a, b) => a.data.datum.localeCompare(b.data.datum));
  return alla;
}

/** Ger ett felmeddelande att visa, eller null om det gick bra. */
async function boka(rum: string, datum: string, vem: string): Promise<string | null> {
  try {
    await bokningar.add({ rum, datum, vem });
    return null;
  } catch (error) {
    // SdkError.message är redan begriplig svenska
    return error instanceof SdkError ? error.message : 'Något gick fel.';
  }
}

async function avboka(id: string) {
  await bokningar.remove(id);
}
```

## Exempel 2: personliga anteckningar och vem som är inloggad

```ts
import { db, whoami } from '@vibesandbox/sdk';

interface Anteckning {
  text: string;
  klar: boolean;
}

// personal: true ⇒ varje användare ser bara sina egna anteckningar
const anteckningar = db.collection<Anteckning>('anteckningar', { personal: true });

const jag = await whoami();
console.log(`Hej ${jag.displayName}!`);

const ny = await anteckningar.add({ text: 'Ring vaktmästaren', klar: false });
await anteckningar.update(ny.id, { ...ny.data, klar: true });
const mina = await anteckningar.list(); // bara den inloggades egna
```

## Utanför plattformen (tester, lokal utveckling, exporterad app)

Appkoden ändras inte — bara var data lagras:

```ts
import { configure, createMemoryAdapter } from '@vibesandbox/sdk';

configure({ adapter: createMemoryAdapter() }); // allt i minnet, samma regler som plattformen
```

`createPlatformAdapter()` är standard och behöver aldrig anges. En egen lagring implementerar
gränssnittet `StorageAdapter` (sex metoder, se `src/adapter.ts`).
