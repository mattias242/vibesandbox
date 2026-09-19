## transcribe — tal till text

Gör om en uppladdad ljudfil (möte, intervju, röstmemo) till text med tidsangivelser. Ljudet
laddas först upp med `files`; `transcribe` får bara filens id.

```ts
import { files, transcribe } from '@vibesandbox/sdk';

// 1. Ladda upp (en <input type="file" accept="audio/*"> eller en inspelning, se nedan).
const { id } = await files.upload(fil);

// 2. Gör om till text och vänta (tar ungefär en minut per 15–25 minuter ljud, plus kö).
const { text, segments } = await transcribe.transcribe(id, { language: 'sv' });
// text:     "Välkomna till mötet. Första punkten är budgeten."
// segments: [{ start: 0, end: 2.5, text: 'Välkomna till mötet.' }, …]  (sekunder)
```

Långa inspelningar — beställ och fråga själv, så att användaren kan göra annat under tiden:

```ts
const { jobId } = await transcribe.start(id, { language: 'sv' });
// Spara jobId (t.ex. i db) och fråga senare:
const job = await transcribe.status(jobId);
// job.status: 'queued' | 'running' | 'done' | 'failed'
// 'done' ⇒ job.text, job.segments.  'failed' ⇒ job.error (klarspråk, visa det som det är).
```

Spela in i webbläsaren (fungerar i appen utan nätverk utåt):

```ts
const strom = await navigator.mediaDevices.getUserMedia({ audio: true });
const inspelning = new MediaRecorder(strom);
const delar: Blob[] = [];
inspelning.ondataavailable = (e) => delar.push(e.data);
inspelning.onstop = async () => {
  strom.getTracks().forEach((t) => t.stop());
  const ljud = new Blob(delar, { type: inspelning.mimeType }); // audio/webm eller audio/mp4
  const { id } = await files.upload(ljud);
  visaText((await transcribe.transcribe(id, { language: 'sv' })).text);
};
inspelning.start();
// … inspelning.stop() när användaren trycker "Klar".
```

Regler:
- `language`: `'sv'` eller `'en'`. Utelämnat känns språket igen automatiskt; ange `'sv'` för svenska.
- Format: mp3, m4a/mp4, wav, webm. Annat ⇒ `SdkError` `invalid_request`. Högst 100 MB ⇒ annars `too_large`.
- Appen har ett antal ljudminuter per dygn. Slut ⇒ `SdkError` `rate_limited` — visa meddelandet.
- Bara den som beställde utskriften, och appens ägare, kan läsa den. Resultatet gallras efter ett
  antal dagar — spara texten i `db` om den ska finnas kvar.
- Visa alltid `error.message` från `SdkError` för användaren; det är klarspråk.

Dataskydd — skriv in det här i appen:
- Ljud kan inte maskeras. Det skrivs ut av Berget, plattformens godkända svenska personuppgiftsbiträde.
- **Den som spelar in ska ha informerat alla som hörs i inspelningen** om att den spelas in och görs
  om till text, innan inspelningen startar. Visa en tydlig text om det bredvid inspelningsknappen,
  t.ex. "Berätta för alla som är med att mötet spelas in och skrivs ut."
