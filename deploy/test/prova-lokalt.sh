#!/usr/bin/env bash
# Provkör hela driftstacken lokalt och kontrollerar det som är svårt att testa annars:
# att Caddy skickar Host oförändrat och nekar absolut mål-URL, att plattformen bara nås via
# Caddy, att plattformen bara når internet via egress-proxyn till listade värdnamn, och att
# byggarbetaren saknar nät men bygger det plattformen lämnar i jobbkatalogen.
# Kräver Docker. Städar efter sig. Kör från repots rot: deploy/test/prova-lokalt.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export BASE_DOMAIN=localtest.me ACME_EMAIL=drift@example.org CLOUDFLARE_API_TOKEN=används-inte-lokalt
TEST_IDENTITY_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")"
export TEST_IDENTITY_SECRET
# Byggverktyget är påslaget i stacken (LLM_MODEL har ett standardvärde), och då vägrar plattformen
# starta utan nyckel. Provet anropar aldrig språkmodellen, så en påhittad nyckel räcker.
export BERGET_API_KEY=prov-nyckel-som-aldrig-anvands
compose() { docker compose -p vibesandbox-prov -f compose.yml -f compose.lokal.yml "$@"; }

godkanda=0; underkanda=0
kontroll() { # namn, förväntat, faktiskt
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; godkanda=$((godkanda + 1)); else echo "  ✗ $1 — väntade $2, fick $3"; underkanda=$((underkanda + 1)); fi
}
stada() { compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap stada EXIT

echo "== Bygger och startar"
compose up -d --build --wait --wait-timeout 180 >/dev/null
sleep 3 # en tjänst som kraschar direkt hinner visa det

echo "== Alla tjänster kör"
for tjanst in caddy egress platform build-worker; do
  kontroll "$tjanst kör" running "$(compose ps --format '{{.State}}' "$tjanst" 2>/dev/null | head -1)"
done
[ "$underkanda" -eq 0 ] || { compose logs --tail 20; exit 1; }

echo "== Skapar och publicerar exempelappen"
APP=$(compose exec -T platform node apps/platform/src/cli.ts skapa-app | tail -1)
compose exec -T platform node apps/platform/src/cli.ts publicera "$APP" packages/app-template/dist >/dev/null
TOKEN=$(compose exec -T -e APP="$APP" platform node --input-type=module -e "
  const { signTestIdentity } = await import('@vibesandbox/gateway');
  process.stdout.write(signTestIdentity({ userId: 'prov-anna', email: 'anna@example.org', roles: ['builder'] }, process.env.TEST_IDENTITY_SECRET));")
URL="https://$APP.localtest.me:8443"

echo "== Genom Caddy"
kontroll "appen svarar med inloggning" 200 "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: $TOKEN" "$URL/")"
kontroll "appen nekar utan inloggning" 401 "$(curl -sk -o /dev/null -w '%{http_code}' "$URL/")"
kontroll "skyddsregler finns på svaret" 1 "$(curl -sk -D - -o /dev/null -H "Authorization: $TOKEN" "$URL/" | grep -ci '^content-security-policy:.*connect-src .self.')"
# Absolut mål-URL: Go låter URL:ens värd ersätta Host, och strict_sni_host kräver att den är
# TLS-namnet. Samma värd ⇒ exakt som en vanlig förfrågan (utan inloggning: 401, med: 200);
# annan värd ⇒ 421. Rad och Host kan alltså aldrig säga olika saker till plattformen.
kontroll "absolut mål-URL, samma värd, utan inloggning = vanlig förfrågan" 401 "$(curl -sk -o /dev/null -w '%{http_code}' --request-target "https://$APP.localtest.me:8443/" "$URL/")"
kontroll "absolut mål-URL, samma värd, med inloggning = vanlig förfrågan" 200 "$(curl -sk -o /dev/null -w '%{http_code}' --request-target "https://$APP.localtest.me:8443/" -H "Authorization: $TOKEN" "$URL/")"
kontroll "absolut mål-URL (annan värd) nekas" 421 "$(curl -sk -o /dev/null -w '%{http_code}' --request-target "http://annan.localtest.me/" -H "Authorization: $TOKEN" "$URL/")"
kontroll "Host som inte stämmer med SNI nekas" 421 "$(curl -sk -o /dev/null -w '%{http_code}' -H "Host: annan.localtest.me:8443" -H "Authorization: $TOKEN" "$URL/")"
kontroll "förfalskat X-Forwarded-Host ändrar ingenting" 200 "$(curl -sk -o /dev/null -w '%{http_code}' -H "X-Forwarded-Host: annan.localtest.me" -H "Authorization: $TOKEN" "$URL/")"

kontroll "byggverktyget svarar genom Caddy" 200 "$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: $TOKEN" "https://bygg.localtest.me:8443/_api/builder/me")"
kontroll "byggverktyget nekar skrivande anrop från en app" 403 "$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: $TOKEN" -H 'x-vibesandbox-request: 1' -H "Origin: $URL" -H 'Content-Type: application/json' --data '{}' "https://bygg.localtest.me:8443/_api/builder/apps")"
kontroll "byggverktyget skapar en app med rätt Origin" 201 "$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H "Authorization: $TOKEN" -H 'x-vibesandbox-request: 1' -H 'Origin: https://bygg.localtest.me:8443' -H 'Content-Type: application/json' --data '{}' "https://bygg.localtest.me:8443/_api/builder/apps")"

