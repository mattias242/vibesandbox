## Påminnelser — `schedule`

Appen körs bara när någon har den öppen. Ska appens medlemmar påminnas om något senare, lämna
påminnelsen till plattformen: den skickas vid rätt tid (som mejl till medlemmarna), även när
ingen har appen öppen.

```ts
import { schedule, SdkError } from '@vibesandbox/sdk';

// Ger { id, nextAt } — nextAt är nästa utskick som ISO-tid i UTC.
const { id } = await schedule.remind({
  at: '2026-10-02T09:00:00+02:00', // ISO-tid MED tidszon, eller ett Date
  repeat: 'weekly',                // valfritt: 'daily' | 'weekly' | 'monthly'
  to: 'all',                       // 'all' | 'owner' | ['<userId>', …] (bara appens medlemmar)
  subject: 'Städdag',              // en rad, högst 200 tecken
  text: 'Samling vid förrådet.',   // högst 4000 tecken
});

const paminnelser = await schedule.list(); // egna; appens ägare ser alla
await schedule.cancel(id);                 // egen; ägaren kan ta bort alla
```

`list()` ger `{ id, nextAt, repeat, to, subject, text, createdBy }[]`.

### Regler

- Tiden ska ha tidszon (`Z` eller `+02:00`). Utan tidszon, i det förflutna eller mer än ett år fram
  ⇒ `SdkError` med `code: 'invalid_request'`.
- Upprepning sker med samma klockslag i **Sverige** (Europe/Stockholm), även över sommartid.
  `monthly` på den 31:a blir sista dagen i kortare månader.
- Påminnelser som inte hann gå (t.ex. under ett driftavbrott) skickas en gång efteråt — inte en per
  missat tillfälle.
- Mottagare som inte (längre) är medlemmar hoppas över. Lämnar skaparen appen tas påminnelsen bort.
- I **förhandsvisningen** går alla påminnelser bara till ägaren (`to` blir `'owner'`).
- Gräns för antal aktiva påminnelser per person och per app ⇒ `code: 'rate_limited'`; visa
  `error.message` och föreslå att ta bort någon.
- Någon annans påminnelse ⇒ `code: 'not_found'`.
- Påminnelsen skickas med samma regler som `notify`: skriv inga webbadresser i texten utom appens
  egen. En påminnelse som bryter mot det skickas inte när det är dags — och det märks inte i appen.

### Exempel: påminn alla varje fredag kl 9

```ts
// Nästa fredag kl 09:00 svensk tid. Date räknar i webbläsarens tidszon, så ange tiden med
// tidszon i stället — plattformen håller sedan kl 9 svensk tid, även över sommartid.
function nastaFredagKl9(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  const datum = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }); // "2026-10-02"
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Stockholm', timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${datum}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')?.value.slice(3); // "GMT+02:00" → "+02:00"
  return `${datum}T09:00:00${offset ?? '+01:00'}`;
}

await schedule.remind({
  at: nastaFredagKl9(),
  repeat: 'weekly',
  to: 'all',
  subject: 'Veckomöte i dag kl 10',
  text: 'Agendan finns i appen.',
});
```

### Exempel: påminn ägaren dagen innan en bokning

```ts
async function bokaOchPaminn(bokning: { rum: string; start: Date }) {
  const sparad = await bokningar.add({ rum: bokning.rum, start: bokning.start.toISOString() });
  const dagenInnan = new Date(bokning.start.getTime() - 24 * 60 * 60 * 1000);
  if (dagenInnan > new Date()) {
    const { id } = await schedule.remind({
      at: dagenInnan, // ett Date går bra: det är ett exakt ögonblick
      to: 'owner',
      subject: `Bokning i morgon: ${bokning.rum}`,
      text: `${bokning.rum} är bokat ${bokning.start.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}.`,
    });
    // Spara påminnelsens id, så att den kan tas bort om bokningen avbokas.
    await bokningar.update(sparad.id, { ...sparad.data, paminnelse: id });
  }
}
```
