#!/usr/bin/env bash
# backup.sh — säkerhetskopierar plattformens data och driftens compose-filer på värden.
#
# Installeras som /usr/local/sbin/vibesandbox-backup (se infra/README.md, "Säkerhetskopiering").
# Körs som root på driftvärden. ops kan INTE köra den utan sudo: datat ägs av DATA_UID
# (110001 med standardvärdena) och ingen annan än root kommer åt det.
#
#   vibesandbox-backup [--dry-run] [--behall N]
#
# Resultatet är en katalog under ${PLATFORM_ROOT}/backups/<tidsstämpel>/:
#
#   databaser/…   en konsekvent kopia av varje SQLite-fil, verifierad med integrity_check
#   filer/        uppladdningarna och allt annat under data/ som inte är en databas
#   compose/      compose-filerna och .env  (se "Hemligheter" nedan)
#   manifest      vad som ingick, vilken version som kördes, och integritetsresultaten
#
# Tre saker avgör om det här är en säkerhetskopia eller bara en förhoppning:
#
#   1. INGEN 'cp' AV EN LEVANDE SQLITE-DATABAS. Plattformen kör i WAL-läge: de senaste
#      transaktionerna ligger i <db>-wal och sidcachen samordnas via <db>-shm. En rå kopia
#      fångar filerna vid olika tidpunkter och ger en databas som i bästa fall är gammal och i
#      värsta fall inte går att öppna — och felet syns först när någon försöker återställa.
#      Kopian görs därför av SQLite självt (VACUUM INTO), som tar en läslåsning, skriver en
#      färdigcheckpointad fil och inte hindrar plattformen från att fortsätta skriva.
#   2. VARJE KOPIA VERIFIERAS med PRAGMA integrity_check innan den räknas. En säkerhetskopia
#      som inte går att öppna är värre än ingen alls: den invaggar i trygghet och upptäcks den
#      dag allt annat redan är borta.
#   3. BACKUPKATALOGEN BYTER NAMN FÖRST NÄR ALLT ÄR KLART. Arbetet sker i .ofullstandig och
#      flyttas på plats när manifestet är skrivet. En avbruten körning (Ctrl-C, strömavbrott,
#      full disk) kan alltså inte lämna efter sig något som ser ut som en färdig backup.
#
# Hemligheter: compose/.env FÖLJER MED. Skälet och priset står vid ENV_BESLUT nedan.
#
# Fristående: läser bara ${VIBESANDBOX_STATE:-/etc/vibesandbox/provision.state} (samma fil som
# verify.sh) och har i övrigt fasta sökvägar. Inga hemligheter, adresser eller nycklar i filen.

set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Allt som skapas här innehåller antingen allas data eller driftens hemligheter ⇒ 0700/0600,
# ägt av root. umask sätter det från början i stället för att rätta till det efteråt.
umask 077

readonly MANIFEST_VERSION=1
# Tidsstämpeln är också katalognamnet, och det mönstret är det enda rotationen rör. En katalog
# som någon har lagt dit för hand (eller vår egen .ofullstandig) tas därför aldrig bort.
readonly KATALOGMONSTER='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z(-[0-9]+)?$'
readonly PLATTFORMSBILD="${PLATTFORMSBILD:-vibesandbox-platform:lokal}"

DRY_RUN=0
BEHALL="${BEHALL_BACKUPER:-7}"

# ── Utskrift ───────────────────────────────────────────────────────────────────────────────
# Samma språk som provision.sh: ==> steg, → gör, ✓ klart, ! varning, ✗ avbrott.

rubrik() { printf '\n==> %s\n' "$*"; }
klart()  { printf '  ✓ %s\n' "$*"; }
gor()    { printf '  → %s\n' "$*"; }
varna()  { printf '  ! %s\n' "$*" >&2; }
avbryt() { printf '\n✗ AVBRUTET: %s\n' "$*" >&2; exit 1; }
vagra()  { printf '\n✗ VÄGRAR: %s\n' "$*" >&2; exit 2; }

har_kommando() { command -v "$1" >/dev/null 2>&1; }

