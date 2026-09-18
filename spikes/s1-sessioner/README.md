# Spik S1 — sessioner & exfiltrering (så kör du om det)

Tidsboxad teknisk spik (experiment, **inte** produktionskod). Mäter origin-isolering,
kakor och webbläsarexfiltrering i **Chromium, Firefox och WebKit** via Playwright.
Resultat och rekommendationer: **[`RESULTAT.md`](./RESULTAT.md)**.

Katalogen har **egen `package.json` och egen `node_modules`** och ingår **inte** i rotens
workspaces. Inget här rör resten av repot.

## Krav
- Node ≥ 20 (testad på 26.8.1), `openssl` i PATH.
- Internet för att `npx playwright install` ska hämta webbläsarna.
- Publika wildcard-DNS mot `127.0.0.1` (inget `/etc/hosts` behövs). Verifiera:
  ```bash
  for h in app.lvh.me app--c.lvh.me bygg.lvh.me p-demo.lvh.me login.lvh.me \
           bygg.localtest.me evil.127.0.0.1.nip.io; do echo "$h -> $(dig +short $h)"; done
  ```
  Alla ska ge `127.0.0.1`. (`lvh.me` = huvudmodellen; `localtest.me` = cross-site-kontroll;
  `nip.io` = "extern" server.)

## Kör
```bash
cd spikes/s1-sessioner
npm install                                   # installerar @playwright/test i egen node_modules
npx playwright install chromium firefox webkit
./gen-cert.sh                                 # självsignerat cert med SAN (i certs/, gitignorerad)
npx playwright test                           # kör alla tre motorer
node compile-matrix.js                        # skriver ut resultatmatrisen
```

Bara två motorer (t.ex. om Firefox inte startar på din OS — se RESULTAT.md):
```bash
npx playwright test --project=chromium --project=webkit
```

Servern manuellt (för felsökning), svarar olika per `Host`:
```bash
node server.js       # plattform på :8443, "extern" logg-server på :9443
```

## Så mäts läckage
- `server.js` startar plattformen (`login./bygg./app./app--c./p-demo.` under `lvh.me`) och en
  **"extern" server** på `evil.127.0.0.1.nip.io:9443` som **loggar allt** den tar emot.
- Testerna kör exfiltrerings-försök i den sandlådade iframen och frågar sedan externa servern
  vad som kom fram (`/_hits`). "blockeras-korrekt" = inget nådde externt.
- Resultat skrivs som JSONL till `results/matrix.jsonl`; `compile-matrix.js` gör en matris.

## Filer
| Fil | Roll |
|---|---|
| `server.js` | Plattform + "extern" logg-server (ren `node:https`) |
| `tests/spike.spec.js` | Alla mätningar (S1, A, B, C, S4) |
| `tests/global-setup.js` | Rensar `results/` före körning |
| `playwright.config.js` | 3 motorer, 1 worker, `ignoreHTTPSErrors`, startar servern |
| `gen-cert.sh` | Självsignerat cert med SAN för alla värdnamn |
| `compile-matrix.js` | JSONL → läsbar matris |
| `github-actions-forslag.yml` | **Förslag** på CI som kör alla tre motorer på Linux |

## Säkerhet
`certs/` (privata nycklar), `node_modules/`, `results/`, `test-results/` och lockfilen är
**gitignorerade**. Privata nycklar får **aldrig** committas — repot är publikt. Certet är
kortlivat (30 dagar) och självsignerat; regenerera med `./gen-cert.sh` vid behov.
