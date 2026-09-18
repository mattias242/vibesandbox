# Svarsprotokollet

Hur språkmodellen svarar agenten. Tolken finns i `src/protokoll.ts`, samma regler står i
systemprompten (`src/systemprompt.ts`) och ett fullständigt exempel på ett korrekt svar
(mallens exempelapp) ingår alltid i den.

## Formen

```
En lista där alla kan boka mötesrum och ta bort bokningar.
<vs-file path="src/App.tsx">
…HELA filens innehåll…
</vs-file>
<vs-file path="src/styles.css">
…HELA filens innehåll…
</vs-file>
<vs-done/>
```

1. **Sammanfattning** på svenska till användaren: all text utanför fil-blocken. Visas som den är.
2. **Bara ändrade filer, men alltid hela.** En fil som inte finns med är oförändrad; en fil som
   finns med ersätter den gamla i sin helhet. Filer kan inte tas bort.
3. **`<vs-done/>`** på en egen rad sist. Obligatorisk.

Taggarna gäller bara när de står **ensamma på en rad** (blanksteg runt om tolereras). En sträng
eller kommentar som nämner `<vs-file …>` i koden stör alltså inte.

## Varför så här

- **Text i stället för JSON eller verktygsanrop.** Öppna modeller gör fel i escapning av stora
  kodmängder i JSON och i verktygsanrop, men skriver text rad för rad pålitligt.
- **Hela filer i stället för diffar.** Modeller räknar fel på radnummer och kontext i diffar; en
  hel fil är lätt att kontrollera och att bygga.
- **Obligatorisk slutmarkör.** En känd bugg i vLLM ger ibland ett tomt eller avkapat svar med
  `finish_reason=stop`. Utan markören gick det inte att skilja från ett färdigt svar.

## Tolkens regler

| Fall | Utfall |
|---|---|
| `finishReason` är inte `stop` | Svaret tolkas inte alls, oavsett hur komplett det ser ut. |
| `<vs-done/>` saknas | Fel. |
| Ett block stängs aldrig (eller ett nytt öppnas innan) | Fel. |
| `</vs-file>` utanför ett block | Fel. |
| Samma sökväg två gånger | Fel. |
| Sökväg som inte klarar `isAllowedSourcePath` (t.ex. `src/main.tsx`, `src/tsconfig.json`, `../x.ts`, å/ä/ö i namnet) | Fel. `src/main.tsx` förklaras som mallens fil. |
| Fler än 30 filer, en fil över 100 kB, över 400 kB totalt (räknat i UTF-8-bytes) | Fel. |
| Inga filer alls | Fel. |
| Text (annat än tomrader och kodstaket) efter `<vs-done/>` | Fel. |
| Kodstaket (```` ``` ```` eller ```` ```tsx ````) direkt innanför ett block | Skalas bort. |
| Kodstaket runt hela svaret | Ignoreras. |
| `<think>…</think>` först i svaret | Skalas bort före tolkningen. |
| Utelämning i en fil | Fel. |

**Utelämningar** är rader som bara består av en ellips (`...`, `…`), eller kommentarer (`//`,
`/* */`, `{/* */}`, `<!-- -->`) som är en ellips, börjar med en ellips, nämner `existing code` /
`befintlig kod`, eller börjar med `rest of`, `resten av`, `samma som förut`, `oförändrad` eller
`unchanged`. Spridning (`[...lista]`), text med ellips (`<p>Hämtar …</p>`) och vanliga
kommentarer som `// Sorterar resten av listan` påverkas inte.

Alla fel samlas och skickas till modellen i nästa varv, tillsammans med de filer som gäller.

## Varven

Varje varv är tillståndslöst: meddelandena är alltid `[system, user]`. User-meddelandet består av

1. appens filer i protokollets format (för en ny app: startfilerna),
2. de senaste (högst tio) tidigare önskemålen från användaren — aldrig modellens svar,
3. det nya önskemålet,
4. i rättningsvarv: varför förra svaret inte kunde användas och/eller de högst tio viktigaste
   byggfelen (regelbrott före typfel före byggfel), trimmade, med fil och rad.

Användarens text kan aldrig bli en protokolltagg: `<vs-` skrivs om till `< vs-` i önskemål,
tidigare önskemål och felmeddelanden. Annars kunde en användare låtsas skicka en fil, eller
smyga förbi maskningen av personuppgifter (som lämnar hela fil-block orörda).

Efter ett tolkbart svar slås filerna ihop (nuvarande ⊕ ändrade) och byggs. Grönt ⇒ klart. Rött ⇒
nästa varv ber modellen rätta de sammanslagna filerna. Ett **säkerhetsbrott** i policyn (t.ex.
`external-url`) avbryter turen direkt med en förklaring i klarspråk. Efter `maxRounds` varv
(standard 4) är turen misslyckad och filerna oförändrade.
