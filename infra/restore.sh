#!/usr/bin/env bash
# restore.sh — lägger tillbaka data/ och compose/ ur en säkerhetskopia från backup.sh.
#
# Det här är andra halvan av flyttbarhetskravet (infra/README.md rad 3–5): provision.sh på en
# NY värd + restore.sh ska räcka. Ingenting annat ska behöva göras för hand.
#
#   vibesandbox-restore [--dry-run] [--kontrollera] [--skriv-over] <backupkatalog>
#
# Fyra regler, och de är hela skriptet:
#
#   1. INGENTING SKRIVS FÖRRÄN ALLT ÄR KONTROLLERAT. Manifestet läses, varje databaskopias
#      sha256 jämförs, och varje kopia öppnas och prövas med PRAGMA integrity_check. Först
#      därefter rörs värden. Att upptäcka en trasig säkerhetskopia halvvägs in i en
#      återställning är det enda som är värre än att upptäcka den för sent.
#   2. EN VÄRD SOM REDAN HAR DATA SKRIVS INTE ÖVER. Utan --skriv-over vägrar skriptet. Med
#      flaggan FLYTTAS det gamla undan (data.fore-aterstallning-<tid>) — det raderas aldrig.
#      En återställning som tyst raderar är samma sorts fel som en backup som inte går att läsa.
#   3. STACKEN STOPPAS FÖRE OCH STARTAS EFTER. Att skriva en SQLite-fil under en plattform som
#      har den öppen ger exakt den trasiga databas vi försökte undvika. Kan stacken inte
#      stoppas görs ingenting alls, och skriptet säger varför.
#   4. MANIFESTET ÄR INDATA, INTE KOD. Det har följt med säkerhetskopian och kan komma från en
#      annan värd. Det läses rad för rad med en tillåtelselista, aldrig med '.', och varje
#      sökväg i det prövas mot ett mönster innan den används.
#
# Fristående med flit — samma skäl som angra.sh: skriptet ska fungera på en tom, nyss
# provisionerad värd dit bara infra/ har kopierats. Därför upprepar det backup.sh:s val av
# SQLite-körtid i stället för att dela kod med den.

set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

readonly MANIFEST_VERSION=1
readonly PLATTFORMSBILD="${PLATTFORMSBILD:-vibesandbox-platform:lokal}"
# Sökvägarna i manifestet pekar ut filer som ska skrivas under data/. Bara tråkiga tecken,
# ingen inledande '/', ingen '..' — en manifestrad ska aldrig kunna bestämma att något hamnar
# i /etc eller /usr.
readonly SOKVAGSMONSTER='^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'

DRY_RUN=0
SKRIV_OVER=0
BARA_KONTROLL=0
KALLA=""

rubrik() { printf '\n==> %s\n' "$*"; }
klart()  { printf '  ✓ %s\n' "$*"; }
gor()    { printf '  → %s\n' "$*"; }
varna()  { printf '  ! %s\n' "$*" >&2; }
avbryt() { printf '\n✗ AVBRUTET: %s\n' "$*" >&2; exit 1; }
vagra()  { printf '\n✗ VÄGRAR: %s\n' "$*" >&2; exit 2; }

har_kommando() { command -v "$1" >/dev/null 2>&1; }

anvandning() {
  cat <<'EOF'
Användning: restore.sh [flaggor] <backupkatalog>

  --dry-run        Kontrollera säkerhetskopian och säg vad som skulle göras. Ändrar ingenting.
  --kontrollera    Bara kontrollera säkerhetskopian (manifest, sha256, integrity_check) och
                   sluta. Rör varken värden eller stacken.
  --skriv-over     Tillåt återställning på en värd som redan har data. Det gamla flyttas
                   undan, aldrig bort.
  --hjalp          Den här texten.

Körs som root på en värd som provision.sh har förberett. Säkerhetskopior tas med backup.sh.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --kontrollera) BARA_KONTROLL=1 ;;
    --skriv-over) SKRIV_OVER=1 ;;
    --hjalp | -h) anvandning; exit 0 ;;
    -*) printf 'okänd flagga: %s\n\n' "$1" >&2; anvandning >&2; exit 2 ;;
    *) [[ -z "$KALLA" ]] || vagra "ange bara en backupkatalog."; KALLA="$1" ;;
  esac
  shift
