## ocr — läs texten i en uppladdad bild eller PDF

`ocr.read(fileId, { language? })` läser texten i en fil som laddats upp med `files`.
Kräver tjänsten `files`. Ger `{ text, pages }` där `pages` är `[{ number, text }]`.

```ts
import { files, ocr, SdkError } from '@vibesandbox/sdk';

// Ett kvitto som användaren fotat: ladda upp, läs texten, spara den.
async function lasKvitto(bild: File): Promise<string> {
  const { id } = await files.upload(bild);
  try {
    const { text } = await ocr.read(id, { language: 'sv' });
    return text;
  } catch (fel) {
    if (fel instanceof SdkError) return fel.message; // klarspråk, går att visa som det är
    throw fel;
  }
}
```

- **Filtyper:** PNG, JPEG, WebP och PDF. Typen avgörs av filens innehåll, inte namnet.
  Annat ger `invalid_request`. PDF fungerar bara om plattformen är inställd för det —
  annars `invalid_request` med råd att ladda upp sidorna som bilder.
- **Språk:** `'sv'` (standard) eller `'en'`.
- **Sidor:** en bild är en sida. En PDF kan ge en tom `pages`; använd då `text`.
- **Gränser:** för stor fil, för hög upplösning eller för många sidor ger `too_large`.
  Varje app har ett antal sidor per dygn och varje användare per timme — `rate_limited`.
  Samma fil läses bara en gång: ett nytt anrop med samma fil och språk kostar inget.
- **Tillfälligt fel** (status 503): visa meddelandet och låt användaren försöka igen.
- **Fil från en annan app** finns inte (`not_found`).

**Dataskydd:** bilden skickas som den är till plattformens svenska personuppgiftsbiträde
(Berget); den kan inte maskeras först. Skicka inte dokument med känsliga personuppgifter
(personnummer, hälsa, ekonomi) i onödan — låt användaren välja vad som läses. Texten som
kommer tillbaka är appens egen data och sparas som vilken data som helst.
