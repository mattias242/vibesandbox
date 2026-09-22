# shellcheck shell=bash
# Scenario 'backup' — backup.sh och restore.sh i en engångscontainer. Rör aldrig en server.
#
#   S-1  En LEVANDE WAL-databas säkras konsekvent. Beviset är hårt: en skrivare håller
#        anslutningen öppen med wal_autocheckpoint=0, så att de committade raderna ligger kvar
#        i <db>-wal. En rå 'cp' av huvudfilen får då INTE med dem — vår kopia gör det.
#   S-2  En trasig kopia räknas inte som godkänd: varken av backup.sh (som vägrar skriva en
#        halv säkerhetskopia) eller av restore.sh (sha256 OCH integrity_check, var för sig).
#   S-3  Rotationen behåller de N nyaste och rör ingenting annat i backups/.
#   S-4  --dry-run ändrar ingenting — i båda skripten, mätt på läge, ägare, tid och innehåll.
#   S-5  restore.sh vägrar mot en värd som redan har data, och lägger tillbaka rätt på en tom.
#   S-6  Rättigheterna på resultatet är 0700/0600 root — också på .env.
#   S-7  Statisk granskning: bash -n och shellcheck på båda skripten.
#
# Source:as av i-container.sh och använder dess hjälpfunktioner (godkand, underkand, pastar,
# test_rubrik, ogonblicksbild, UT/KOD). Egna namn har prefixet bk_ så att de inte krockar med
# hjälpfunktioner i de andra scenariefilerna, som source:as in i samma skal.

BK_ROT=/srv/vibesandbox
BK_DATA="${BK_ROT}/data"
BK_COMPOSE="${BK_ROT}/compose"
BK_BACKUPS="${BK_ROT}/backups"
BK_UID=110001

bk_backup()  { UT="$(bash /infra/backup.sh "$@" 2>&1)"; KOD=$?; }
bk_restore() { UT="$(bash /infra/restore.sh "$@" 2>&1)"; KOD=$?; }

# bk_om <beskrivning> <kommando…> — godkänt om kommandot lyckas; vid fel visas skriptets utdata.
bk_om() {
  local b="$1"; shift
  if "$@" >/dev/null 2>&1; then godkand "$b"; else
    underkand "$b"
    printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'
  fi
}

# Den nyaste färdiga säkerhetskopian.
bk_senaste() {
  find "$BK_BACKUPS" -mindepth 1 -maxdepth 1 -type d -name '20*Z*' | LC_ALL=C sort | tail -n 1
}

bk_antal_backuper() {
  find "$BK_BACKUPS" -mindepth 1 -maxdepth 1 -type d -name '20*Z*' | wc -l | tr -d ' '
}

# Antal rader i en SQLite-fil, eller -1 om den inte går att läsa.
bk_rader() {
  python3 - "$1" <<'PY' 2>/dev/null || echo -1
import sqlite3, sys
db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
print(db.execute("SELECT count(*) FROM post").fetchone()[0])
db.close()
PY
}

# Invarianten: summa.total ska vara exakt summan av alla post.varde. Varje transaktion skriver
# båda raderna, så en kopia som fångade halva transaktionen bryter den.
bk_invariant_haller() {
  python3 - "$1" <<'PY'
import sqlite3, sys
db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
a = db.execute("SELECT coalesce(sum(varde), 0) FROM post").fetchone()[0]
b = db.execute("SELECT total FROM summa WHERE id = 1").fetchone()[0]
db.close()
sys.exit(0 if a == b else 1)
PY
}

bk_integritet() {
  python3 - "$1" <<'PY'
import sqlite3, sys
db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
svar = db.execute("PRAGMA integrity_check").fetchone()[0]
db.close()
sys.exit(0 if svar == "ok" else 1)
PY
}

# Skapar en databas i WAL-läge med <antal> transaktioner. Stänger anslutningen, så att WAL:en
# checkpointas — den som ska ligga kvar i WAL:en skrivs av bk_starta_skrivare.
bk_skapa_db() {
  mkdir -p "$(dirname "$1")"
  python3 - "$1" "$2" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA synchronous=OFF")
db.execute("CREATE TABLE IF NOT EXISTS post (id INTEGER PRIMARY KEY, varde INTEGER, dubbel INTEGER)")
db.execute("CREATE TABLE IF NOT EXISTS summa (id INTEGER PRIMARY KEY CHECK (id = 1), total INTEGER)")
db.execute("INSERT OR IGNORE INTO summa VALUES (1, 0)")
db.commit()
for i in range(int(sys.argv[2])):
    db.execute("BEGIN")
    db.execute("INSERT INTO post (varde, dubbel) VALUES (?, ?)", (i, i * 2))
    db.execute("UPDATE summa SET total = total + ? WHERE id = 1", (i,))
    db.commit()
db.close()
PY
}