done

[[ -n "$KALLA" ]] || { printf 'ange vilken säkerhetskopia som ska läggas tillbaka.\n\n' >&2; anvandning >&2; exit 2; }

# ── Värden ─────────────────────────────────────────────────────────────────────────────────

las_tillstand() {
  local fil="${VIBESANDBOX_STATE:-/etc/vibesandbox/provision.state}"
  [[ -f "$fil" && ! -L "$fil" ]] \
    || vagra "hittar inte ${fil} — kör provision.sh på den här värden först. En återställning lägger tillbaka data, inte en värd."
  # shellcheck disable=SC1090
  . "$fil"
  PLATFORM_ROOT="${PLATFORM_ROOT:-/srv/vibesandbox}"
  DATA_UID="${DATA_UID:-110001}"
  DOCKREMAP_SUBID_BASE="${DOCKREMAP_SUBID_BASE:-100000}"
  CONTAINER_UID=$(( DATA_UID - DOCKREMAP_SUBID_BASE ))
}

(( EUID == 0 )) || vagra "måste köras som root: datat ägs av plattformens uid, och compose/.env av root."
las_tillstand

DATA="${PLATFORM_ROOT}/data"
COMPOSE="${PLATFORM_ROOT}/compose"

[[ -d "$KALLA" && ! -L "$KALLA" ]] || vagra "${KALLA} är ingen katalog."
KALLA="$(cd "$KALLA" && pwd)"
MANIFEST="${KALLA}/manifest"
[[ -f "$MANIFEST" ]] \
  || vagra "${MANIFEST} saknas. backup.sh skriver manifestet SIST — en katalog utan det är en avbruten körning, inte en säkerhetskopia."

# ── Manifestet ─────────────────────────────────────────────────────────────────────────────

# Tillåtelselista: bara de nycklar vi känner igen, och bara första förekomsten av var och en.
manifest_varde() {
  awk -F'=' -v n="$1" '$1 == n { sub(/^[^=]*=/, ""); print; exit }' "$MANIFEST"
}

M_VERSION="$(manifest_varde manifest_version)"
[[ "$M_VERSION" == "$MANIFEST_VERSION" ]] \
  || vagra "manifestet är version '${M_VERSION}', det här skriptet läser version ${MANIFEST_VERSION}."

M_TIDPUNKT="$(manifest_varde tidpunkt)"
M_VARD="$(manifest_varde vard)"
M_APP_VERSION="$(manifest_varde app_version)"
M_PLATFORM_ROOT="$(manifest_varde platform_root)"
M_DATA_UID="$(manifest_varde data_uid)"
M_KORNING="$(manifest_varde sqlite_korning)"
M_ANTAL="$(manifest_varde antal_databaser)"
M_ENV="$(manifest_varde compose_env)"

rubrik "Säkerhetskopia ${KALLA}"
printf '  tagen       %s på %s\n' "${M_TIDPUNKT:-okänd tid}" "${M_VARD:-okänd värd}"
printf '  version     %s\n' "${M_APP_VERSION:-okänd}"
printf '  databaser   %s (kopierade med %s)\n' "${M_ANTAL:-?}" "${M_KORNING:-okänd körtid}"
printf '  compose/env %s\n' "${M_ENV:-nej}"

if [[ -n "$M_PLATFORM_ROOT" && "$M_PLATFORM_ROOT" != "$PLATFORM_ROOT" ]]; then
  varna "säkerhetskopian togs med PLATFORM_ROOT=${M_PLATFORM_ROOT}, den här värden har ${PLATFORM_ROOT}."
