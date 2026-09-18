# language: sv
Egenskap: En app kan inte skicka information vidare ut på internet
  Plattformen — inte appen — bestämmer vad webbläsaren får göra. Reglerna följer med
  varje svar från en apps adress och går inte att ändra av appens kod.

  Bakgrund:
    Givet att appen "bokningar" är publicerad
    Och att Anna är inloggad

  Scenario: Varje sida från en app bär plattformens skyddsregler
    När Anna öppnar startsidan för appen "bokningar"
    Så tillåter skyddsreglerna bara anslutningar till appens egen adress
    Och skyddsreglerna förbjuder inbäddade ramar, insticksobjekt och ändrad basadress
    Och formulär får bara skickas till appens egen adress

  Scenario: Även API-svar och felsidor bär skyddsreglerna
    När Anna listar kollektionen "poster" i appen "bokningar"
    Så bär svaret plattformens skyddsregler
    Och webbläsaren förbjuds gissa innehållstyp

  Scenario: En app kan inte ersätta skyddsreglerna med egna
    Givet att appens filer innehåller en sida som försöker sätta egna skyddsregler via en meta-tagg
    När Anna öppnar den sidan
    Så gäller fortfarande plattformens skyddsregler i svarshuvudet

  Scenario: Bakgrundsskript som överlever sidan tillåts inte
    När en begäran om att registrera ett bakgrundsskript kommer till appen "bokningar"
    Så får anroparen svaret "åtkomst nekad"

  @senare
  Scenario: En webbläsare stoppar appens försök att anropa en extern adress
    Givet att appens kod försöker skicka data till "https://extern.exempel"
    När Anna öppnar appen i en riktig webbläsare
    Så blockeras anropet av webbläsaren
    Och inget anrop når den externa adressen