# En skrivare som håller anslutningen öppen och stänger av autocheckpoint: de rader den skriver
# blir kvar i <db>-wal, inte i huvudfilen. Sedan fortsätter den skriva en rad i taget tills
# stoppfilen finns — så att säkerhetskopian tas MEDAN någon skriver.
BK_SKRIVARSKRIPT=/tmp/bk-skrivare.py
bk_skriv_skrivarskript() {
  cat >"$BK_SKRIVARSKRIPT" <<'SKRIVARE'
import os, sqlite3, sys, time
sokvag, antal, stoppfil = sys.argv[1], int(sys.argv[2]), sys.argv[3]
db = sqlite3.connect(sokvag)
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA synchronous=OFF")
# Utan autocheckpoint flyttas ingenting fran WAL:en till huvudfilen, och anslutningen halls
# oppen - det ar exakt laget en korande plattform ar i.
db.execute("PRAGMA wal_autocheckpoint=0")
n = 0
while n < antal:
    db.execute("BEGIN")
    db.execute("INSERT INTO post (varde, dubbel) VALUES (?, ?)", (n, n * 2))
    db.execute("UPDATE summa SET total = total + ? WHERE id = 1", (n,))
    db.commit()
    n += 1
open(stoppfil + ".redo", "w").close()
while not os.path.exists(stoppfil):
    db.execute("BEGIN")
    db.execute("INSERT INTO post (varde, dubbel) VALUES (?, ?)", (n, n * 2))
    db.execute("UPDATE summa SET total = total + ? WHERE id = 1", (n,))
    db.commit()
    n += 1
    time.sleep(0.01)
db.close()
SKRIVARE
}

bk_starta_skrivare() { # <db> <antal rader som ska ligga kvar i WAL> <stoppfil>
  bk_skriv_skrivarskript
  python3 "$BK_SKRIVARSKRIPT" "$1" "$2" "$3" >/dev/null 2>&1 &
  BK_SKRIVARE=$!
  # Vänta tills skrivaren har committat sina rader — den rör <stoppfil>.redo när den är klar.
  local _
  for _ in $(seq 1 200); do [[ -e "${3}.redo" ]] && return 0; sleep 0.1; done
  return 1
}

bk_stoppa_skrivare() {
  touch /tmp/stoppa
  [[ -n "${BK_SKRIVARE:-}" ]] && wait "$BK_SKRIVARE" 2>/dev/null
  BK_SKRIVARE=""
  return 0
}

# En värd så som provision.sh lämnar den: katalogerna, ägarskapet och tillståndsfilen.
bk_forbered_vard() {
  getent group vibesandbox >/dev/null || groupadd --gid "$BK_UID" vibesandbox
  id vibesandbox >/dev/null 2>&1 || useradd --uid "$BK_UID" --gid "$BK_UID" \
    --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin vibesandbox
  install -d -m 0755 -o 0 -g 0 "$BK_ROT"
  install -d -m 0750 -o 0 -g 0 "$BK_COMPOSE"
  install -d -m 0750 -o "$BK_UID" -g "$BK_UID" "$BK_DATA"
  install -d -m 0700 -o 0 -g 0 "$BK_BACKUPS"
  install -d -m 0755 -o 0 -g 0 /etc/vibesandbox
  cat >/etc/vibesandbox/provision.state <<EOF
# Skriven av provision.sh — läses av verify.sh. Innehåller inga hemligheter.
OPS_USER=ops
PLATFORM_ROOT=${BK_ROT}
DATA_USER=vibesandbox
DATA_UID=${BK_UID}
DOCKREMAP_SUBID_BASE=100000
EOF
  chmod 644 /etc/vibesandbox/provision.state
}

