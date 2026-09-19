#!/usr/bin/env bash
# SC2029: fjärrkommandona byggs MEDVETET lokalt (sökvägar och compose-kommandot). Inga hemligheter
# går den vägen — de skickas via stdin.
# shellcheck disable=SC2029
#
# Driftsätter vibesandbox på en värd som `infra/provision.sh` har förberett.
#
#   deploy/driftsatt.sh ops@<värd>                 lägger ut den committade versionen och startar stacken
#   deploy/driftsatt.sh ops@<värd> --forsta-byggare anna@example.org
#                                                  lägger dessutom in första byggaren
#   deploy/driftsatt.sh --torrkor                  skriver bara serverns .env till en temporär katalog
#                                                  och visar vad som skulle göras — rör ingen server
#
# Körs från din egen dator, över det privata nätet (SSH enbart via tailnetet efter provisioneringen).
#
# Principer:
#   - Bara den COMMITTADE versionen läggs ut (`git archive HEAD`): aldrig ocommittade filer, .env,
#     vault/, referens/ eller något annat som bara finns lokalt.
#   - Serverns .env byggs ur den lokala .env genom en TILLÅTELSELISTA — bara de nycklar driften
#     behöver följer med. Den skickas via stdin, aldrig på en kommandorad (syns i `ps`), och blir
#     läsbar bara för root.
#   - Hemligheter skrivs aldrig ut.
#   - sudo kräver lösenord på värden, och cachen gäller bara i samma terminal. Därför läggs allt
#     först i en mellanlagring hos ops (utan sudo), och ALLT som kräver root görs sedan i EN
#     session med terminal (ssh -t): lösenordet efterfrågas en gång.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
LOKAL_ENV="${DRIFTSATT_ENV:-${REPO}/.env}"
MAL_KATALOG="/srv/vibesandbox/compose"
BAS_DOMAN="${BAS_DOMAN:-byosnow.app}"

fel() { printf 'driftsätt: %s\n' "$*" >&2; exit 1; }
steg() { printf '\n== %s\n' "$*"; }

TORRKOR=0
MAL=""
FORSTA_BYGGARE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --torrkor) TORRKOR=1 ;;
    --forsta-byggare) shift; FORSTA_BYGGARE="${1:-}"; [ -n "$FORSTA_BYGGARE" ] || fel "--forsta-byggare kräver en e-postadress." ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) fel "okänd flagga: $1" ;;
    *) [ -z "$MAL" ] || fel "ange bara ett SSH-mål."; MAL="$1" ;;
  esac
  shift
