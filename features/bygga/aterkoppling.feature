# language: sv
Egenskap: Återkoppling på byggverktygets svar
  Den som bygger en app möter ibland ett svar som inte hjälper: verktyget kan inte det som
  efterfrågas, eller missförstår önskemålet. Då ska hon kunna säga det, och det ska nå den
  som driver plattformen — annars är signalen borta för alltid.

  Återkopplingen går till plattformens ägare via mejl, aldrig till språkmodellen. Hela
  konversationen om appen följer med, så att den som läser förstår sammanhanget. Därför får
  Anna veta det innan hon skickar.

  Bakgrund:
    Givet att Anna har en app som byggts klart

  Scenario: Anna säger till när ett svar inte hjälpte
    När Anna lämnar återkopplingen "Jag ville att den skulle läsa texten ur en PDF"
    Så får plattformens ägare ett mejl med återkopplingen
    Och mejlet innehåller konversationen om appen

  Scenario: Anna får veta vad som skickas innan hon skickar
    När Anna öppnar rutan för återkoppling
    Så står det att konversationen om appen följer med

  Scenario: Återkopplingen når aldrig språkmodellen
    När Anna lämnar återkopplingen "Verktyget förstod inte vad jag menade"
    Så innehåller inget som skickades till språkmodellen återkopplingen
    Och appens utkast är oförändrat

  Scenario: En uppskattning räknas, men stör ingen
    När Anna uppskattar ett svar
    Så får plattformens ägare inget mejl
    Och uppskattningen är räknad

  Scenario: Tom återkoppling skickas inte
    När Anna lämnar återkopplingen ""
    Så får plattformens ägare inget mejl
    Och Anna får veta att hon behöver skriva något först

  Scenario: Återkoppling om någon annans app går inte att lämna
    Givet att Bertil är inloggad i byggverktyget och får bygga
    När Bertil lämnar återkoppling om Annas app
    Så får han svaret "finns inte"
    Och plattformens ägare får inget mejl

  Scenario: Många återkopplingar på kort tid bromsas
    Givet att Anna redan lämnat återkoppling så många gånger som tillåts denna timme
    När Anna lämnar återkopplingen "En gång till"
    Så får hon veta att hon får vänta en stund
    Och plattformens ägare får inget mejl om den sista
