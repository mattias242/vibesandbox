## notify — aviseringar via mejl till appens medlemmar

Mejlar dem som har tillgång till appen. Mottagare anges med **användar-id**, `'all'` (alla
medlemmar) eller `'owner'` (appens ägare) — aldrig med e-postadress. Appen får aldrig se någons
adress. Vilka medlemmar appen har (id och visningsnamn) ger tjänsten `roles`
(`GET /_api/roles/members`) — använd den för att låta användaren välja mottagare.

```ts
import { notify, SdkError } from '@vibesandbox/sdk';

// Till alla i appen
const { sent } = await notify.send({ to: 'all', subject: 'Mötet är flyttat', text: 'Vi ses på torsdag kl. 18 i stället.' });

// Till några utvalda (id från roles) eller till ägaren
await notify.send({ to: [userId], subject: 'Din tur', text: 'Du står på tur att boka lokalen.' });
await notify.send({ to: 'owner', subject: 'Ny anmälan', text: 'Någon har anmält sig till kursen.' });

// Visa fel i klarspråk
try {
  await notify.send({ to: 'all', subject, text });
} catch (e) {
  if (e instanceof SdkError) visaFel(e.message); // t.ex. för många aviseringar, eller en webbadress i texten
}
```

**Regler (plattformen kontrollerar dem — skriv koden så att de följs):**

- **Ren text.** Ämne högst 150 tecken, text högst 5000. Radbrytningar i texten behålls.
- **Inga webbadresser eller e-postadresser** i ämne eller text — inte heller sådant som liknar en
  (`namn.se`, `fil.pdf`, `www.…`). Enda undantaget är appens egen adress. Skriv "öppna appen";
  mejlet innehåller alltid en länk till appen.
- Mejlet visar avsändarens visningsnamn, appen och varför mottagaren får det. Skriv inte in det själv.
- Okända id hoppas över tyst. `sent` är antalet mejl som gick iväg.
- **Gränser:** per avsändare och per app, per timme och dygn. `'all'` räknas per mottagare. Över
  gränsen ⇒ `SdkError` med koden `rate_limited` och inget skickas. Skicka inte i loopar.
- **I förhandsvisningen** går mejlet bara till ägaren själv; svaret har då `onlyOwner: true` och
  `message` att visa.

**Avstängning — varje app som skickar aviseringar ska ha en knapp för den:**

```ts
const { muted } = await notify.settings();   // den inloggades inställning i den här appen
await notify.setMuted(true);                 // stäng av aviseringar från appen
await notify.setMuted(false);                // slå på igen
```