anvandning() {
  cat <<'EOF'
Användning: backup.sh [flaggor]

  --dry-run        Säg vad som skulle säkras, ändra ingenting.
  --behall <N>     Behåll de N nyaste säkerhetskopiorna (minst 1, standard 7).
                   Går också att sätta med BEHALL_BACKUPER.
  --hjalp          Den här texten.

Körs som root på en värd som provision.sh har förberett. Återställning: restore.sh.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --behall) shift; BEHALL="${1:-}" ;;
    --hjalp | -h) anvandning; exit 0 ;;
    *) printf 'okänd flagga: %s\n\n' "$1" >&2; anvandning >&2; exit 2 ;;
  esac
  shift
done

[[ "$BEHALL" =~ ^[0-9]+$ ]] || vagra "--behall måste vara ett heltal (är '${BEHALL}')."
(( 10#$BEHALL >= 1 )) || vagra "--behall måste vara minst 1 — en rotation som raderar allt är inte en rotation."
BEHALL=$(( 10#$BEHALL ))

# ── Vilken värd, och får vi köra här? ──────────────────────────────────────────────────────

# Samma fil, samma idiom som verify.sh: provision.sh skriver den, och varje värde i den är
# redan validerat där. Saknas filen har provision.sh inte körts — och då är det här inte en
# driftvärd, hur mycket katalogerna än må likna en.
las_tillstand() {
  local fil="${VIBESANDBOX_STATE:-/etc/vibesandbox/provision.state}"
  [[ -f "$fil" && ! -L "$fil" ]] \
    || vagra "hittar inte ${fil} — har provision.sh körts på den här värden?"
  # shellcheck disable=SC1090
  . "$fil"
  PLATFORM_ROOT="${PLATFORM_ROOT:-/srv/vibesandbox}"
  DATA_USER="${DATA_USER:-vibesandbox}"
  DATA_UID="${DATA_UID:-110001}"
  DOCKREMAP_SUBID_BASE="${DOCKREMAP_SUBID_BASE:-100000}"
  # Uid:t INNE i plattformens container. Värdens uid är basen plus det; det är den räkningen
  # som gör att en säkerhetskopia går att lägga tillbaka på en ny värd utan chown (se README,
  # "Flytt till en ny värd"). Vi behöver det åt andra hållet: vilket uid containern ska köra som
  # för att komma åt data som på värden ägs av DATA_UID.
  CONTAINER_UID=$(( DATA_UID - DOCKREMAP_SUBID_BASE ))
}

(( EUID == 0 )) || vagra "måste köras som root. Datat ägs av plattformens uid och ingen annan kommer åt det — därav sudo."
las_tillstand

DATA="${PLATFORM_ROOT}/data"
COMPOSE="${PLATFORM_ROOT}/compose"
BACKUPS="${PLATFORM_ROOT}/backups"

[[ -d "$DATA" && ! -L "$DATA" ]] || vagra "${DATA} finns inte (eller är en länk) — det här är ingen driftvärd."
[[ -d "$BACKUPS" && ! -L "$BACKUPS" ]] || vagra "${BACKUPS} finns inte (eller är en länk) — kör provision.sh:s steg 'kataloger' först."
lage_backups="$(stat -c '%a %u:%g' "$BACKUPS")"
[[ "$lage_backups" == "700 0:0" ]] \
  || vagra "${BACKUPS} har ${lage_backups}, ska ha 700 0:0. En backupkatalog som någon annan kan läsa är en läcka, inte en backup."

agare_data="$(stat -c '%u' "$DATA")"
if [[ "$agare_data" != "$DATA_UID" ]]; then
  varna "${DATA} ägs av uid ${agare_data}, förväntade ${DATA_UID} (${DATA_USER}). Säkerhetskopian tas ändå — men se efter varför."
fi

# ── Körtid för SQLite ──────────────────────────────────────────────────────────────────────
#
# Värden har ingen sqlite3 som standard (provision.sh installerar den inte), så kopieringen
# måste kunna göras med det som faktiskt finns. Tre körtider, i den här ordningen:
#
#   sqlite3   om någon har installerat den: snabbast, inget containerstart.
#   docker    plattformsbilden kör Node 24 med node:sqlite — samma SQLite som SKREV filerna,
#             och den enda körtid som garanterat finns på en värd som kör vibesandbox.
#   python3   sista utväg. Debian har alltid python3 (cloud-init kräver det) och dess
#             sqlite3-modul är samma bibliotek. Det är också den enda av de tre som går att
#             köra i testcontainern, som varken har sqlite3, Node eller Docker.
#
# Vilken som användes antecknas i manifestet: den dag en kopia visar sig vara trasig vill man
# veta vad som gjorde den.
valj_sqlite_korning() {
  if har_kommando sqlite3; then
    SQLITE_KORNING="sqlite3"
  elif har_kommando docker && docker image inspect "$PLATTFORMSBILD" >/dev/null 2>&1; then
    SQLITE_KORNING="docker:${PLATTFORMSBILD}"
  elif har_kommando python3 && python3 -c 'import sqlite3' >/dev/null 2>&1; then
    SQLITE_KORNING="python3"
  else
    avbryt "hittar ingen körtid för SQLite (varken sqlite3, ${PLATTFORMSBILD} i Docker eller python3). Utan en av dem går det inte att ta en konsekvent kopia — och en rå cp är inte ett alternativ."
  fi
}

# Arbetaren: läser rader "<relativ källa>\t<relativt mål>" på stdin, kopierar med VACUUM INTO,
# öppnar kopian och kör PRAGMA integrity_check, och skriver "<resultat>\t<relativt mål>".
# Kopiering och kontroll hör ihop i samma vända — en kopia som inte har kontrollerats får
# aldrig hinna räknas som en backup.
#
# Källan öppnas för skrivning trots att VACUUM INTO bara läser: en läsare av en WAL-databas
# måste kunna skapa och uppdatera <db>-shm. En skrivskyddad öppning skulle misslyckas på just
# de databaser som ingen råkar ha rört sedan uppstarten.
readonly NODE_ARBETARE='
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const [kallbas, malbas] = process.argv.slice(1);
const citera = (s) => "\x27" + s.replaceAll("\x27", "\x27\x27") + "\x27";
for (const rad of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
  const [k, m] = rad.split("\t");
  let svar;
  try {
    const kalla = new DatabaseSync(kallbas + "/" + k);
    kalla.exec("VACUUM INTO " + citera(malbas + "/" + m));
    kalla.close();
    const kopia = new DatabaseSync(malbas + "/" + m, { readOnly: true });
    svar = kopia.prepare("PRAGMA integrity_check").get().integrity_check;
    kopia.close();
  } catch (e) { svar = "FEL: " + e.message; }
  process.stdout.write(String(svar).split("\n")[0] + "\t" + m + "\n");
}
'
readonly PYTHON_ARBETARE='
import os, sqlite3, sys
kallbas, malbas = sys.argv[1], sys.argv[2]
for rad in sys.stdin.read().splitlines():
    if not rad:
        continue
    k, m = rad.split("\t")
    try:
        kalla = sqlite3.connect(os.path.join(kallbas, k))
        kalla.execute("VACUUM INTO ?", (os.path.join(malbas, m),))
        kalla.close()
        kopia = sqlite3.connect(os.path.join(malbas, m))
        svar = kopia.execute("PRAGMA integrity_check").fetchone()[0]
        kopia.close()
    except Exception as e:
        svar = "FEL: %s" % e
    sys.stdout.write("%s\t%s\n" % (str(svar).splitlines()[0], m))
'

# kor_arbetare <källbas> <målbas> — jobblistan på stdin, resultaten på stdout.
kor_arbetare() {
  local kallbas="$1" malbas="$2"
  case "$SQLITE_KORNING" in
    sqlite3)
      local k m svar mal citerat
      while IFS=$'\t' read -r k m; do
        [[ -n "$k" ]] || continue
        mal="${malbas}/${m}"
        # Sökvägen går in i SQL-texten (VACUUM INTO tar ett uttryck, inte en parameter, i skalet).
        # Ett enkelcitat i ett filnamn dubbleras, så att det aldrig kan avsluta strängen.
        citerat="${mal//\'/\'\'}"
        if svar="$(sqlite3 "${kallbas}/${k}" "VACUUM INTO '${citerat}'" 2>&1)" \
          && svar="$(sqlite3 "$mal" 'PRAGMA integrity_check' 2>&1)"; then
          printf '%s\t%s\n' "${svar%%$'\n'*}" "$m"
        else
          printf 'FEL: %s\t%s\n' "${svar%%$'\n'*}" "$m"
        fi
      done
      ;;
    docker:*)
      # Containern får INGET nät, inga förmågor och inga hemligheter — bara de två katalogerna.
      # Den körs som plattformens uid i containern, vilket under userns-remap är DATA_UID på
      # värden: exakt de rättigheter som behövs för att läsa datat, och inte en enda mer.
      # Datakatalogen monteras skrivbar eftersom en WAL-läsare behöver kunna röra <db>-shm.
      docker run --rm -i --network none --cap-drop ALL --security-opt no-new-privileges:true \
        --pids-limit 64 --user "${CONTAINER_UID}:${CONTAINER_UID}" \
        -v "${kallbas}:/data" -v "${malbas}:/ut" \
        "${SQLITE_KORNING#docker:}" node -e "$NODE_ARBETARE" /data /ut
      ;;
    python3)
      python3 -c "$PYTHON_ARBETARE" "$kallbas" "$malbas"
      ;;
    *) avbryt "okänd SQLite-körtid '${SQLITE_KORNING}'." ;;
  esac
}