done
[ "$TORRKOR" = 1 ] || [ -n "$MAL" ] || fel "ange SSH-målet, t.ex. ops@vibesandbox (eller --torrkor)."
if [ -n "$FORSTA_BYGGARE" ] && ! [[ "$FORSTA_BYGGARE" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  fel "--forsta-byggare ska vara en e-postadress."
fi

# ── Serverns .env ────────────────────────────────────────────────────────────────────────────
# Läser värden ur den lokala .env utan att köra den som skalkod.
lokalt_varde() {
  local namn="$1"
  [ -f "$LOKAL_ENV" ] || return 0
  awk -v n="$namn" 'index($0, n "=") == 1 { v = substr($0, length(n) + 2); sub(/\r$/, "", v); gsub(/^["'\'']|["'\'']$/, "", v); print v; exit }' "$LOKAL_ENV"
}

# Skriver serverns .env på standard ut. Tillåtelselista: allt annat i den lokala .env stannar lokalt.
serverns_env() {
  local cloudflare berget mailgun acme identitet
  cloudflare="$(lokalt_varde CLOUDFLARE_API_TOKEN)"
  berget="$(lokalt_varde BERGET_API_KEY)"
  mailgun="$(lokalt_varde MAILGUN_API_KEY)"
  acme="$(lokalt_varde ACME_EMAIL)"
  [ -n "$acme" ] || acme="$(lokalt_varde ACME_MAIL)"
  identitet="$(lokalt_varde IDENTITY_SECRET)"
  local saknas=()
  [ -n "$cloudflare" ] || saknas+=(CLOUDFLARE_API_TOKEN)
  [ -n "$berget" ] || saknas+=(BERGET_API_KEY)
  [ -n "$mailgun" ] || saknas+=(MAILGUN_API_KEY)
  [ -n "$acme" ] || saknas+=(ACME_EMAIL)
  [ -n "$identitet" ] || saknas+=(IDENTITY_SECRET)
  [ ${#saknas[@]} -eq 0 ] || fel "saknas i den lokala .env: ${saknas[*]}"
  cat <<EOF
# Skriven av deploy/driftsatt.sh. Ändra i den lokala .env och kör skriptet igen.
BASE_DOMAIN=${BAS_DOMAN}
APP_DOMAIN=${BAS_DOMAN}
PUBLIC_SCHEME=https
PUBLIC_PORT=
ACME_EMAIL=${acme}
CLOUDFLARE_API_TOKEN=${cloudflare}
IDENTITY_PROVIDER=email-otp
IDENTITY_SECRET=${identitet}
MAILGUN_API_KEY=${mailgun}
MAILGUN_DOMAIN=mg.${BAS_DOMAN}
MAIL_FROM=vibesandbox <noreply@mg.${BAS_DOMAN}>
BERGET_API_KEY=${berget}
LLM_MODEL=zai-org/GLM-5.3-Flash
LLM_REASONING_EFFORT=low
DATA_ROOT=/srv/vibesandbox/data
EOF
}

# IDENTITY_SECRET finns inte från början: skapa den EN gång lokalt, så att den överlever omdriftsättning
# (byts den blir alla sessioner och koder ogiltiga).
sakerstall_identitetsnyckel() {
  [ -n "$(lokalt_varde IDENTITY_SECRET)" ] && return 0
  [ -f "$LOKAL_ENV" ] || fel "den lokala .env saknas."
  local nyckel
  nyckel="$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")"
  printf '\n# Skapad av deploy/driftsatt.sh — nyckel för inloggningens sessioner och koder. Spara även i Bitwarden.\nIDENTITY_SECRET=%s\n' "$nyckel" >>"$LOKAL_ENV"
  echo "  ny IDENTITY_SECRET skapad i den lokala .env (spara den även i Bitwarden)"
}

# ── Torrkörning ──────────────────────────────────────────────────────────────────────────────
if [ "$TORRKOR" = 1 ]; then
  steg "Torrkörning — ingen server rörs"
  UT="$(mktemp -d)"
  umask 077
  if [ -z "$(lokalt_varde IDENTITY_SECRET)" ]; then
    echo "  (IDENTITY_SECRET saknas lokalt och skulle skapas vid en riktig körning; torrkörningen använder en tillfällig)"
    LOKAL_ENV_KOPIA="$(mktemp)"; cp "$LOKAL_ENV" "$LOKAL_ENV_KOPIA"
    printf '\nIDENTITY_SECRET=%s\n' "torrkorning-$(date +%s)-minst-trettiotva-tecken-lang" >>"$LOKAL_ENV_KOPIA"
    LOKAL_ENV="$LOKAL_ENV_KOPIA"
  fi
  serverns_env >"${UT}/.env"
  echo "  serverns .env: ${UT}/.env ($(wc -l <"${UT}/.env" | tr -d ' ') rader, läge $(stat -f '%Lp' "${UT}/.env" 2>/dev/null || stat -c '%a' "${UT}/.env"))"
  echo "  nycklar: $(grep -oE '^[A-Z_]+=' "${UT}/.env" | tr -d '=' | tr '\n' ' ')"
  echo "  skulle lägga ut: $(git log -1 --format='%h %s')"
  echo "  $(git archive HEAD | tar -t | wc -l | tr -d ' ') filer i arkivet"
  exit 0
fi

# ── Riktig körning ───────────────────────────────────────────────────────────────────────────
steg "Förkontroller"
[ -z "$(git status --porcelain --untracked-files=no)" ] || echo "  obs: det finns ocommittade ändringar — de läggs INTE ut, bara $(git log -1 --format=%h)"
git fetch -q origin main 2>/dev/null || true
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main 2>/dev/null || git rev-parse HEAD)" ] || echo "  obs: HEAD är inte origin/main"
sakerstall_identitetsnyckel
serverns_env >/dev/null # avbryter om något saknas
ssh "$MAL" "test -d ${MAL_KATALOG}" || fel "${MAL_KATALOG} finns inte på värden — har provision.sh körts?"

# Mellanlagringen i ops hemkatalog (läge 700). Den innehåller serverns .env en kort stund; den
# tas bort av root-steget, och av städningen nedan om något går fel innan dess.
MELLAN='.driftsatt'
stada_mellan() { ssh "$MAL" "rm -rf ~/${MELLAN}" 2>/dev/null || true; }
trap stada_mellan EXIT

steg "Skickar $(git log -1 --format='%h %s') (utan sudo)"
git archive --format=tar HEAD | ssh "$MAL" "set -e; umask 077; rm -rf ~/${MELLAN}; mkdir ~/${MELLAN} ~/${MELLAN}/app; tar -x -C ~/${MELLAN}/app"
git rev-parse --short HEAD | ssh "$MAL" "umask 077; cat >~/${MELLAN}/VERSION"
serverns_env | ssh "$MAL" "umask 077; cat >~/${MELLAN}/env"
# Root-steget som skript: inga hemligheter i det, bara sökvägar. Bara MAL_KATALOG expanderas
# här; allt som ska tolkas på värden är skyddat med \.
# shellcheck disable=SC2087
ssh "$MAL" "umask 077; cat >~/${MELLAN}/installera.sh" <<EOF
set -eu
M="\$1"; FORSTA="\${2:-}"
K='${MAL_KATALOG}'
echo "== Lägger ut i \$K/app"
rm -rf "\$K/app.ny"; mkdir -p "\$K/app.ny"
cp -R "\$M/app/." "\$K/app.ny/"; cp "\$M/VERSION" "\$K/app.ny/VERSION"
chown -R 0:0 "\$K/app.ny"
# Mellanlagringen har umask 077 (för .env), så allt kom hit som 600/700. Koden är inte hemlig,
# och containrarna läser den som andra användare än root: läsbart för alla, skrivbart bara för
# root, körbart där det redan var körbart.
chmod -R u=rwX,go=rX "\$K/app.ny"
rm -rf "\$K/app.gammal"; if [ -d "\$K/app" ]; then mv "\$K/app" "\$K/app.gammal"; fi
mv "\$K/app.ny" "\$K/app"
echo "== Skriver serverns .env (bara root kan läsa den)"
(umask 077; cp "\$M/env" "\$K/.env.ny"); chown 0:0 "\$K/.env.ny"; chmod 600 "\$K/.env.ny"; mv -f "\$K/.env.ny" "\$K/.env"
rm -rf "\$M"
C="docker compose --project-name vibesandbox --project-directory \$K/app/deploy -f \$K/app/deploy/compose.yml --env-file \$K/.env"
echo "== Bygger och startar stacken (första gången tar det några minuter)"
\$C up -d --build --remove-orphans --wait --wait-timeout 300
sleep 5
\$C ps --format '{{.Service}}: {{.State}}' | sed 's/^/  /'
if \$C ps --format '{{.State}}' | grep -qv running; then
  echo "någon tjänst kör inte:"; \$C logs --tail 50; exit 1
fi
if [ -n "\$FORSTA" ]; then
  echo "== Lägger in första byggaren"
  \$C exec -T -e DATA_DIR=/data platform node packages/identity/src/cli.ts lagg-till "\$FORSTA" builder
fi
EOF

steg "Installerar och startar som root (sudo frågar efter ops lösenord EN gång)"
ssh -t "$MAL" "sudo sh ~/${MELLAN}/installera.sh ~/${MELLAN} $(printf '%q' "$FORSTA_BYGGARE")"
trap - EXIT

if [ "${DRIFTSATT_ROKTEST:-1}" = 0 ]; then echo; echo "Klart (röktestet överhoppat)."; exit 0; fi

steg "Röktest över HTTPS"
for _ in $(seq 1 30); do
  # Som en webbläsare som navigerar: bara då skickar plattformen vidare till inloggningen (303).
  # Ett anrop utan de huvudena räknas som API och får 401.
  kod="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Sec-Fetch-Mode: navigate' -H 'Accept: text/html' "https://bygg.${BAS_DOMAN}/" || true)"
  [ "$kod" = "303" ] && break
  sleep 5
done
if [ "$kod" = "303" ]; then
  echo "  ✓ https://bygg.${BAS_DOMAN}/ skickar till inloggningen (303)"
else
  fel "byggverktyget svarade ${kod} i stället för 303 — certifikatet kan ta en stund första gången."
fi
kod="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://bygg.${BAS_DOMAN}/_auth/login")"
if [ "$kod" = "200" ]; then echo "  ✓ inloggningssidan svarar (200)"; else fel "inloggningssidan svarade ${kod}"; fi
cert="$(echo | openssl s_client -connect "bygg.${BAS_DOMAN}:443" -servername "bygg.${BAS_DOMAN}" 2>/dev/null | openssl x509 -noout -subject -issuer 2>/dev/null | tr '\n' ' ')"
echo "  certifikat: ${cert}"

echo
echo "Klart. Byggverktyget: https://bygg.${BAS_DOMAN}/"