# Data som liknar den riktiga: plattformens databaser, en hyresgäst, tjänsternas filer och en
# halvskriven uppladdning som INTE ska med.
bk_fyll_data() {
  bk_skapa_db "${BK_DATA}/control.sqlite" 20
  bk_skapa_db "${BK_DATA}/identity.sqlite" 5
  bk_skapa_db "${BK_DATA}/files.sqlite" 5
  bk_skapa_db "${BK_DATA}/builder/builder.sqlite" 10
  bk_skapa_db "${BK_DATA}/tenants/minapp-published/data.sqlite" 2000
  mkdir -p "${BK_DATA}/blobs" "${BK_DATA}/tmp" "${BK_DATA}/history"
  printf 'en uppladdad fil\n' >"${BK_DATA}/blobs/0123456789abcdef0123456789abcdef"
  printf 'halvskriven uppladdning\n' >"${BK_DATA}/tmp/fedcba9876543210fedcba9876543210.tmp"
  chown -R "${BK_UID}:${BK_UID}" "$BK_DATA"

  mkdir -p "${BK_COMPOSE}/app/deploy" "${BK_COMPOSE}/app.gammal"
  printf '1.4.2-test\n' >"${BK_COMPOSE}/app/VERSION"
  printf 'name: vibesandbox\n' >"${BK_COMPOSE}/app/deploy/compose.yml"
  printf 'foregaende utlaggning\n' >"${BK_COMPOSE}/app.gammal/gammal.txt"
  # Hemligheten, med samma läge som driftsättningens rotsteg ger den.
  printf 'IDENTITY_SECRET=inte-en-riktig-hemlighet\nBASE_DOMAIN=example.org\n' >"${BK_COMPOSE}/.env"
  chown -R 0:0 "$BK_COMPOSE"
  chmod 600 "${BK_COMPOSE}/.env"
}

