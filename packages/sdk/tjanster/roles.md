## roles — roller inuti appen

Appen bestämmer vilka roller som finns (t.ex. `handlaggare`, `admin`); ägaren bestämmer vem som har
vilken. Alla medlemmar kan läsa medlemslistan och rollerna.

> **En roll styr vad appen visar — den skyddar inte data.** Plattformen tvingar inte rollerna: den
> som kommer åt appen kan läsa och skriva appens gemensamma kollektioner oavsett roll. Att dölja en
> knapp för den som saknar rollen `admin` hindrar inte att anropet görs ändå. **Personliga
> kollektioner är det som skyddar data.** Lägg aldrig något i en gemensam kollektion som bara vissa
> roller får se.

```ts
import { roles, SdkError } from '@vibesandbox/sdk';

await roles.members();     // → [{ userId, displayName, access: 'owner'|'user', roles: string[] }]
await roles.me();          // → { userId, access: 'owner'|'user', roles: string[] }
await roles.has('admin');  // → true/false för den inloggade
await roles.definitions(); // → [{ id, name }]

// Bara ägaren (access === 'owner'); andra får SdkError med code 'forbidden'.
await roles.setDefinitions([{ id: 'handlaggare', name: 'Handläggare' }, { id: 'admin', name: 'Admin' }]);
await roles.assign(userId, ['handlaggare']); // ersätter medlemmens roller; [] tar bort alla
```

Regler:
- `id`: små bokstäver a–z, siffror och `-`, högst 32 tecken (`handlaggare`, inte `Handläggare`).
  `name` är det som visas, 1–60 tecken. Högst 20 roller.
- `setDefinitions` ersätter HELA listan. En roll som inte finns med tas bort, och alla förlorar den.
- `assign`: rollerna måste vara införda (annars `invalid_request`) och personen måste vara medlem i
  appen (annars `not_found`). Den som tas bort ur appen förlorar sina roller.
- `access` är plattformens: `owner` byggde appen, `user` har fått den delad med sig. Ägaren har
  **inte** automatiskt alla roller — kontrollera `access === 'owner'` när det är ägaren som avses.
- `displayName` är e-postadressens lokala del. E-postadressen lämnas aldrig ut.
- Förhandsvisningen har egna roller, skilda från den publicerade appens.

Visa en adminvy bara för rollen `admin` (och för ägaren):

```tsx
const [jag, setJag] = useState<roles.Me | null>(null);
useEffect(() => { roles.me().then(setJag); }, []);

const arAdmin = jag !== null && (jag.access === 'owner' || jag.roles.includes('admin'));
return <>{arAdmin && <Installningar />}<Arenden /></>;
```

Rullista "tilldela till" med medlemmarnas namn — spara `userId`, visa `displayName`:

```tsx
const [medlemmar, setMedlemmar] = useState<roles.Member[]>([]);
useEffect(() => { roles.members().then(setMedlemmar); }, []);

const handlaggare = medlemmar.filter((m) => m.roles.includes('handlaggare'));
<select value={arende.tilldelad ?? ''} onChange={(e) => spara({ ...arende, tilldelad: e.target.value })}>
  <option value="">Ingen</option>
  {handlaggare.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
</select>
```

Ägaren inför rollerna appen behöver första gången appen öppnas (andra hoppar över):

```ts
const jag = await roles.me();
if (jag.access === 'owner' && (await roles.definitions()).length === 0) {
  await roles.setDefinitions([{ id: 'handlaggare', name: 'Handläggare' }, { id: 'admin', name: 'Admin' }]);
}
```
