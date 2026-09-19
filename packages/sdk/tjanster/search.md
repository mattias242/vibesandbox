## search — sök i en kollektion efter innebörd

Hittar dokument som handlar om samma sak som en fråga, även när orden inte är desamma
("stulen cykel" hittar "Cykeln försvann från stället"). Söker bara bland dokument som den
inloggade ändå får se: i en personlig kollektion bara hens egna.

```ts
import { search } from '@vibesandbox/sdk';

// Id och likhet, mest lika först: [{ id, score }]
const traffar = await search.search('arenden', 'stulen cykel');

// Samma sak, men med dokumenten hämtade: [{ doc, score }] där doc = { id, data, createdAt, updatedAt }
const hittade = await search.searchDocuments<Arende>('arenden', 'stulen cykel', { limit: 5 });
```

Val (alla frivilliga):

- `limit` — högst så många träffar, 1–50. Standard 10.
- `personal: true` — kollektionen är personlig (samma val som i `db.collection(namn, { personal: true })`).
  Fel val ger `SdkError` med `code: 'scope_mismatch'`.
- `fields: ['rubrik', 'beskrivning']` — sök bara i dessa fält. Standard: all text i dokumentet.

Frågan får vara högst 1000 tecken. Varje dokument söks på sina första 1500 tecken text.
Tal, datum och sant/falskt ingår inte — filtrera på dem själv efter sökningen.
`score` går bara att jämföra inom samma sökning; visa ordningen, inte talet.

### Exempel: hitta liknande ärenden

```tsx
const arenden = db.collection<Arende>('arenden');

async function liknande(arende: Doc<Arende>) {
  const traffar = await search.searchDocuments<Arende>('arenden', arende.data.rubrik, { limit: 6, fields: ['rubrik', 'beskrivning'] });
  return traffar.filter((t) => t.doc.id !== arende.id).slice(0, 5);
}
```

### Exempel: sök i kunskapsbanken

```tsx
const [fraga, setFraga] = useState('');
const [svar, setSvar] = useState<{ doc: Doc<Artikel>; score: number }[]>([]);
const [fel, setFel] = useState('');

async function sok(e: FormEvent) {
  e.preventDefault();
  setFel('');
  try {
    setSvar(await search.searchDocuments<Artikel>('kunskapsbank', fraga, { limit: 10 }));
  } catch (err) {
    setFel(err instanceof SdkError ? err.message : 'Sökningen misslyckades.');
  }
}
```

### Fel (`SdkError`, `message` går att visa som den är)

- `rate_limited` — för många sökningar på en minut. Be användaren vänta.
- `quota_exceeded` — appens sökkvot för dygnet är slut.
- `too_large` — kollektionen har fler än 5000 dokument.
- `internal` — sökningen går inte att använda just nu. Låt användaren försöka igen.

Sök inte vid varje tangenttryckning: sök när användaren skickar formuläret.

### Dataskydd

Dokumentens text och frågan skickas till Berget (svenskt personuppgiftsbiträde) för att räknas om
till vektorer. Innan dess maskar plattformen personnummer, telefonnummer, e-postadresser,
kortnummer och IBAN — i både dokument och fråga, så sökningen fungerar ändå. Namn och fritext om
personer maskas inte. Sökindexet sparar vektorer, aldrig texten.