fi
if [[ -n "$M_DATA_UID" && "$M_DATA_UID" != "$DATA_UID" ]]; then
  # Det här är precis det README varnar för under "Flytt till en ny värd": samma
  # DOCKREMAP_SUBID_BASE och PLATFORM_CONTAINER_UID på båda värdarna, annars äger fel uid datat.
  # Vi kan chown:a — men den som ser det här har antagligen fel provision.env, och det är värre.
  varna "säkerhetskopian har data_uid=${M_DATA_UID}, den här värden ${DATA_UID}. Filerna chown:as — men kontrollera provision.env (DOCKREMAP_SUBID_BASE, PLATFORM_CONTAINER_UID) innan du litar på det."
fi

# ── Kontroll av varje databaskopia ─────────────────────────────────────────────────────────

# Samma val som backup.sh gör, och av samma skäl. Här behövs bara kontrollen, inte kopieringen.
valj_sqlite_korning() {
  if har_kommando sqlite3; then
    SQLITE_KORNING="sqlite3"
  elif har_kommando docker && docker image inspect "$PLATTFORMSBILD" >/dev/null 2>&1; then
    SQLITE_KORNING="docker:${PLATTFORMSBILD}"
  elif har_kommando python3 && python3 -c 'import sqlite3' >/dev/null 2>&1; then
    SQLITE_KORNING="python3"
  else
    vagra "hittar ingen körtid för SQLite (varken sqlite3, ${PLATTFORMSBILD} i Docker eller python3). Utan en av dem går det inte att pröva att kopiorna är hela — och en okontrollerad återställning är ingen återställning."
  fi
}

readonly NODE_KONTROLL='
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const bas = process.argv[1];
for (const m of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
  let svar;
  try {
    const db = new DatabaseSync(bas + "/" + m, { readOnly: true });
    svar = db.prepare("PRAGMA integrity_check").get().integrity_check;
    db.close();
  } catch (e) { svar = "FEL: " + e.message; }
  process.stdout.write(String(svar).split("\n")[0] + "\t" + m + "\n");
}
'
readonly PYTHON_KONTROLL='
import os, sqlite3, sys, urllib.request
bas = sys.argv[1]
for m in sys.stdin.read().splitlines():
    if not m:
        continue
    try:
        uri = "file:" + urllib.request.pathname2url(os.path.join(bas, m)) + "?mode=ro"
        db = sqlite3.connect(uri, uri=True)
        svar = db.execute("PRAGMA integrity_check").fetchone()[0]
        db.close()
    except Exception as e:
        svar = "FEL: %s" % e
    sys.stdout.write("%s\t%s\n" % (str(svar).splitlines()[0], m))
'

kor_kontroll() {
  local bas="$1"
  case "$SQLITE_KORNING" in
    sqlite3)
      local m svar
      while read -r m; do
        [[ -n "$m" ]] || continue
        # -readonly: kontrollen får inte kunna ändra säkerhetskopian den kontrollerar.
        if svar="$(sqlite3 -readonly "${bas}/${m}" 'PRAGMA integrity_check' 2>&1)"; then
          printf '%s\t%s\n' "${svar%%$'\n'*}" "$m"
        else
          printf 'FEL: %s\t%s\n' "${svar%%$'\n'*}" "$m"
        fi
      done
      ;;
    docker:*)
      # Bara läsning, inget nät, inga förmågor, och katalogen monteras skrivskyddad: en
      # säkerhetskopia som kommer utifrån får inte kunna ändras av kontrollen av den.
      docker run --rm -i --network none --cap-drop ALL --security-opt no-new-privileges:true \
        --pids-limit 64 --user "${CONTAINER_UID}:${CONTAINER_UID}" \
        -v "${bas}:/kopia:ro" "${SQLITE_KORNING#docker:}" node -e "$NODE_KONTROLL" /kopia
      ;;
    python3) python3 -c "$PYTHON_KONTROLL" "$bas" ;;
    *) avbryt "okänd SQLite-körtid '${SQLITE_KORNING}'." ;;
  esac
}

