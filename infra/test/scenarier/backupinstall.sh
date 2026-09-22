# shellcheck shell=bash
# Scenario 'backupinstall' — provision.sh installerar säkerhetskopieringen, verify.sh bevakar den.
#
# Kravet som steget finns för: provision.sh på en ny värd + restore.sh ska räcka. Det som inte
# står i ett skript finns inte efter en flytt — alltså ska backup.sh, restore.sh, sudo-regeln
# och timern läggas dit av provision.sh, inte för hand.
#
#   I-1  Installationen är idempotent: andra körningen rör ingen fil och kör inget ändrande
#        kommando (läge, ägare, tid och innehåll mäts).
#   I-2  --dry-run ändrar ingenting — varken på en tom värd eller på en installerad, och inte
#        heller när inställningarna har ändrats så att filerna SKULLE ha skrivits om.
#   I-3  Sudo-regeln prövas med visudo FÖRE bytet: underkänns kandidaten skrivs ingen fil, och
#        en regel som redan gäller står kvar orörd. (En trasig fil i sudoers.d stänger av ALL
#        sudo — då finns ingen väg tillbaka till root.)
#   I-4  Regeln för vibesandbox-driftsatt är orörd efteråt: egen fil, egen rad.
#   I-5  INSTALL_BACKUP=0 installerar ingenting och tar bort det som redan ligger där — ett
#        halvt läge (timer utan skript) är sämre än inget.
#   I-6  verify.sh fångar var och en av de nya avdrifterna: saknad fil, fel läge, ändrad regel,
#        ändrad enhet, stoppad timer, avaktiverad timer, och — det som annars aldrig upptäcks —
#        en för gammal säkerhetskopia. En aktiv timer vars körningar misslyckas ser frisk ut.
#   I-7  B7 gäller också här: ett kommando som ljuger (RÄTT utdata, fel felkod) ger aldrig ✓.
#
# Source:as av i-container.sh och använder dess hjälpfunktioner (godkand, underkand, pastar,
# ogonblicksbild, provision, verifiera, UT/KOD) samt bara/falla/sluta_falla/aldrig_ok ur
# scenarier/verify.sh. Egna namn har prefixet bi_.

BI_KMD=/usr/local/sbin/vibesandbox-backup
BI_ATERSTALL=/usr/local/sbin/vibesandbox-restore
BI_REGELFIL=/etc/sudoers.d/vibesandbox-backup
BI_TJANSTFIL=/etc/systemd/system/vibesandbox-backup.service
BI_TIMERFIL=/etc/systemd/system/vibesandbox-backup.timer
BI_DRIFTSATT_REGELFIL=/etc/sudoers.d/vibesandbox-driftsatt
BI_BACKUPS=/srv/vibesandbox/backups

# Kommandon som bara LÄSER. Allt annat i anropsloggen är en ändring.
BI_LASANDE='^(systemctl (is-enabled|is-active|list-timers|list-unit-files)|dpkg-query|tailscale (ip|status)|swapon --show[^ ]*|findmnt|ss |journalctl )'

bi_bara_lasande() { # <beskrivning>
  local andrande
  andrande="$(grep -vE "$BI_LASANDE" "$ANROP" || true)"
  if [[ -z "$andrande" ]]; then
    godkand "$1"
  else
    underkand "$1"
    head -n 8 <<<"$andrande" | sed 's/^/      | /'
  fi
}

# bi_installerat — alla fem filerna på plats med rätt ägare och läge?
bi_installerat() {
  [[ "$(stat -c '%U:%G %a' "$BI_KMD" 2>/dev/null)" == "root:root 755" ]] \
    && [[ "$(stat -c '%U:%G %a' "$BI_ATERSTALL" 2>/dev/null)" == "root:root 755" ]] \
    && [[ "$(stat -c '%U:%G %a' "$BI_REGELFIL" 2>/dev/null)" == "root:root 440" ]] \
    && [[ -f "$BI_TJANSTFIL" && -f "$BI_TIMERFIL" ]]
}

bi_inget_installerat() {
  local f
  for f in "$BI_KMD" "$BI_ATERSTALL" "$BI_REGELFIL" "$BI_TJANSTFIL" "$BI_TIMERFIL"; do
    [[ -e "$f" ]] && return 1
  done
  return 0
}

# bi_avdrift <beskrivning> <mönster i en ✗-rad> — kontrollen 'backup' ensam, så att det som
# fångas är just den nya kontrollen.
bi_avdrift() {
  bara backup
  if (( KOD == 1 )) && grep -E '✗' <<<"$UT" | grep -qE -- "$2"; then
    godkand "$1"
  else
    underkand "$1 (kod ${KOD})"
    grep -E '✗' <<<"$UT" | head -n 5 | sed 's/^/      | /'
  fi
}