scenario_backup() {
  # ── S-7 ────────────────────────────────────────────────────────────────────────────────────
  test_rubrik "S-7: statisk granskning av backup.sh och restore.sh"
  pastar "bash -n backup.sh" bash -n /infra/backup.sh
  pastar "bash -n restore.sh" bash -n /infra/restore.sh
  if LC_ALL=C.UTF-8 shellcheck -x /infra/backup.sh /infra/restore.sh /infra/test/scenarier/backup.sh; then
    godkand "shellcheck utan anmärkningar"
  else
    underkand "shellcheck har anmärkningar"
  fi
  # En rå kopia av en levande databas är hela felet skriptet finns för att undvika.
  pastar_inte "ingen 'cp' av något som heter .sqlite i backup.sh" grep -nE '^[^#]*\bcp\b[^|]*\.sqlite' /infra/backup.sh

  # ── Vägrar ─────────────────────────────────────────────────────────────────────────────────
  test_rubrik "backup.sh vägrar när förutsättningarna inte stämmer"
  UT="$(su nobody -s /bin/bash -c "bash /infra/backup.sh" 2>&1)"; KOD=$?
  if (( KOD == 2 )) && innehaller "$UT" "måste köras som root"; then godkand "vägrar som fel användare (kod 2)"; else underkand "kod ${KOD} som nobody"; fi

  bk_backup --behall 0
  if (( KOD == 2 )) && innehaller "$UT" "minst 1"; then godkand "vägrar --behall 0"; else underkand "--behall 0 accepterades (kod ${KOD})"; fi
  bk_backup --okand-flagga
  if (( KOD == 2 )); then godkand "vägrar okänd flagga"; else underkand "okänd flagga accepterades"; fi

  bk_backup
  if (( KOD == 2 )) && innehaller "$UT" "provision.sh"; then godkand "vägrar på en värd utan provision.state"; else underkand "kördes på en oförberedd värd (kod ${KOD})"; fi

  bk_forbered_vard
  chmod 0755 "$BK_BACKUPS"
  bk_backup
  if (( KOD == 2 )) && innehaller "$UT" "700 0:0"; then godkand "vägrar när backups/ inte är 0700 root"; else underkand "godtog en läsbar backupkatalog (kod ${KOD})"; fi
  chmod 0700 "$BK_BACKUPS"

  bk_fyll_data

  # ── S-4 (backup) ───────────────────────────────────────────────────────────────────────────
  test_rubrik "S-4: backup.sh --dry-run ändrar ingenting"
  local fore efter
  fore="$(ogonblicksbild)"
  bk_backup --dry-run
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "--dry-run avslutas med 0"; else underkand "--dry-run gav kod ${KOD}"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'; fi
  if [[ "$fore" == "$efter" ]]; then godkand "filsystemet är orört (läge, ägare, tid, innehåll)"; else underkand "--dry-run ändrade:"; diff <(echo "$fore") <(echo "$efter") | head -n 15; fi
  bk_om "…och den redovisar varje databas som skulle kopieras" innehaller "$UT" 'tenants/minapp-published/data.sqlite'

  # ── S-1 ────────────────────────────────────────────────────────────────────────────────────
  test_rubrik "S-1: en LEVANDE WAL-databas säkras konsekvent"
  rm -f /tmp/stoppa /tmp/stoppa.redo
  local levande="${BK_DATA}/control.sqlite"
  if bk_starta_skrivare "$levande" 300 /tmp/stoppa; then
    godkand "en skrivare håller anslutningen öppen med wal_autocheckpoint=0"
  else
    underkand "skrivaren kom aldrig igång"
  fi
  local rader_fore; rader_fore="$(bk_rader "$levande")"
  # Bevis A: en rå kopia av HUVUDFILEN saknar det som ligger i WAL:en. Det är precis det en
  # 'cp' hade gett — och den hade sett alldeles utmärkt ut.
  cp "$levande" /tmp/naiv-kopia.sqlite
  local rader_naiv; rader_naiv="$(bk_rader /tmp/naiv-kopia.sqlite)"

  bk_backup
  local kod_backup=$KOD
  bk_stoppa_skrivare
  if (( kod_backup == 0 )); then godkand "backup.sh avslutas med 0 medan någon skriver"; else underkand "backup.sh gav kod ${kod_backup}"; printf '%s\n' "$UT" | tail -n 20 | sed 's/^/      | /'; fi

  local kopia; kopia="$(bk_senaste)/databaser/control.sqlite"
  local rader_kopia; rader_kopia="$(bk_rader "$kopia")"
  if (( rader_naiv < rader_fore )); then
    godkand "en rå cp av huvudfilen missar WAL:en (${rader_naiv} av ${rader_fore} rader) — därav VACUUM INTO"
  else
    underkand "testets förutsättning brast: cp fick med allt (${rader_naiv}/${rader_fore})"
  fi
  if (( rader_kopia >= rader_fore )); then
    godkand "säkerhetskopian har allt som var committat (${rader_kopia} ≥ ${rader_fore} rader)"
  else
    underkand "säkerhetskopian saknar committade rader (${rader_kopia} < ${rader_fore})"
  fi
  pastar "kopian godkänns av integrity_check" bk_integritet "$kopia"
  pastar "kopian är internt konsekvent (summan stämmer med raderna)" bk_invariant_haller "$kopia"
  pastar_inte "ingen -wal ligger bredvid kopian (den är färdigcheckpointad)" test -e "${kopia}-wal"
  pastar_inte "ingen -shm heller" test -e "${kopia}-shm"
  rm -f /tmp/naiv-kopia.sqlite

  # ── Vad kom med, och vad kom inte med? ─────────────────────────────────────────────────────
  test_rubrik "Innehållet i säkerhetskopian"
  local b; b="$(bk_senaste)"
  local d
  for d in control.sqlite identity.sqlite files.sqlite builder/builder.sqlite tenants/minapp-published/data.sqlite; do
    pastar "databasen ${d} finns i kopian" test -s "${b}/databaser/${d}"
  done
  pastar "uppladdningen följde med" test -s "${b}/filer/blobs/0123456789abcdef0123456789abcdef"
  pastar_inte "en halvskriven uppladdning (*.tmp) följde INTE med" test -e "${b}/filer/tmp/fedcba9876543210fedcba9876543210.tmp"
  pastar_inte "databaserna ligger inte också under filer/" test -e "${b}/filer/control.sqlite"
  pastar_inte "inga -wal-filer under filer/" bash -c "find '${b}/filer' -name '*-wal' | grep -q ."
  pastar "compose/.env följde med" test -s "${b}/compose/.env"
  pastar "compose/app/VERSION följde med" test -s "${b}/compose/app/VERSION"
  pastar_inte "app.gammal följde INTE med" test -e "${b}/compose/app.gammal"

  test_rubrik "Manifestet"
  pastar "manifestet finns" test -s "${b}/manifest"
  pastar "det säger vilken version som kördes" grep -qx 'app_version=1.4.2-test' "${b}/manifest"
  pastar "det säger när" grep -qE '^tidpunkt=[0-9]{4}-[0-9]{2}-[0-9]{2}T' "${b}/manifest"
  pastar "det säger vilken körtid som gjorde kopiorna" grep -qE '^sqlite_korning=(sqlite3|python3|docker:)' "${b}/manifest"
  pastar "det säger att .env ingår" grep -qx 'compose_env=ja' "${b}/manifest"
  if [[ "$(grep -c '^databas ' "${b}/manifest")" == 5 ]]; then godkand "en rad per databas (5)"; else underkand "fel antal databasrader: $(grep -c '^databas ' "${b}/manifest")"; fi
  if grep -qE '^databas [0-9a-f]{64} ok [0-9]+ tenants/minapp-published/data\.sqlite$' "${b}/manifest"; then
    godkand "raden bär sha256, integritetsresultat, storlek och sökväg"
  else
    underkand "databasraden har fel form: $(grep 'data.sqlite' "${b}/manifest")"
  fi
  local summa_i_manifest summa_pa_disk
  summa_i_manifest="$(awk '$1 == "databas" && $5 == "control.sqlite" { print $2 }' "${b}/manifest")"
  summa_pa_disk="$(sha256sum "${b}/databaser/control.sqlite" | cut -d' ' -f1)"
  if [[ "$summa_i_manifest" == "$summa_pa_disk" ]]; then godkand "sha256 i manifestet stämmer med filen"; else underkand "sha256 stämmer inte"; fi
  bk_om "sammanfattningen säger vad som säkrades och hur stort det blev" innehaller "$UT" 'storlek '
  bk_om "…och varnar för att kopian innehåller hemligheter" innehaller "$UT" 'Kryptera den INNAN'

  # ── S-6 ────────────────────────────────────────────────────────────────────────────────────
  test_rubrik "S-6: rättigheterna på resultatet"
  if [[ "$(stat -c '%a %u:%g' "$b")" == "700 0:0" ]]; then godkand "backupkatalogen är 700 root:root"; else underkand "backupkatalogen har $(stat -c '%a %u:%g' "$b")"; fi
  local fel_lage
  fel_lage="$(find "$b" -type d ! -perm 700 -printf '%p %m\n'; find "$b" -type f ! -perm 600 -printf '%p %m\n')"
  if [[ -z "$fel_lage" ]]; then godkand "varje katalog är 0700 och varje fil 0600"; else underkand "fel läge:"; printf '%s\n' "$fel_lage" | head -n 5 | sed 's/^/      | /'; fi
  fel_lage="$(find "$b" ! -user root -o ! -group root)"
  if [[ -z "$fel_lage" ]]; then godkand "allt ägs av root"; else underkand "fel ägare: ${fel_lage}"; fi
  pastar_inte "ingen .ofullstandig ligger kvar" test -e "${BK_BACKUPS}/.ofullstandig"

  # ── S-3 ────────────────────────────────────────────────────────────────────────────────────
  test_rubrik "S-3: rotationen behåller de N nyaste"
  local _
  for _ in 1 2 3; do sleep 1; bk_backup --behall 2 >/dev/null; done
  if [[ "$(bk_antal_backuper)" == 2 ]]; then godkand "--behall 2 lämnar exakt 2 kvar"; else underkand "$(bk_antal_backuper) säkerhetskopior kvar, väntade 2"; fi
  local nyaste; nyaste="$(bk_senaste)"
  pastar "den nyaste finns kvar och är hel" test -s "${nyaste}/manifest"
  # Rotationen får bara röra sina egna kataloger.
  mkdir -p "${BK_BACKUPS}/handskriven"; printf 'rör mig inte\n' >"${BK_BACKUPS}/handskriven/anteckning"
  sleep 1; bk_backup --behall 1
  pastar "en katalog som inte ser ut som en säkerhetskopia rörs inte" test -s "${BK_BACKUPS}/handskriven/anteckning"
  if [[ "$(bk_antal_backuper)" == 1 ]]; then godkand "--behall 1 lämnar 1 kvar"; else underkand "$(bk_antal_backuper) kvar, väntade 1"; fi
  rm -rf "${BK_BACKUPS}/handskriven"

  # ── S-2 (backup) ───────────────────────────────────────────────────────────────────────────
  test_rubrik "S-2: backup.sh skriver INGEN säkerhetskopia när en databas inte går att kopiera"
  head -c 4096 /dev/urandom >"${BK_DATA}/trasig.sqlite"
  chown "${BK_UID}:${BK_UID}" "${BK_DATA}/trasig.sqlite"
  local antal_fore; antal_fore="$(bk_antal_backuper)"
  bk_backup
  if (( KOD != 0 )); then godkand "avslutas med fel (kod ${KOD})"; else underkand "en trasig databas gav ändå kod 0"; fi
  bk_om "…och säger vilken databas det gällde" innehaller "$UT" 'trasig\.sqlite'
  if [[ "$(bk_antal_backuper)" == "$antal_fore" ]]; then godkand "ingen ny säkerhetskopia skrevs"; else underkand "en halv säkerhetskopia lades ändå på plats"; fi
  pastar_inte "arbetskatalogen städades bort" test -e "${BK_BACKUPS}/.ofullstandig"
  rm -f "${BK_DATA}/trasig.sqlite"

  # ── S-2 (restore) ──────────────────────────────────────────────────────────────────────────
  test_rubrik "S-2: restore.sh godkänner ingen kopia som har ändrats"
  sleep 1; bk_backup --behall 3
  b="$(bk_senaste)"
  bk_restore --kontrollera "$b"
  if (( KOD == 0 )); then godkand "en orörd säkerhetskopia går igenom --kontrollera"; else underkand "en hel säkerhetskopia underkändes (kod ${KOD})"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'; fi

  # En byte mitt i en datasida: filen går fortfarande att öppna, men innehållet är trasigt.
  cp "${b}/databaser/tenants/minapp-published/data.sqlite" /tmp/hel.sqlite
  python3 -c "import sys; f=open(sys.argv[1],'r+b'); f.seek(20000); f.write(b'SKRAPSKRAP'*20); f.close()" \
    "${b}/databaser/tenants/minapp-published/data.sqlite"
  bk_restore --kontrollera "$b"
  if (( KOD == 2 )) && innehaller "$UT" 'sha256 stämmer inte'; then godkand "sha256 fångar att kopian har ändrats"; else underkand "en ändrad kopia godkändes (kod ${KOD})"; fi

  # …och om någon rättar summan i manifestet så att den stämmer med den trasiga filen, är det
  # integrity_check som är kvar. Det är den kontrollen som gör skillnad på "filen är den vi
  # skrev" och "filen går att använda".
  local ny_summa; ny_summa="$(sha256sum "${b}/databaser/tenants/minapp-published/data.sqlite" | cut -d' ' -f1)"
  sed -i "s#^databas [0-9a-f]\{64\} ok \([0-9]*\) tenants/minapp-published/data.sqlite\$#databas ${ny_summa} ok \1 tenants/minapp-published/data.sqlite#" "${b}/manifest"
  bk_restore --kontrollera "$b"
  if (( KOD == 2 )) && innehaller "$UT" 'integrity_check'; then
    godkand "integrity_check fångar den trasiga kopian även när sha256 stämmer"
  else
    underkand "en trasig men rätt summerad kopia godkändes (kod ${KOD})"
    printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'
  fi

  test_rubrik "S-2: restore.sh godkänner ingen säkerhetskopia med okända eller saknade filer"
  cp /tmp/hel.sqlite "${b}/databaser/tenants/minapp-published/data.sqlite"
  printf 'inte en databas\n' >"${b}/databaser/smuggelgods.sqlite"
  bk_restore --kontrollera "$b"
  if (( KOD == 2 )) && innehaller "$UT" 'står inte i manifestet'; then godkand "en fil som lagts till efteråt upptäcks"; else underkand "smuggelgods godtogs (kod ${KOD})"; fi
  rm -f "${b}/databaser/smuggelgods.sqlite"
  mv "${b}/manifest" /tmp/manifest.undan
  bk_restore --kontrollera "$b"
  if (( KOD == 2 )) && innehaller "$UT" 'manifest'; then godkand "utan manifest är det ingen säkerhetskopia"; else underkand "en katalog utan manifest godtogs (kod ${KOD})"; fi
  mv /tmp/manifest.undan "${b}/manifest"
  rm -f /tmp/hel.sqlite

  # Ta en ny, hel säkerhetskopia att återställa ifrån (den förra har vi mixtrat med).
  sleep 1; bk_backup --behall 3
  b="$(bk_senaste)"
  bk_restore --kontrollera "$b"
  if (( KOD == 0 )); then godkand "en ny, orörd säkerhetskopia är hel"; else underkand "kod ${KOD}"; fi

  # ── S-5 ────────────────────────────────────────────────────────────────────────────────────
  test_rubrik "S-5: restore.sh vägrar mot en värd som redan har data"
  fore="$(ogonblicksbild)"
  bk_restore "$b"
  efter="$(ogonblicksbild)"
  if (( KOD == 2 )) && innehaller "$UT" 'skriv-over'; then godkand "vägrar utan --skriv-over (kod 2)"; else underkand "skrev över en värd med data (kod ${KOD})"; fi
  if [[ "$fore" == "$efter" ]]; then godkand "…och rörde ingenting"; else underkand "något ändrades ändå:"; diff <(echo "$fore") <(echo "$efter") | head -n 10; fi

  test_rubrik "S-4: restore.sh --dry-run ändrar ingenting"
  fore="$(ogonblicksbild)"
  bk_restore --dry-run --skriv-over "$b"
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "--dry-run avslutas med 0"; else underkand "--dry-run gav kod ${KOD}"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'; fi
  if [[ "$fore" == "$efter" ]]; then godkand "filsystemet är orört"; else underkand "--dry-run ändrade:"; diff <(echo "$fore") <(echo "$efter") | head -n 15; fi

  test_rubrik "S-5: en tom, nyss provisionerad värd får tillbaka allt"
  local rader_original; rader_original="$(bk_rader "${BK_DATA}/tenants/minapp-published/data.sqlite")"
  rm -rf "${BK_DATA:?}"/* "${BK_COMPOSE:?}"/* "${BK_COMPOSE:?}"/.env
  bk_restore "$b"
  if (( KOD == 0 )); then godkand "restore.sh avslutas med 0"; else underkand "restore.sh gav kod ${KOD}"; printf '%s\n' "$UT" | tail -n 20 | sed 's/^/      | /'; fi
  bk_om "…och säger att ingen stack kördes här" innehaller "$UT" 'stack'
  for d in control.sqlite identity.sqlite files.sqlite builder/builder.sqlite tenants/minapp-published/data.sqlite; do
    pastar "${d} ligger tillbaka på sin plats" test -s "${BK_DATA}/${d}"
  done
  if [[ "$(bk_rader "${BK_DATA}/tenants/minapp-published/data.sqlite")" == "$rader_original" ]]; then
    godkand "hyresgästens data är intakt (${rader_original} rader)"
  else
    underkand "raderna stämmer inte: $(bk_rader "${BK_DATA}/tenants/minapp-published/data.sqlite") mot ${rader_original}"
  fi
  pastar "invarianten håller efter återställningen" bk_invariant_haller "${BK_DATA}/tenants/minapp-published/data.sqlite"
  pastar "uppladdningen kom tillbaka" test -s "${BK_DATA}/blobs/0123456789abcdef0123456789abcdef"
  fel_lage="$(find "$BK_DATA" ! -uid "$BK_UID" -printf '%p\n')"
  if [[ -z "$fel_lage" ]]; then godkand "allt under data/ ägs av plattformens uid (${BK_UID})"; else underkand "fel ägare:"; printf '%s\n' "$fel_lage" | head -n 5 | sed 's/^/      | /'; fi
  pastar "compose/.env kom tillbaka" test -s "${BK_COMPOSE}/.env"
  if [[ "$(stat -c '%a %u:%g' "${BK_COMPOSE}/.env")" == "600 0:0" ]]; then godkand "compose/.env är 600 root:root"; else underkand "compose/.env har $(stat -c '%a %u:%g' "${BK_COMPOSE}/.env")"; fi
  pastar "VERSION kom tillbaka" grep -qx '1.4.2-test' "${BK_COMPOSE}/app/VERSION"

  test_rubrik "Idempotens: en ny säkerhetskopia av det återställda är lika hel"
  sleep 1; bk_backup --behall 3
  if (( KOD == 0 )); then godkand "backup.sh kör igen med 0"; else underkand "kod ${KOD}"; printf '%s\n' "$UT" | tail -n 15 | sed 's/^/      | /'; fi
  bk_restore --kontrollera "$(bk_senaste)"
  if (( KOD == 0 )); then godkand "…och kopian är hel"; else underkand "kod ${KOD}"; fi
}
