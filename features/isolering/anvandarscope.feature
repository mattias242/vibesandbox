# language: sv
@pågår
Egenskap: En app kan hålla isär olika användares data
  Många verktyg — enkäter, egna anteckningar, tidrapporter — ska inte visa kollegors
  svar för varandra. Det går inte att lita på att genererad kod i webbläsaren sköter
  det, så plattformen gör det: en kollektion kan vara gemensam eller personlig.

  Bakgrund:
    Givet att appen "enkät" är publicerad
    Och att Anna är inloggad
    Och att Bertil är inloggad

  Scenario: Personliga dokument syns bara för den som skrev dem
    Givet att Anna har sparat dokumentet {"svar": "Ja"} i den personliga kollektionen "svar" i appen "enkät"
    När Bertil listar den personliga kollektionen "svar" i appen "enkät"
    Så är listan tom

  Scenario: Personliga dokument går inte att hämta med id av någon annan
    Givet att Anna har sparat dokumentet {"svar": "Ja"} i den personliga kollektionen "svar" i appen "enkät"
    När Bertil hämtar Annas dokument med dess id
    Så får han svaret "finns inte"

  Scenario: Personliga dokument går inte att ändra eller radera av någon annan
    Givet att Anna har sparat dokumentet {"svar": "Ja"} i den personliga kollektionen "svar" i appen "enkät"
    När Bertil försöker ersätta Annas dokument med {"svar": "Nej"}
    Så får han svaret "finns inte"
    Och Annas dokument innehåller fortfarande {"svar": "Ja"}

  Scenario: Gemensamma dokument syns för alla som får öppna appen
    Givet att Anna har sparat dokumentet {"rubrik": "Fika fredag"} i kollektionen "anslag" i appen "enkät"
    När Bertil listar kollektionen "anslag" i appen "enkät"
    Så innehåller listan ett dokument med {"rubrik": "Fika fredag"}

  Scenario: En personlig kollektion kan inte läsas som om den vore gemensam
    Givet att Anna har sparat dokumentet {"svar": "Ja"} i den personliga kollektionen "svar" i appen "enkät"
    När Bertil listar kollektionen "svar" i appen "enkät" som om den vore gemensam
    Så får han svaret "kollektionen har en annan synlighet"