bi_aterstalld() {
  bara backup
  if (( KOD == 0 )); then
    godkand "  …och 0 igen när det är rättat"
  else
    underkand "  …fortfarande avvikelse efter rättning"
    grep -E '✗' <<<"$UT" | head -n 5 | sed 's/^/      | /'
  fi
}

# Godtar kontrollen 'anvandare' våra NOPASSWD-rader? (Kontrollen larmar också om annat i det
# här scenariot — roots lösenord låses först efter ett riktigt JA i SSH-steget.)
bi_nopassword_godtas() {
  bara anvandare
  innehaller "$UT" "utom för .*vibesandbox-backup" \
    && ! grep -E '✗' <<<"$UT" | grep -qE 'lösenordsfri sudo|NOPASSWD'
}

# En färdig säkerhetskopia så som backup.sh lämnar den: katalognamn enligt mönstret, ett
# manifest i botten, och en ändringstid vi styr.
bi_lagg_kopia() { # <namn> <touch -d-uttryck>
  mkdir -p "${BI_BACKUPS}/$1"
  printf 'manifest_version=1\ntidpunkt=%s\n' "$1" >"${BI_BACKUPS}/$1/manifest"
  chmod 0600 "${BI_BACKUPS}/$1/manifest"
  touch -d "$2" "${BI_BACKUPS}/$1"
}