echo "== Plattformen nås bara via Caddy"
kontroll "plattformens port är inte publicerad på värden" "" "$(compose port platform 8787 2>/dev/null || true)"

echo "== Plattformens väg ut"
hamta() { compose exec -T platform node -e "fetch('$1',{signal:AbortSignal.timeout(15000)}).then(r=>console.log(r.status)).catch(()=>console.log('nekad'))"; }
kontroll "listat mål nås via proxyn (modelleverantören)" 200 "$(hamta https://api.berget.ai/v1/models)"
kontroll "olistat mål nekas" nekad "$(hamta https://example.com/)"
kontroll "utan proxyn når plattformen ingenting" nekad "$(compose exec -T -e NODE_USE_ENV_PROXY=0 platform node -e "fetch('https://example.com/',{signal:AbortSignal.timeout(8000)}).then(r=>console.log(r.status)).catch(()=>console.log('nekad'))")"
kontroll "proxyn loggar nekandet" 1 "$(compose logs egress 2>/dev/null | grep -c '"decision":"deny","host":"example.com"' | tr -d ' ' | cut -c1)"

echo "== Byggarbetaren"
kontroll "byggarbetaren har inget nätverksgränssnitt utöver loopback" lo "$(compose exec -T build-worker node -e "console.log(Object.keys(require('node:os').networkInterfaces()).join(','))")"
kontroll "byggarbetaren når ingenting" nekad "$(compose exec -T build-worker node -e "fetch('https://api.berget.ai/v1/models',{signal:AbortSignal.timeout(8000)}).then(r=>console.log(r.status)).catch(()=>console.log('nekad'))")"
kontroll "byggarbetaren har inga hemligheter i miljön" 0 "$(compose exec -T build-worker node -e "console.log(Object.keys(process.env).filter(n=>/SECRET|KEY|TOKEN|PASSWORD/i.test(n)).length)")"
# JavaScript-bitarna står i variabler med enkla citattecken: bash 3.2 (macOS) gör annars
# klammerexpansion på `{a,b}` inuti "$(… "…")"-citat.
skriv_i_avbilden='try { require("node:fs").writeFileSync("/opt/vibesandbox/packages/build/src/x.ts", ""); console.log("skrev") } catch { console.log("nekad") }'
kontroll "byggarbetaren kan inte skriva i sin avbild" nekad "$(compose exec -T build-worker node -e "$skriv_i_avbilden")"
# Plattformen lämnar ett jobb i den delade katalogen (som byggverktyget gör) och får ett bygge tillbaka.
bygg_via_jobbkatalogen='
  const { createSpoolBuildRunner, readTemplateKnowledge } = await import("@vibesandbox/build");
  const { starterFiles } = await readTemplateKnowledge("packages/app-template");
  const runner = createSpoolBuildRunner({ jobsDirectory: "/jobs", timeoutMs: 120000 });
  const resultat = await runner.build(starterFiles);
  await resultat.dispose();
  console.log(resultat.ok ? "ok" : JSON.stringify(resultat.diagnostics));'
kontroll "ett jobb från plattformen byggs av byggarbetaren" ok "$(compose exec -T platform node --input-type=module -e "$bygg_via_jobbkatalogen")"

echo
echo "Godkända: $godkanda  Underkända: $underkanda"
[ "$underkanda" -eq 0 ]