# ── Vad ska med? ───────────────────────────────────────────────────────────────────────────

# Databaserna räknas INTE upp i en lista här. Plattformen får nya tjänster, och varje ny
# tjänst tar med sig en ny .sqlite-fil; en handskriven lista hade tyst missat den och felet
# hade upptäckts först vid en återställning. Vi letar i stället upp dem — och manifestet
# redovisar vad som faktiskt hittades, så att en databas som försvinner går att se.
hitta_databaser() {
  find "$DATA" -xdev -type f -name '*.sqlite' -printf '%P\n' 2>/dev/null | LC_ALL=C sort
}

rubrik "Säkerhetskopiering av ${PLATFORM_ROOT}"
valj_sqlite_korning
klart "SQLite-körtid: ${SQLITE_KORNING}"

mapfile -t DATABASER < <(hitta_databaser)
if (( ${#DATABASER[@]} == 0 )); then
  varna "hittar ingen *.sqlite under ${DATA} — värden har antagligen aldrig kört plattformen."
fi

APP_VERSION="okand"
if [[ -f "${COMPOSE}/app/VERSION" ]]; then
  # Samma tvätt som rotsteget i driftsättningen gör: versionen är text från en fil på disk och
  # hamnar i manifestet, inte i något som tolkar den.
  APP_VERSION="$(tr -cd 'A-Za-z0-9._-' <"${COMPOSE}/app/VERSION" | cut -c1-40)"
  [[ -n "$APP_VERSION" ]] || APP_VERSION="okand"
fi

TIDPUNKT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAMN="$(date -u +%Y-%m-%dT%H%M%SZ)"
ARB="${BACKUPS}/.ofullstandig"

# ── Torrkörning ────────────────────────────────────────────────────────────────────────────

if (( DRY_RUN )); then
  rubrik "Torrkörning — ingenting skrivs"
  printf '  [dry-run] skulle skapa %s/%s\n' "$BACKUPS" "$NAMN"
  for db in "${DATABASER[@]}"; do
    printf '  [dry-run] VACUUM INTO + integrity_check: %s\n' "$db"
  done
  printf '  [dry-run] skulle kopiera filerna under %s (allt som inte är en databas)\n' "$DATA"
  if [[ -d "$COMPOSE" ]]; then
    printf '  [dry-run] skulle kopiera %s, inklusive .env med driftens hemligheter\n' "$COMPOSE"
  fi
  mapfile -t BEFINTLIGA < <(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' 2>/dev/null \
    | grep -E "$KATALOGMONSTER" | LC_ALL=C sort -r || true)
  printf '  [dry-run] %d säkerhetskopior finns; efter rotationen skulle %d finnas kvar\n' \
    "${#BEFINTLIGA[@]}" "$(( BEHALL < ${#BEFINTLIGA[@]} + 1 ? BEHALL : ${#BEFINTLIGA[@]} + 1 ))"
  printf '\n  %d databaser, körtid %s. Ingenting ändrat.\n' "${#DATABASER[@]}" "$SQLITE_KORNING"
  exit 0
fi

# ── Arbetskatalogen ────────────────────────────────────────────────────────────────────────
# En tidigare körning kan ha dött mitt i. Det som ligger i .ofullstandig är då per definition
# ofullständigt och får inte blandas ihop med den här körningen.
if [[ -e "$ARB" ]]; then
  varna "en tidigare, avbruten körning lämnade ${ARB} — den kastas."
  rm -rf -- "$ARB"
fi
# Varje väg ut ur skriptet städar bort arbetskatalogen. Halvfärdigt arbete ska inte ligga kvar
# och se ut som något man kan återställa ifrån.
STADA_ARB=1
stada() { (( STADA_ARB )) && [[ -n "${ARB:-}" ]] && rm -rf -- "$ARB"; return 0; }
trap stada EXIT

install -d -m 0700 -o 0 -g 0 "$ARB" "${ARB}/databaser"

# ── Databaserna ────────────────────────────────────────────────────────────────────────────

rubrik "Databaser — konsekvent kopia (VACUUM INTO) och integritetskontroll"
JOBB=""
for db in "${DATABASER[@]}"; do
  install -d -m 0700 -o 0 -g 0 "${ARB}/databaser/$(dirname "$db")"
  JOBB+="${db}"$'\t'"${db}"$'\n'
done

# Docker-körtiden arbetar som DATA_UID och kan inte skriva i en rootägd 0700-katalog. Målet
# lånas ut under själva kopieringen och tas tillbaka direkt efteråt. Katalogen ligger inuti
# backups/ (0700 root), så ingen utanför root kan nå den ens medan den är utlånad.
if [[ "$SQLITE_KORNING" == docker:* ]] && (( ${#DATABASER[@]} > 0 )); then
  chown -R "${DATA_UID}:${DATA_UID}" "${ARB}/databaser"
fi

RESULTAT=""
if (( ${#DATABASER[@]} > 0 )); then
  RESULTAT="$(printf '%s' "$JOBB" | kor_arbetare "$DATA" "${ARB}/databaser")" \
    || avbryt "kopieringen av databaserna misslyckades (körtid ${SQLITE_KORNING}). Ingen säkerhetskopia skrevs."
fi

if [[ "$SQLITE_KORNING" == docker:* ]] && (( ${#DATABASER[@]} > 0 )); then
  chown -R 0:0 "${ARB}/databaser"
fi
chmod -R u=rwX,go= "${ARB}/databaser"

# Varje databas ska ha en rad, och varje rad ska säga "ok". Allt annat — ett saknat svar, ett
# svar vi inte känner igen, en kopia som inte finns — är ett fel, inte en varning.
MANIFESTRADER=""
ANTAL_OK=0
FEL_DB=()
for db in "${DATABASER[@]}"; do
  svar="$(printf '%s\n' "$RESULTAT" | awk -F'\t' -v m="$db" '$2 == m { print $1; exit }')"
  kopia="${ARB}/databaser/${db}"
  if [[ "$svar" != "ok" ]]; then
    FEL_DB+=("${db}: ${svar:-inget svar från körtiden}")
    continue
  fi
  if [[ ! -s "$kopia" ]]; then
    FEL_DB+=("${db}: kopian saknas eller är tom trots 'ok'")
    continue
  fi
  summa="$(sha256sum "$kopia" | cut -d' ' -f1)"
  MANIFESTRADER+="databas ${summa} ok $(stat -c '%s' "$kopia") ${db}"$'\n'
  ANTAL_OK=$(( ANTAL_OK + 1 ))
  klart "${db} — ok ($(stat -c '%s' "$kopia") byte)"
done

if (( ${#FEL_DB[@]} > 0 )); then
  for r in "${FEL_DB[@]}"; do varna "$r"; done
  avbryt "${#FEL_DB[@]} databas(er) gick inte att kopiera eller underkändes av integrity_check. INGEN säkerhetskopia skrevs — en halv backup är en fälla."
fi

# ── Filerna ────────────────────────────────────────────────────────────────────────────────

rubrik "Filer — uppladdningar och allt annat under data/"
install -d -m 0700 -o 0 -g 0 "${ARB}/filer"
# En vanlig kopia RÄCKER här, och det är ett medvetet val, inte slarv: en uppladdad fil skrivs
# till tmp/<nyckel>.tmp och byter namn till blobs/<nyckel> först när hela innehållet ligger på
# disk (packages/tjanst-files). Ett namn under blobs/ betyder alltså "färdigskriven", och
# innehållet ändras aldrig efteråt — det finns ingen halv fil att fånga.
#   Halvskrivna uppladdningar (*.tmp) utesluts av samma skäl: de är per definition ofullständiga,
#   och den som laddade upp dem har fått ett fel, inte en kvittens.
#   Databasernas sidofiler (-wal, -shm) utesluts därför att de hör till en databas vi redan har
#   kopierat på rätt sätt; en återställd -wal från en annan tidpunkt vore ren förgiftning.
tar -C "$DATA" \
  --exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' --exclude='*.tmp' \
  -cf - . | tar -C "${ARB}/filer" -xf - \
  || avbryt "kopieringen av filerna misslyckades. INGEN säkerhetskopia skrevs."
chown -R 0:0 "${ARB}/filer"
chmod -R u=rwX,go= "${ARB}/filer"
ANTAL_FILER="$(find "${ARB}/filer" -type f | wc -l | tr -d ' ')"
klart "${ANTAL_FILER} filer"

# ── compose/ ───────────────────────────────────────────────────────────────────────────────

# ENV_BESLUT — hör compose/.env hemma i säkerhetskopian?
#
# JA. Skälet är kravet den här katalogen finns för: "provision.sh på en ny värd + restore.sh
# ska räcka" (infra/README.md rad 3–5). Utan .env går stacken inte att starta efter en flytt
# — BASE_DOMAIN, IDENTITY_SECRET, DNS-API-nyckeln och mejlnyckeln finns ingen annanstans på
# värden — och en säkerhetskopia som kräver att någon minns var resten låg är inte en
# säkerhetskopia. Då hade restore.sh heller inte kunnat uppfylla sitt eget krav (lägg tillbaka
# data/ OCH compose/).
#
# Priset, och varför det är betalbart HÄR: backups/ är 0700 root och compose/.env är 0600
# root. Den som kan läsa säkerhetskopian kunde redan läsa originalet. Att ta med .env vidgar
# alltså ingenting så länge kopian ligger kvar på värden.
#
# Priset som INTE är betalt: i samma stund som en säkerhetskopia lämnar värden — till en NAS,
# till objektlagring, till en laptop — bär den driftens samtliga hemligheter. Den kopieringen
# gör det här skriptet inte, och ska inte göra: **allt som flyttar en backup härifrån måste
# kryptera den först.** Det står som ett öppet krav i infra/README.md.
rubrik "compose/ — driftens filer OCH hemligheter"
HAR_ENV=nej
if [[ -d "$COMPOSE" ]]; then
  # app.gammal är föregående utläggning, sparad av rotsteget för felsökning. Den är inte data
  # och går att få tillbaka ur git — den fördubblar bara backupen.
  tar -C "$COMPOSE" --exclude='./app.gammal' --exclude='./app.ny' -cf - . | tar -C "$ARB" -xf - --one-top-level=compose \
    || avbryt "kopieringen av ${COMPOSE} misslyckades. INGEN säkerhetskopia skrevs."
  chown -R 0:0 "${ARB}/compose"
  chmod -R u=rwX,go= "${ARB}/compose"
  if [[ -f "${ARB}/compose/.env" ]]; then
    HAR_ENV=ja
    klart "compose/.env följde med (0600 root) — hela säkerhetskopian ska behandlas som en hemlighet"
  else
    varna "${COMPOSE}/.env saknas — stacken går inte att starta ur den här säkerhetskopian."
  fi
else
  varna "${COMPOSE} finns inte — säkerhetskopian innehåller bara data."
fi

# ── Manifestet ─────────────────────────────────────────────────────────────────────────────

# Sist av allt, och det är manifestet som gör katalogen till en säkerhetskopia: finns det inte
# är innehållet ofullständigt. restore.sh läser det och vägrar utan det.
rubrik "Manifest"
STORLEK="$(du -sb "$ARB" | cut -f1)"
{
  printf '# vibesandbox — manifest för en säkerhetskopia. Skriven av backup.sh, läst av restore.sh.\n'
  printf '# Raderna "databas" är: databas <sha256 över kopian> <integrity_check> <byte> <sökväg under data/>\n'
  printf 'manifest_version=%s\n' "$MANIFEST_VERSION"
  printf 'tidpunkt=%s\n' "$TIDPUNKT"
  printf 'vard=%s\n' "${HOSTNAME:-okand}"
  printf 'app_version=%s\n' "$APP_VERSION"
  printf 'platform_root=%s\n' "$PLATFORM_ROOT"
  printf 'data_uid=%s\n' "$DATA_UID"
  printf 'dockremap_subid_base=%s\n' "$DOCKREMAP_SUBID_BASE"
  printf 'sqlite_korning=%s\n' "$SQLITE_KORNING"
  printf 'antal_databaser=%s\n' "$ANTAL_OK"
  printf 'antal_filer=%s\n' "$ANTAL_FILER"
  printf 'compose_env=%s\n' "$HAR_ENV"
  printf 'storlek_byte=%s\n' "$STORLEK"
  printf '%s' "$MANIFESTRADER"
} >"${ARB}/manifest"
chmod 0600 "${ARB}/manifest"
klart "manifest skrivet (version ${APP_VERSION}, ${ANTAL_OK} databaser)"

# ── Byt namn: nu — och först nu — är det en säkerhetskopia ─────────────────────────────────

MAL="${BACKUPS}/${NAMN}"
# Två körningar samma sekund ska inte skriva över varandra. Rotationens mönster tillåter suffixet.
n=2
while [[ -e "$MAL" ]]; do MAL="${BACKUPS}/${NAMN}-${n}"; n=$(( n + 1 )); done
mv -- "$ARB" "$MAL"
STADA_ARB=0
klart "${MAL}"

# ── Rotation ───────────────────────────────────────────────────────────────────────────────
# EFTER att den nya säkerhetskopian ligger på plats. En körning som misslyckas ska aldrig ha
# hunnit radera den förra — det är just då man behöver den.
rubrik "Rotation — behåller de ${BEHALL} nyaste"
mapfile -t ALLA < <(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' 2>/dev/null \
  | grep -E "$KATALOGMONSTER" | LC_ALL=C sort -r || true)
BORTTAGNA=0
for (( i = BEHALL; i < ${#ALLA[@]}; i++ )); do
  gor "tar bort ${ALLA[i]}"
  rm -rf -- "${BACKUPS:?}/${ALLA[i]}"
  BORTTAGNA=$(( BORTTAGNA + 1 ))
done
(( BORTTAGNA > 0 )) || klart "ingenting att ta bort (${#ALLA[@]} av ${BEHALL})"

# ── Sammanfattning ─────────────────────────────────────────────────────────────────────────

MANSKLIG="$(du -sh "$MAL" | cut -f1)"
rubrik "Klart"
printf '  katalog     %s\n' "$MAL"
printf '  version     %s\n' "$APP_VERSION"
printf '  databaser   %s (alla godkända av integrity_check, körtid %s)\n' "$ANTAL_OK" "$SQLITE_KORNING"
printf '  filer       %s\n' "$ANTAL_FILER"
printf '  storlek     %s (%s byte)\n' "$MANSKLIG" "$STORLEK"
printf '  rotation    %s kvar, %s borttagna\n' "$(( ${#ALLA[@]} - BORTTAGNA ))" "$BORTTAGNA"
if [[ "$HAR_ENV" == ja ]]; then
  printf '\n  ! Säkerhetskopian innehåller compose/.env. Kryptera den INNAN den lämnar värden.\n'
fi