scenario_backupinstall() {
  forbered_vard
  lat_tailnet_session_finnas
  kor_fas1
  if (( KOD == 0 )); then godkand "förutsättning: fas 1 klar"; else underkand "fas 1 gav kod ${KOD}"; visa_vid_fel; fi

  test_rubrik "I-2: --dry-run på en värd utan säkerhetskopiering installerar ingenting"
  local fore efter
  fore="$(ogonblicksbild)"
  : >"$ANROP"
  provision --dry-run --steg kataloger --steg backup
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "dry-run avslutas med 0"; else underkand "dry-run gav kod ${KOD}"; visa_vid_fel; fi
  if [[ "$fore" == "$efter" ]]; then godkand "filsystemet är orört (läge, ägare, tid och innehåll)"; else underkand "dry-run ändrade filer:"; diff <(printf '%s\n' "$fore") <(printf '%s\n' "$efter") | head -n 10; fi
  bi_bara_lasande "bara läsande kommandon kördes"
  pastar "inget installerades" bi_inget_installerat
  if innehaller "$UT" 'skulle skapa /usr/local/sbin/vibesandbox-backup'; then godkand "torrkörningen säger vad den skulle göra"; else underkand "ingen rad om vad som skulle göras"; fi

  test_rubrik "provision.sh lägger skripten, sudo-regeln och timern på värden"
  : >"$ANROP"
  provision --steg kataloger --steg backup
  if (( KOD == 0 )); then godkand "steget avslutas med 0"; else underkand "steget gav kod ${KOD}"; visa_vid_fel; fi
  pastar "backup.sh ligger som ${BI_KMD}, identisk med repots" cmp -s /infra/backup.sh "$BI_KMD"
  pastar "restore.sh ligger som ${BI_ATERSTALL}, identisk med repots" cmp -s /infra/restore.sh "$BI_ATERSTALL"
  if [[ "$(stat -c '%U:%G %a' "$BI_KMD")" == "root:root 755" && "$(stat -c '%U:%G %a' "$BI_ATERSTALL")" == "root:root 755" ]]; then
    godkand "båda är rootägda 755 (den som kan skriva i dem blir root via sudo-regeln och timern)"
  else
    underkand "fel ägare eller läge: $(stat -c '%U:%G %a' "$BI_KMD") / $(stat -c '%U:%G %a' "$BI_ATERSTALL")"
  fi
  if [[ "$(cat "$BI_REGELFIL")" == "ops ALL=(root) NOPASSWD: ${BI_KMD}" && "$(stat -c '%U %a' "$BI_REGELFIL")" == "root 440" ]]; then
    godkand "sudo-regeln är exakt en rad i en EGEN fil, root 440"
  else
    underkand "sudo-regeln är fel: '$(cat "$BI_REGELFIL" 2>/dev/null)' ($(stat -c '%U %a' "$BI_REGELFIL" 2>/dev/null))"
  fi
  pastar "visudo godkänner hela sudoers efter installationen" visudo -cq
  if grep -q "^ExecStart=${BI_KMD} --behall 7\$" "$BI_TJANSTFIL"; then godkand "tjänsten kör backup.sh med rotationen ur provision.env"; else underkand "fel ExecStart: $(grep ExecStart "$BI_TJANSTFIL")"; fi
  if grep -q '^OnCalendar=\*-\*-\* 02:30:00$' "$BI_TIMERFIL" && grep -q '^Persistent=true$' "$BI_TIMERFIL" && grep -q '^RandomizedDelaySec=' "$BI_TIMERFIL"; then
    godkand "timern kör 02:30 med slumpfördröjning och tar igen en missad körning"
  else
    underkand "timerfilen är inte som väntat"; sed 's/^/      | /' "$BI_TIMERFIL"
  fi
  pastar "enheterna lästes in (daemon-reload)" grep -q '^systemctl daemon-reload' "$ANROP"
  pastar "timern aktiverades" grep -qE '^systemctl enable --now vibesandbox-backup\.timer' "$ANROP"

  test_rubrik "ops får köra säkerhetskopian utan lösenord — men inte återställningen"
  # Beviset är en riktig körning, inte bara 'sudo -l': --hjalp gör ingenting men går hela vägen
  # genom sudo. (-n = fråga aldrig efter lösenord; utan regeln blir det ett fel i stället.)
  pastar "ops kör säkerhetskopian genom sudo utan lösenord" su ops -c "sudo -n ${BI_KMD} --hjalp"
  pastar_inte "…men INTE återställningen: den är sällsynt och förstörande och kostar ett lösenord" su ops -c "sudo -n ${BI_ATERSTALL} --hjalp"
  pastar_inte "allt annat kräver fortfarande lösenord" su ops -c 'sudo -n true'

  test_rubrik "I-4: driftsättningens regel är orörd"
  if [[ "$(cat "$BI_DRIFTSATT_REGELFIL")" == "ops ALL=(root) NOPASSWD: /usr/local/sbin/vibesandbox-driftsatt" ]]; then
    godkand "vibesandbox-driftsatt har kvar sin egen regel, i sin egen fil"
  else
    underkand "driftsättningens regel ändrades: '$(cat "$BI_DRIFTSATT_REGELFIL" 2>/dev/null)'"
  fi
  # README ligger där från paketet; våra två filer ska vara de enda utöver den.
  if [[ "$(find /etc/sudoers.d -maxdepth 1 -type f -not -name README -printf '%f\n' | LC_ALL=C sort | paste -sd, -)" == "vibesandbox-backup,vibesandbox-driftsatt" ]]; then
    godkand "sudoers.d innehåller exakt våra två filer (en regel per fil)"
  else
    underkand "oväntade filer i sudoers.d: $(find /etc/sudoers.d -maxdepth 1 -type f -printf '%f ')"
  fi
  pastar "sudo -n -l driftsättningen: fortfarande tillåten" su ops -c 'sudo -n -l /usr/local/sbin/vibesandbox-driftsatt'

  test_rubrik "I-1: andra körningen ändrar ingenting"
  fore="$(ogonblicksbild)"
  : >"$ANROP"
  provision --steg kataloger --steg backup
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "andra körningen avslutas med 0"; else underkand "andra körningen gav kod ${KOD}"; visa_vid_fel; fi
  if [[ "$fore" == "$efter" ]]; then godkand "filsystemet är oförändrat (läge, ägare, tid och innehåll)"; else underkand "andra körningen ändrade filer:"; diff <(printf '%s\n' "$fore") <(printf '%s\n' "$efter") | head -n 10; fi
  bi_bara_lasande "inga ändrande kommandon (varken daemon-reload eller enable)"
  if grep -q '^  → ' <<<"$UT"; then underkand "utskriften visar åtgärder:"; grep '^  → ' <<<"$UT" | head -n 5 | sed 's/^/      | /'; else godkand "utskriften visar bara ✓"; fi

  test_rubrik "I-2: --dry-run på en installerad värd — också när något SKULLE ha skrivits om"
  fore="$(ogonblicksbild)"
  : >"$ANROP"
  BACKUP_TID=04:15 BACKUP_BEHALL=3 provision --dry-run --steg backup
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "dry-run avslutas med 0"; else underkand "dry-run gav kod ${KOD}"; visa_vid_fel; fi
  if [[ "$fore" == "$efter" ]]; then godkand "filsystemet är orört"; else underkand "dry-run ändrade filer:"; diff <(printf '%s\n' "$fore") <(printf '%s\n' "$efter") | head -n 10; fi
  bi_bara_lasande "bara läsande kommandon kördes"
  if innehaller "$UT" 'skulle skriva om /etc/systemd/system/vibesandbox-backup.timer'; then godkand "torrkörningen redovisar att timern skulle skrivas om"; else underkand "ingen rad om timern"; fi

  test_rubrik "I-3: sudo-regeln prövas med visudo FÖRE bytet"
  rm -f "$BI_REGELFIL"
  falla visudo tyst
  provision --steg backup
  sluta_falla visudo
  if (( KOD != 0 )) && innehaller "$UT" "visudo underkänner sudo-regeln"; then godkand "en regel som visudo underkänner skrivs ALDRIG (avbrott)"; else underkand "visudo-felet gav kod ${KOD}"; visa_vid_fel; fi
  pastar_inte "ingen fil lades i sudoers.d" test -e "$BI_REGELFIL"
  pastar "driftsättningens regel är fortfarande orörd" grep -qx "ops ALL=(root) NOPASSWD: /usr/local/sbin/vibesandbox-driftsatt" "$BI_DRIFTSATT_REGELFIL"
  provision --steg backup
  pastar "regeln kommer tillbaka när visudo fungerar igen" grep -qx "ops ALL=(root) NOPASSWD: ${BI_KMD}" "$BI_REGELFIL"
  falla visudo tyst
  OPS_USER=drift provision --steg backup
  sluta_falla visudo
  if (( KOD != 0 )) && grep -qx "ops ALL=(root) NOPASSWD: ${BI_KMD}" "$BI_REGELFIL"; then
    godkand "den regel som GÄLLER står kvar orörd när kandidaten underkänns"
  else
    underkand "den gällande regeln rördes (kod ${KOD}): '$(cat "$BI_REGELFIL" 2>/dev/null)'"
  fi

  test_rubrik "I-5: INSTALL_BACKUP=0 hoppar över allt — och städar undan det som finns"
  : >"$ANROP"
  INSTALL_BACKUP=0 provision --steg backup
  if (( KOD == 0 )); then godkand "avstängt steg avslutas med 0"; else underkand "kod ${KOD}"; visa_vid_fel; fi
  pastar "inga skript, ingen regel, inga enheter kvar" bi_inget_installerat
  pastar "timern stoppades och avaktiverades" grep -qE '^systemctl disable --now vibesandbox-backup\.timer' "$ANROP"
  pastar "driftsättningens rotsteg och regel är orörda" test -e "$BI_DRIFTSATT_REGELFIL" -a -x /usr/local/sbin/vibesandbox-driftsatt
  if innehaller "$UT" "ingen säkerhetskopiering"; then godkand "skriptet säger tydligt vad det innebär"; else underkand "ingen varning om vad avstängningen kostar"; fi
  : >"$ANROP"
  INSTALL_BACKUP=0 provision --steg backup
  if (( KOD == 0 )); then godkand "avstängt steg en gång till: fortfarande 0"; else underkand "kod ${KOD}"; fi
  bi_bara_lasande "…och inget att ta bort ⇒ inga ändrande kommandon"
  INSTALL_BACKUP=0 bara backup
  if (( KOD == 0 )) && innehaller "$UT" "INSTALL_BACKUP=0"; then godkand "verify godtar en värd utan säkerhetskopiering och säger det"; else underkand "verify gav kod ${KOD} med INSTALL_BACKUP=0"; visa_vid_fel; fi
  provision --steg backup
  pastar "…och allt kommer tillbaka med standardvärdet" bi_installerat

  test_rubrik "I-6: verify.sh — rätt läge ger 0"
  bara backup
  if (( KOD == 0 )); then godkand "verify.sh avslutas med 0 direkt efter installationen"; else underkand "verify gav kod ${KOD}"; grep -E '✗' <<<"$UT" | head -n 5 | sed 's/^/      | /'; fi
  if innehaller "$UT" "ingen säkerhetskopia än"; then godkand "…och redovisar som ⚠ att timern inte hunnit köra"; else underkand "inget besked om att det ännu saknas kopia"; fi
  # (Kontrollen 'anvandare' larmar här om roots lösenord — det låses först efter ett riktigt JA
  # i SSH-steget, som det här scenariot inte kör. Det som prövas är NOPASSWD-raderna.)
  if bi_nopassword_godtas; then godkand "NOPASSWD-regeln är ett VÄNTAT läge, inte avdrift"; else underkand "kontrollen 'anvandare' flaggade vår regel"; grep -E '✗' <<<"$UT" | head -n 5 | sed 's/^/      | /'; fi

  test_rubrik "I-6: verify.sh fångar varje avdrift"
  mv "$BI_ATERSTALL" /tmp/restore.undan
  bi_avdrift "restore.sh borttaget från värden" "vibesandbox-restore saknas"
  mv /tmp/restore.undan "$BI_ATERSTALL"; bi_aterstalld

  chmod 775 "$BI_KMD"
  bi_avdrift "backup.sh skrivbar för gruppen (vem som helst i den blir root)" "vibesandbox-backup är root:root 775"
  chmod 755 "$BI_KMD"; bi_aterstalld

  printf 'ops ALL=(root) NOPASSWD: %s, /bin/sh\n' "$BI_KMD" >"$BI_REGELFIL"
  bi_avdrift "sudo-regeln utökad med ett kommando till" "regeln i ${BI_REGELFIL}"
  printf 'ops ALL=(root) NOPASSWD: %s\n' "$BI_KMD" >"$BI_REGELFIL"; bi_aterstalld
  if bi_nopassword_godtas; then godkand "  …och kontrollen 'anvandare' godtar regeln igen"; else underkand "  kontrollen 'anvandare' flaggar fortfarande regeln"; fi

  sed -i "s/ --behall 7//" "$BI_TJANSTFIL"
  bi_avdrift "tjänstens ExecStart omskriven (rotationen bortredigerad)" "ExecStart i ${BI_TJANSTFIL}"
  provision --steg backup; bi_aterstalld

  systemctl stop vibesandbox-backup.timer
  bi_avdrift "timern stoppad (körningen sker aldrig)" "inte bland aktiva timrar"
  systemctl start vibesandbox-backup.timer; bi_aterstalld

  rm -f "${STUBBKATALOG}/tillstand/aktiverad/vibesandbox-backup.timer"
  bi_avdrift "timern avaktiverad (startar inte efter en omstart)" "ska vara enabled"
  provision --steg backup; bi_aterstalld

  test_rubrik "I-6: den kontroll som gör skillnad — en kopia som har blivit för gammal"
  bi_lagg_kopia 2026-01-31T030000Z 'now'
  bara backup
  if (( KOD == 0 )) && innehaller "$UT" "nyaste säkerhetskopian är 0 h gammal"; then godkand "en färsk säkerhetskopia ger ✓"; else underkand "färsk kopia gav kod ${KOD}"; visa_vid_fel; fi
  touch -d '3 days ago' "${BI_BACKUPS}/2026-01-31T030000Z"
  bi_avdrift "timern är aktiv men kopian är 3 dygn gammal (körningarna misslyckas tyst)" "72 h gammal"
  bi_lagg_kopia 2026-02-03T030000Z 'now'
  bi_aterstalld
  rm -f "${BI_BACKUPS}/2026-02-03T030000Z/manifest"
  bi_avdrift "nyaste katalogen saknar manifest — den är inte färdigskriven" "saknar manifest"
  rm -rf "${BI_BACKUPS}/2026-02-03T030000Z"
  bi_avdrift "…och då gäller den föregående, som är för gammal" "72 h gammal"
  rm -rf "${BI_BACKUPS:?}"/2026-*
  mkdir -p "${BI_BACKUPS}/inte-en-backup" "${BI_BACKUPS}/.ofullstandig"
  touch -d '3 days ago' "$BI_KMD"
  bi_avdrift "ingen kopia alls, och installationen är 3 dygn gammal" "INGEN säkerhetskopia"
  if grep -E '✗' <<<"$UT" | grep -q 'inte-en-backup\|ofullstandig'; then underkand "  en katalog som inte är en säkerhetskopia räknades"; else godkand "  varken en katalog som lagts dit för hand eller .ofullstandig räknas som kopia"; fi
  touch "$BI_KMD"
  bara backup
  if (( KOD == 0 )); then godkand "  …men en nyss installerad värd larmar inte (⚠, inte ✗)"; else underkand "  en fräsch installation gav kod ${KOD}"; visa_vid_fel; fi
  rm -rf "${BI_BACKUPS}/inte-en-backup" "${BI_BACKUPS}/.ofullstandig"

  test_rubrik "I-7: B7 — ett kommando som ljuger ger aldrig ✓"
  aldrig_ok stat backup 'root:root 755|root 440'
  aldrig_ok find backup 'säkerhetskopian|säkerhetskopia'
  aldrig_ok date backup 'säkerhetskopian|säkerhetskopia'
  aldrig_ok systemctl backup 'vibesandbox-backup\.timer är'
  aldrig_ok sed backup 'ExecStart|OnCalendar'
  # (cat, grep och tr går INTE att fälla: stubben använder dem själv för att läsa sitt eget
  # felläge, så en stubbad 'cat' anropar sig själv i all oändlighet. Raden som bygger på cat —
  # regeln i sudoers.d — läses med samma varde-idiom som de övriga och täcks av dem.)
}
