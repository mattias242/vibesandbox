## extract — hämta texten ur en bifogad fil

`extract.read(fileId)` hämtar texten ur en fil som laddats upp med `files`.
Kräver tjänsten `files`. Ger `{ text, kind, truncated, pages, hasText, message? }`.

Allt arbete sker inne i plattformen. Varken filen eller texten skickas vidare någon annanstans,
och det finns ingen leverantör inblandad.

```ts
import { files, extract, llm } from '@vibesandbox/sdk';

// Användaren bifogar en fil, appen visar texten och låter språkmodellen sammanfatta den.
async function lasBilaga(fil: File): Promise<{ text: string; sammanfattning: string }> {
  const { id } = await files.upload(fil);
  const { text, hasText, message, truncated } = await extract.read(id);

  if (!hasText) {
    // Inget att hämta — t.ex. en inskannad fil. `message` är klarspråk och går att visa som den är.
    return { text: '', sammanfattning: message ?? '' };
  }

  const sammanfattning = await llm.complete(`Sammanfatta det här i fem punkter:\n\n${text}`);
  return { text: truncated ? `${text}\n\n(Bara början av filen visas.)` : text, sammanfattning };
}
```

Visa alltid texten för användaren innan appen sparar den — det är hens fil, och det är hen som
kan se om något blev fel.

- **Filtyper:** Word (`docx`), Excel (`xlsx`), PowerPoint (`pptx`) och PDF. `kind` säger vilken
  det blev. Sorten avgörs av filens innehåll, inte av namnet: en fil som heter `.docx` men är
  något annat ger `invalid_request`.
- **Så blir texten:** ett stycke per rad i Word. En rad per rad i Excel, med ett tabbtecken
  mellan cellerna och en tomrad mellan bladen. En bild i taget i PowerPoint, med en tomrad
  emellan. Formatering, färger och bilder följer inte med. I filer med flera spalter kan
  ordningen bli en annan än på papperet.
- **`hasText: false`** betyder att det inte fanns någon text att hämta. Vanligast är en inskannad
  PDF — alltså en bild av ett papper. `message` är en färdig mening att visa; texten där hänvisar
  till tjänsten som läser text i bilder (`ocr`), om den är påslagen.
- **`pages`** är antalet sidor i en PDF och antalet bilder i en presentation. `0` för Word och Excel.
- **`truncated: true`** betyder att filen innehöll mer text än som ryms i ett svar. Säg det för
  användaren i stället för att låtsas att hela filen är med.
- **Gränser:** en för stor fil, eller en fil som packar upp till något orimligt, ger `too_large`.
  Varje app får hämta text ett antal gånger per dygn och varje användare ett antal gånger per
  timme — `rate_limited`. Samma fil hämtas bara en gång: ett nytt anrop med samma fil är gratis
  och går fort.
- **Fil från en annan app** finns inte (`not_found`). En borttagen fil finns inte heller, även om
  texten hämtats tidigare.
- **En skadad fil** ger `invalid_request` med ett meddelande som går att visa som det är.

**Dataskydd:** filen och texten stannar i plattformen. Skickar appen sedan texten vidare till
språkmodellen gäller reglerna för den tjänsten — se `llm`. Texten är appens egen data och sparas
som vilken data som helst.
