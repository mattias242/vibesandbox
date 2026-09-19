# history — vem ändrade vad och när

Plattformen sparar själv en historikrad vid varje `add`, `update` och `remove` i `db`. Appen
behöver inte göra något för att historiken ska finnas — den kan bara visa den och ångra.

```ts
import { history } from '@vibesandbox/sdk';
```

## Funktioner

| Funktion | Ger |
|---|---|
| `history.forDocument(kollektion, id, { limit?, cursor? })` | `{ entries, nextCursor? }` — dokumentets historik, **nyast först** |
| `history.forCollection(kollektion, { since?, limit?, cursor? })` | samma, för hela kollektionen; varje rad har också `documentId` |
| `history.restore(kollektion, id, at)` | dokumentet efter återställningen (`{ id, data, createdAt, updatedAt }`) |

Varje rad i `entries`:

```ts
{ event: 'create' | 'replace' | 'delete' | 'restore', at: string, userId: string, displayName: string, data: T }
```

- `data` är innehållet **efter** ändringen. Vid `delete`: innehållet dokumentet hade innan det togs bort.
- `displayName` är ett namn att visa (t.ex. `"anna.andersson"`), aldrig en e-postadress.
- `at` (ISO 8601) pekar ut exakt en version — det är den du skickar till `restore`.
- `since` ger bara det som hänt efter den tiden. `nextCursor` finns när det finns äldre rader.

## Exempel: visa vem som ändrade senast

```ts
const { entries } = await history.forDocument('arenden', arende.id, { limit: 1 });
const senast = entries[0];
if (senast) {
  text.textContent = `Senast ändrad av ${senast.displayName} ${new Date(senast.at).toLocaleString('sv-SE')}`;
}
```

## Exempel: ångra

```ts
// Tillbaka till versionen före den senaste ändringen.
const { entries } = await history.forDocument('arenden', arende.id, { limit: 2 });
const forra = entries[1];
if (forra && forra.event !== 'delete') {
  await history.restore('arenden', arende.id, forra.at);
}

// Ta tillbaka ett borttaget dokument: den senaste versionen före borttagningen.
const { entries: rader } = await history.forDocument('arenden', borttagetId);
const sistaInnehall = rader.find((rad) => rad.event !== 'delete');
if (sistaInnehall) await history.restore('arenden', borttagetId, sistaInnehall.at);
```

Återställningen sparas som en ny version (`event: 'restore'`) och syns själv i historiken.

## Regler

- **Personliga kollektioner** (`{ personal: true }`): var och en ser och återställer bara sina egna
  dokument. Någon annans ger `SdkError` med `code: 'not_found'`. Gemensamma: alla i appen ser allt.
- `restore` följer samma regler som `update`. En tid som inte finns i historiken ⇒ `not_found`;
  tiden för en borttagning (`event: 'delete'`) ⇒ `invalid_request` — välj versionen före.
- Historiken sparas en begränsad tid (normalt ett år) och delar appens lagringsutrymme. Blir
  utrymmet fullt tas de äldsta raderna bort först; appens egna dokument går alltid före.
- Fel kastas som `SdkError`; `message` är klarspråk som går att visa för användaren.