rubrik "Kontroll — sha256 och integrity_check på varje databaskopia"
valj_sqlite_korning
klart "SQLite-körtid: ${SQLITE_KORNING}"

DB_SOKVAGAR=()
DB_SUMMOR=()
AVVIKELSER=()
while read -r nyckelord summa _ _ sokvag; do
  [[ "$nyckelord" == "databas" ]] || continue
  if [[ ! "$sokvag" =~ $SOKVAGSMONSTER ]]; then
    AVVIKELSER+=("manifestet pekar ut en sökväg som inte får förekomma: '${sokvag}'")
    continue
  fi
  [[ "$summa" =~ ^[0-9a-f]{64}$ ]] || { AVVIKELSER+=("${sokvag}: manifestet har ingen giltig sha256"); continue; }
  DB_SOKVAGAR+=("$sokvag")
  DB_SUMMOR+=("$summa")
done <"$MANIFEST"

if (( ${#DB_SOKVAGAR[@]} != ${M_ANTAL:-0} )); then
  AVVIKELSER+=("manifestet säger ${M_ANTAL:-0} databaser men har ${#DB_SOKVAGAR[@]} rader")
fi

# En fil i databaser/ som INTE står i manifestet är lika illa som en som saknas: någon har
# lagt till något efteråt, och då vet vi inte vad annat som ändrats.
if [[ -d "${KALLA}/databaser" ]]; then
  while read -r funnen; do
    [[ -n "$funnen" ]] || continue
    finns=0
    for s in "${DB_SOKVAGAR[@]}"; do
      if [[ "$s" == "$funnen" ]]; then finns=1; break; fi
    done
    (( finns )) || AVVIKELSER+=("${funnen} ligger i databaser/ men står inte i manifestet")
  done < <(find "${KALLA}/databaser" -type f -printf '%P\n' 2>/dev/null | LC_ALL=C sort)
fi

ATT_KONTROLLERA=""
for i in "${!DB_SOKVAGAR[@]}"; do
  fil="${KALLA}/databaser/${DB_SOKVAGAR[i]}"
  if [[ ! -f "$fil" ]]; then
    AVVIKELSER+=("${DB_SOKVAGAR[i]}: filen saknas i säkerhetskopian")
    continue
  fi
  faktisk="$(sha256sum "$fil" | cut -d' ' -f1)"
  if [[ "$faktisk" != "${DB_SUMMOR[i]}" ]]; then
    AVVIKELSER+=("${DB_SOKVAGAR[i]}: sha256 stämmer inte med manifestet — kopian har ändrats efter att den togs")
    continue
  fi
  ATT_KONTROLLERA+="${DB_SOKVAGAR[i]}"$'\n'
done

if [[ -n "$ATT_KONTROLLERA" ]]; then
  SVAR="$(printf '%s' "$ATT_KONTROLLERA" | kor_kontroll "${KALLA}/databaser")" \
    || vagra "integritetskontrollen gick inte att köra (körtid ${SQLITE_KORNING}). Ingenting är ändrat."
  while IFS=$'\t' read -r svar m; do
    [[ -n "$m" ]] || continue
    if [[ "$svar" == "ok" ]]; then
      klart "${m} — sha256 och integrity_check ok"
    else
      AVVIKELSER+=("${m}: integrity_check säger '${svar}'")
    fi
  done <<<"$SVAR"
fi

if (( ${#AVVIKELSER[@]} > 0 )); then
  for a in "${AVVIKELSER[@]}"; do varna "$a"; done
  vagra "${#AVVIKELSER[@]} avvikelse(r) i säkerhetskopian. INGENTING har rörts på värden — en trasig säkerhetskopia ska aldrig få skriva över fungerande data."
fi
klart "${#DB_SOKVAGAR[@]} databaser godkända"

if (( BARA_KONTROLL )); then
  rubrik "Bara kontroll (--kontrollera) — värden är orörd"
  exit 0
fi

# ── Får vi skriva här? ─────────────────────────────────────────────────────────────────────

har_innehall() { [[ -d "$1" ]] && [[ -n "$(find "$1" -mindepth 1 -print -quit 2>/dev/null)" ]]; }

rubrik "Målet ${PLATFORM_ROOT}"
UPPTAGET=()
har_innehall "$DATA" && UPPTAGET+=("$DATA")
har_innehall "$COMPOSE" && UPPTAGET+=("$COMPOSE")
if (( ${#UPPTAGET[@]} > 0 )) && (( ! SKRIV_OVER )); then
  vagra "${UPPTAGET[*]} innehåller redan något. Kör om med --skriv-over om du verkligen vill lägga tillbaka OVANPÅ en värd som används — det som finns flyttas då undan, men en återställning på fel värd går inte att ångra."
fi
if (( ${#UPPTAGET[@]} > 0 )); then
  varna "--skriv-over: ${UPPTAGET[*]} flyttas undan (raderas inte)."
else
  klart "värden är tom — en ren återställning"
fi

# ── Stacken ────────────────────────────────────────────────────────────────────────────────

# Samma anrop som driftsättningens rotsteg (infra/vibesandbox-driftsatt), så att vi säkert
# talar om samma stack och inte startar en andra kopia under ett annat projektnamn.
COMPOSE_KOMMANDO=()
stack_finns() {
  har_kommando docker || return 1
  [[ -f "${COMPOSE}/app/deploy/compose.yml" && -f "${COMPOSE}/.env" ]] || return 1
  COMPOSE_KOMMANDO=(docker compose --project-name vibesandbox
    --project-directory "${COMPOSE}/app/deploy" -f "${COMPOSE}/app/deploy/compose.yml"
    --env-file "${COMPOSE}/.env")
  return 0
}
stacken_kor() {
  local ut
  ut="$("${COMPOSE_KOMMANDO[@]}" ps -q 2>/dev/null)" || return 1
  [[ -n "$ut" ]]
}

rubrik "Stacken"
STARTA_EFTERAT=0
if stack_finns && stacken_kor; then
  if (( DRY_RUN )); then
    printf '  [dry-run] skulle stoppa stacken och starta den igen efteråt\n'
    STARTA_EFTERAT=1
  else
    gor "stoppar stacken — en SQLite-fil får inte skrivas under en plattform som har den öppen"
    "${COMPOSE_KOMMANDO[@]}" down --remove-orphans \
      || avbryt "stacken gick inte att stoppa. INGENTING är återställt — att skriva under en körande plattform ger exakt den trasiga databas vi försöker undvika. Stoppa den för hand och kör om."
    stacken_kor && avbryt "stacken kör fortfarande efter 'down'. Ingenting är återställt."
    STARTA_EFTERAT=1
    klart "stacken är stoppad"
  fi
else
  klart "ingen stack kör här — inget att stoppa"
fi

# ── Återställ ──────────────────────────────────────────────────────────────────────────────

flytta_undan() {
  local katalog="$1" undan
  undan="${katalog}.fore-aterstallning-$(date -u +%Y-%m-%dT%H%M%SZ)"
  gor "flyttar undan ${katalog} → ${undan}"
  (( DRY_RUN )) && return 0
  mv -- "$katalog" "$undan"
  varna "det gamla innehållet ligger kvar i ${undan}. Ta bort det själv när du har sett att återställningen blev rätt."
}

rubrik "Lägger tillbaka data/"
if (( DRY_RUN )); then
  printf '  [dry-run] %s filer + %s databaser skulle läggas i %s och ägas av %s\n' \
    "$(find "${KALLA}/filer" -type f 2>/dev/null | wc -l | tr -d ' ')" "${#DB_SOKVAGAR[@]}" "$DATA" "${DATA_UID}:${DATA_UID}"
else
  har_innehall "$DATA" && flytta_undan "$DATA"
  install -d -m 0750 -o "$DATA_UID" -g "$DATA_UID" "$DATA"
  # Filerna först, databaserna sist: en databas som ligger på plats innan resten gör det kan
  # se ut som en färdig återställning för något som råkar starta under tiden.
  if [[ -d "${KALLA}/filer" ]]; then
    tar -C "${KALLA}/filer" -cf - . | tar -C "$DATA" -xf - \
      || avbryt "filerna gick inte att lägga tillbaka. Stacken är stoppad och det gamla ligger kvar i data.fore-aterstallning-*."
  fi
  for s in "${DB_SOKVAGAR[@]}"; do
    install -d -m 0750 -o "$DATA_UID" -g "$DATA_UID" "${DATA}/$(dirname "$s")"
    install -m 0640 -o "$DATA_UID" -g "$DATA_UID" "${KALLA}/databaser/${s}" "${DATA}/${s}"
  done
  # Allt under data/ ska ägas av plattformens uid. Kopian i säkerhetskopian ägs av root.
  chown -R "${DATA_UID}:${DATA_UID}" "$DATA"
  chmod -R u=rwX,g=rX,o= "$DATA"
  klart "${#DB_SOKVAGAR[@]} databaser och $(find "$DATA" -type f | wc -l | tr -d ' ') filer i ${DATA}"
fi

rubrik "Lägger tillbaka compose/"
if [[ ! -d "${KALLA}/compose" ]]; then
  varna "säkerhetskopian har ingen compose/ — lägg ut stacken med deploy/driftsatt.sh i stället."
elif (( DRY_RUN )); then
  printf '  [dry-run] %s skulle skrivas från säkerhetskopian (.env som 0600 root)\n' "$COMPOSE"
else
  har_innehall "$COMPOSE" && flytta_undan "$COMPOSE"
  install -d -m 0750 -o 0 -g 0 "$COMPOSE"
  tar -C "${KALLA}/compose" -cf - . | tar -C "$COMPOSE" -xf - \
    || avbryt "compose/ gick inte att lägga tillbaka. data/ är återställt; stacken är stoppad."
  chown -R 0:0 "$COMPOSE"
  # Koden läses av containrarna som andra användare än root; hemligheterna bara av root.
  # Samma uppdelning som driftsättningens rotsteg gör.
  chmod -R u=rwX,go=rX "$COMPOSE"
  chmod 0750 "$COMPOSE"
  if [[ -f "${COMPOSE}/.env" ]]; then
    chmod 0600 "${COMPOSE}/.env"
    klart "compose/.env återställd (0600 root)"
  else
    varna "säkerhetskopian saknade compose/.env — stacken går inte att starta utan den."
  fi
fi

# ── Starta igen ────────────────────────────────────────────────────────────────────────────

rubrik "Startar stacken"
if (( DRY_RUN )); then
  printf '  [dry-run] ingenting startas\n'
elif (( STARTA_EFTERAT )) && stack_finns; then
  if "${COMPOSE_KOMMANDO[@]}" up -d --remove-orphans --wait --wait-timeout 300; then
    klart "stacken kör igen"
  else
    varna "stacken startade INTE. Datat är återställt — starta för hand och läs loggarna:"
    printf '      %s up -d --wait\n' "${COMPOSE_KOMMANDO[*]}" >&2
    exit 1
  fi
else
  # En nyss provisionerad värd har inga avbilder byggda. Det är driftsättningens jobb, inte
  # vårt — och att låtsas något annat hade gjort felsökningen värre.
  klart "ingen stack startades här. Lägg ut koden och bygg avbilderna med deploy/driftsatt.sh."
fi

rubrik "Klart"
printf '  återställt   %s (tagen %s, version %s)\n' "$KALLA" "${M_TIDPUNKT:-okänd tid}" "${M_APP_VERSION:-okänd}"
printf '  databaser    %s\n' "${#DB_SOKVAGAR[@]}"
printf '  nästa steg   sudo /usr/local/sbin/vibesandbox-verify, och logga in i byggverktyget\n'
