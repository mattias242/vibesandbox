# shellcheck shell=bash
# Scenario 'flytt' — hela flyttkedjan i ordning, i EN engångscontainer men som två skilda
# "värdar": provision.sh + backup.sh på A, riv allt, provision.sh på B, restore.sh.
#
# Varför scenariot finns: infra/README.md rad 3–5 slår fast hela katalogens existensberättigande
# — "kravet är flyttbarhet: provision.sh på en ny värd + restore.sh ska räcka". Just SEKVENSEN
# har aldrig prövats. Scenariot 'backup' återställer till en tom katalog på en värd som testet
# självt har riggat; 'backupinstall' provisionerar men återställer ingenting. Ingen kör hela
# kedjan i ordning — och det är det påstående som är dyrast att ha fel om: upptäcks det att
# provision.sh + restore.sh inte räcker, upptäcks det den dag värden är borta.
#
#   F-1  Värd A: en provisionerad värd med riktig data. Säkerhetskopian tas av EXAKT den rad
#        timern kör (ExecStart ur enheten), och den är hel.
#   F-2  Flytten: kopian bärs ut ur värden, och allt annat rivs — data/, compose/,
#        tillståndsfilen, de installerade skripten, sudo-regeln, enheterna och den publika
#        nyckeln.
#   F-3  Ordningen spelar roll: restore.sh FÖRE provision.sh vägrar tydligt (kod 2, pekar på
#        provision.sh) och lämnar inget halvt läge. Inte ens --kontrollera går att köra.
#   F-4  Värd B: provision.sh hela vägen bygger värden igen — tillståndsfil, kataloger med rätt
#        ägare och läge, backup.sh, restore.sh, sudo-regeln, timern och den publika nyckeln
#        (som följde med i provision.env, precis som README:s flyttavsnitt säger). Och ingen data.
#   F-5  Den viktigaste negativa, i flyttsammanhang: någon hinner starta plattformen på B innan
#        kopian är tillbaka ⇒ restore.sh vägrar utan --skriv-over, och rör ingenting.
#   F-6  --dry-run i BÅDA skripten mitt i flytten ändrar ingenting.
#   F-7  B är A: varje databas tillbaka med samma innehåll (fingeravtryck rad för rad), godkänd
#        av integrity_check, invarianten håller, filerna tillbaka, compose/.env tillbaka som
#        0600 root, och allt under data/ ägt av plattformens uid.
#   F-8  En NY säkerhetskopia på B är lika hel som den på A var: samma databaser, samma
#        fingeravtryck i kopiorna, godkänd av restore.sh --kontrollera, och krypterad.
#   F-9  En KRYPTERAD kopia flyttar likadant: med bara arkiv.tar.gpg kvar (värd A är borta) och
#        den privata nyckeln på NAS-sidan går arkivet att packa upp till en backupkatalog som
#        restore.sh godtar — och återställningen ur den ger samma data igen.
#
# VAD DET INTE BEVISAR. Det här är en container, inte en VM: ingen kärna, ingen cloud-init,
# ingen riktig systemd (systemctl, apt-get, docker och tailscale är stubbade) och ingen Docker
# — alltså körs python3-grenen för SQLite, inte plattformsbilden och inte node:sqlite. "Värd A"
# och "värd B" är dessutom samma container: härdningen från A (ops, sshd, nftables,
# bekräftelsemarkörerna under /etc/vibesandbox) ligger kvar när B provisioneras. B är tom på
# allt som FLYTTEN hänger på, men den är inte nyfödd. En riktig flytt kräver en andra VPS och
# är utom räckhåll här — liksom nätet, DNS-bytet och tailnetet. Scenariot prövar SEKVENSEN och
# DATAINTEGRITETEN, inte hårdvaran.
#
# Source:as av i-container.sh och använder dess hjälpfunktioner (godkand, underkand, pastar,
# pastar_inte, innehaller, test_rubrik, ogonblicksbild, forbered_vard,
# lat_tailnet_session_finnas, kor_fas1, provision, UT/KOD) samt fyra databashjälpare ur
# scenarier/backup.sh (bk_skapa_db, bk_rader, bk_integritet, bk_invariant_haller) — samma sorts
# återanvändning som backupinstall.sh gör av scenarier/verify.sh. Egna namn har prefixet fl_.

FL_ROT=/srv/vibesandbox
FL_DATA="${FL_ROT}/data"
FL_COMPOSE="${FL_ROT}/compose"
FL_BACKUPS="${FL_ROT}/backups"
FL_UID=110001
# Flyttlådan: det enda som följer med från A till B. Ligger utanför allt ogonblicksbild tittar
# på (/etc /srv /home /usr/local), så den kan aldrig förväxlas med "värden".
FL_LADA=/flytt
FL_PUB=/tmp/flytt-pub.asc
FL_SEC=/tmp/flytt-sec.asc

FL_KMD=/usr/local/sbin/vibesandbox-backup
FL_ATERSTALL=/usr/local/sbin/vibesandbox-restore
FL_TJANSTFIL=/etc/systemd/system/vibesandbox-backup.service
FL_TIMERFIL=/etc/systemd/system/vibesandbox-backup.timer
FL_REGELFIL=/etc/sudoers.d/vibesandbox-backup
FL_TILLSTAND=/etc/vibesandbox/provision.state

# Databaserna som riggas på A. Samma tabeller som bk_skapa_db lägger upp (post + summa), så att
# bk_rader och bk_invariant_haller kan läsa dem.
FL_DATABASER=(
  control.sqlite
  identity.sqlite
  files.sqlite
  builder/builder.sqlite
  tenants/appett-published/data.sqlite
  tenants/apptva-published/data.sqlite
)

fl_backup()  { UT="$(bash /infra/backup.sh "$@" 2>&1)"; KOD=$?; }
fl_restore() { UT="$(bash /infra/restore.sh "$@" 2>&1)"; KOD=$?; }

# fl_om <beskrivning> <kommando…> — godkänt om kommandot lyckas; vid fel visas skriptets utdata.
fl_om() {
  local b="$1"; shift
  if "$@" >/dev/null 2>&1; then godkand "$b"; else
    underkand "$b"
    printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'
  fi
}

# Kör säkerhetskopian så som TIMERN kör den: kommandoraden läses ur enheten provision.sh skrev.
# Det som prövas är alltså den installerade kopian med de installerade flaggorna, inte repots
# skript med testets flaggor.
fl_kor_tjanstens_backup() {
  local rad
  local -a kmd
  rad="$(sed -n 's/^ExecStart=//p' "$FL_TJANSTFIL")"
  read -ra kmd <<<"$rad"
  UT="$("${kmd[@]}" 2>&1)"; KOD=$?
}

fl_senaste() {
  find "$FL_BACKUPS" -mindepth 1 -maxdepth 1 -type d -name '20*Z*' | LC_ALL=C sort | tail -n 1
}

# Fingeravtryck över en databas INNEHÅLL — varje tabell, varje rad, i bestämd ordning. Det är
# det här som får betyda "B är A": sha256 över filen duger inte, eftersom VACUUM INTO och en
# återställning skriver om sidorna.
fl_fingeravtryck() {
  python3 - "$1" <<'PY' 2>/dev/null || echo "GAR-INTE-ATT-LASA"
import hashlib, sqlite3, sys
db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
h = hashlib.sha256()
for (namn,) in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
    h.update(("tabell:%s\n" % namn).encode())
    for rad in db.execute('SELECT * FROM "%s" ORDER BY rowid' % namn):
        h.update((repr(rad) + "\n").encode())
db.close()
print(h.hexdigest())
PY
}

# En bild av datat: en rad per databas med antal rader och fingeravtryck. Bilden före flytten
# och bilden efter ska vara ordagrant lika.
fl_bild_av_datat() { # [bas, standard: data/]
  local bas="${1:-$FL_DATA}" d
  for d in "${FL_DATABASER[@]}"; do
    printf '%s\t%s\t%s\n' "$d" "$(bk_rader "${bas}/${d}")" "$(fl_fingeravtryck "${bas}/${d}")"
  done
}

# Data som liknar den riktiga: plattformens databaser, två hyresgäster, uppladdningar, en
# halvskriven uppladdning som inte ska med — och compose/ med driftens hemligheter.
fl_rigga_data() {
  local i=0
  local -a rader=(40 7 9 12 500 300)
  local d
  for d in "${FL_DATABASER[@]}"; do
    bk_skapa_db "${FL_DATA}/${d}" "${rader[i]}"
    i=$(( i + 1 ))
  done
  mkdir -p "${FL_DATA}/blobs" "${FL_DATA}/tmp" "${FL_DATA}/history"
  printf 'en uppladdad fil\n' >"${FL_DATA}/blobs/00112233445566778899aabbccddeeff"
  printf 'en till\n' >"${FL_DATA}/blobs/ffeeddccbbaa99887766554433221100"
  printf 'historik\n' >"${FL_DATA}/history/bygge-1.log"
  printf 'halvskriven uppladdning\n' >"${FL_DATA}/tmp/0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f.tmp"
  chown -R "${FL_UID}:${FL_UID}" "$FL_DATA"

  mkdir -p "${FL_COMPOSE}/app/deploy"
  printf '2.0.0-flytt\n' >"${FL_COMPOSE}/app/VERSION"
  printf 'name: vibesandbox\n' >"${FL_COMPOSE}/app/deploy/compose.yml"
  printf 'IDENTITY_SECRET=inte-en-riktig-hemlighet\nBASE_DOMAIN=example.org\n' >"${FL_COMPOSE}/.env"
  chown -R 0:0 "$FL_COMPOSE"
  chmod 600 "${FL_COMPOSE}/.env"
}

# Flytten: riv allt som hör till plattformen och allt provision.sh har lagt dit. Kvar blir en
# värd utan data, utan tillståndsfil och utan säkerhetskopiering — alltså en värd där varken
# backup.sh eller restore.sh har någonting att stå på.
fl_riv_varden() {
  rm -rf -- "$FL_ROT"
  rm -f -- "$FL_TILLSTAND" /etc/vibesandbox/backup-pub.asc
  rm -f -- "$FL_KMD" "$FL_ATERSTALL" /usr/local/sbin/vibesandbox-backup-grind
  rm -f -- "$FL_REGELFIL" "$FL_TJANSTFIL" "$FL_TIMERFIL"
  rm -f -- "${STUBBKATALOG}/tillstand/aktiverad/vibesandbox-backup.timer" \
           "${STUBBKATALOG}/tillstand/aktiv/vibesandbox-backup.timer"
}

fl_skapa_nycklar() {
  local h
  h="$(mktemp -d)" || return 1
  chmod 700 "$h"
  GNUPGHOME="$h" gpg --batch --quiet --passphrase '' \
    --quick-generate-key 'vibesandbox flytt (test) <flytt@example.invalid>' rsa3072 encr never \
    >/dev/null 2>&1 || return 1
  GNUPGHOME="$h" gpg --batch --quiet --armor --export >"$FL_PUB" 2>/dev/null
  GNUPGHOME="$h" gpg --batch --quiet --armor --export-secret-keys >"$FL_SEC" 2>/dev/null
  GNUPGHOME="$h" gpgconf --kill all >/dev/null 2>&1
  rm -rf -- "$h"
  chmod 600 "$FL_PUB" "$FL_SEC"
  [[ -s "$FL_PUB" && -s "$FL_SEC" ]]
}

# NAS-sidan: den privata nyckeln finns BARA här, aldrig på värden. Arkivet packas upp till en
# katalog som ska vara en fullgod backupkatalog.
fl_packa_upp_arkivet() { # <arkiv.tar.gpg> <målkatalog>
  local h
  h="$(mktemp -d)" || return 1
  chmod 700 "$h"
  GNUPGHOME="$h" gpg --batch --quiet --import "$FL_SEC" >/dev/null 2>&1 || { rm -rf -- "$h"; return 1; }
  install -d -m 0700 -o 0 -g 0 "$2"
  GNUPGHOME="$h" gpg --batch --no-tty --quiet --decrypt "$1" 2>/dev/null | tar -C "$2" -xf -
  local kod=$?
  GNUPGHOME="$h" gpgconf --kill all >/dev/null 2>&1
  rm -rf -- "$h"
  (( kod == 0 )) && [[ -f "${2}/manifest" ]]
}

scenario_flytt() {
  local har_gpg=0
  command -v gpg >/dev/null 2>&1 && har_gpg=1

  # ── Värd A ───────────────────────────────────────────────────────────────────────────────
  test_rubrik "F-1: värd A — provisionerad hela vägen, med riktig data"
  forbered_vard
  lat_tailnet_session_finnas
  if (( har_gpg )) && fl_skapa_nycklar; then
    # Den publika nyckeln står i provision.env — det är så den följer med till den nya värden
    # (README, "Flytt till en ny värd": kopiera infra/ och SAMMA provision.env dit).
    printf 'BACKUP_PUBNYCKEL=%s\n' "$FL_PUB" >>"${INFRA}/provision.env"
    godkand "ett nyckelpar skapades åt testet; bara den publika halvan hamnar i provision.env"
  else
    har_gpg=0
    # gpg finns i testavbilden (Dockerfile installerar gnupg). Saknas den ändå hoppas den
    # krypterade halvan över i stället för att räknas som underkänd — F-9 är ett tillägg till
    # kedjan, inte kedjan.
    printf '  ⚠ gpg saknas i containern — F-9 (den krypterade flytten) hoppas över\n'
  fi
  kor_fas1
  if (( KOD == 0 )); then godkand "fas 1 klar på A"; else underkand "fas 1 gav kod ${KOD}"; visa_vid_fel; fi
  provision --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD == 0 )); then godkand "fas 2 klar på A (alla steg, inklusive säkerhetskopieringen)"; else underkand "fas 2 gav kod ${KOD}"; visa_vid_fel; fi
  pastar "A har en tillståndsfil" test -f "$FL_TILLSTAND"
  pastar "A har säkerhetskopieringen installerad" test -x "$FL_KMD" -a -x "$FL_ATERSTALL"

  fl_rigga_data
  local bild_a
  bild_a="$(fl_bild_av_datat)"
  local env_summa
  env_summa="$(sha256sum "${FL_COMPOSE}/.env" | cut -d' ' -f1)"
  if [[ "$(grep -c 'GAR-INTE-ATT-LASA' <<<"$bild_a")" == 0 ]]; then
    godkand "${#FL_DATABASER[@]} databaser med innehåll ligger på A, alla läsbara"
  else
    underkand "en riggad databas gick inte att läsa:"; printf '%s\n' "$bild_a" | sed 's/^/      | /'
  fi

  fl_kor_tjanstens_backup
  if (( KOD == 0 )); then godkand "säkerhetskopian tas av enhetens egen ExecStart-rad"; else underkand "backup gav kod ${KOD}"; printf '%s\n' "$UT" | tail -n 20 | sed 's/^/      | /'; fi
  local kopia_a
  kopia_a="$(fl_senaste)"
  pastar "en säkerhetskopia ligger i ${FL_BACKUPS}" test -s "${kopia_a}/manifest"
  fl_restore --kontrollera "$kopia_a"
  if (( KOD == 0 )); then godkand "…och den är hel enligt restore.sh --kontrollera"; else underkand "kopian på A underkändes (kod ${KOD})"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'; fi
  if [[ "$(grep -c '^databas ' "${kopia_a}/manifest")" == "${#FL_DATABASER[@]}" ]]; then
    godkand "manifestet har en rad per databas (${#FL_DATABASER[@]})"
  else
    underkand "fel antal databasrader i manifestet: $(grep -c '^databas ' "${kopia_a}/manifest")"
  fi
  if (( har_gpg )); then
    pastar "kopian bär ett krypterat arkiv (nyckeln kom ur provision.env)" test -s "${kopia_a}/arkiv.tar.gpg"
  fi

  # ── Flytten ──────────────────────────────────────────────────────────────────────────────
  test_rubrik "F-2: flytten — kopian bärs ut, allt annat rivs"
  install -d -m 0700 -o 0 -g 0 "$FL_LADA" "${FL_LADA}/nas"
  cp -a "$kopia_a" "${FL_LADA}/lada"
  # Så som NAS:en har det efter en hämtning: BARA det krypterade arkivet, ingen klartext.
  if (( har_gpg )); then cp -a "${kopia_a}/arkiv.tar.gpg" "${FL_LADA}/nas/arkiv.tar.gpg"; fi
  local bild_i_ladan
  bild_i_ladan="$(fl_bild_av_datat "${FL_LADA}/lada/databaser")"
  if [[ "$bild_i_ladan" == "$bild_a" ]]; then
    godkand "kopian i flyttlådan innehåller exakt A:s data (rader och fingeravtryck)"
  else
    underkand "kopian skiljer sig från originalet:"; diff <(printf '%s\n' "$bild_a") <(printf '%s\n' "$bild_i_ladan") | head -n 10 | sed 's/^/      | /'
  fi

  fl_riv_varden
  pastar_inte "hela ${FL_ROT} är borta (data, compose OCH backups)" test -e "$FL_ROT"
  pastar_inte "tillståndsfilen är borta" test -e "$FL_TILLSTAND"
  pastar_inte "backup.sh är borta från värden" test -e "$FL_KMD"
  pastar_inte "restore.sh är borta från värden" test -e "$FL_ATERSTALL"
  pastar_inte "sudo-regeln är borta" test -e "$FL_REGELFIL"
  pastar_inte "timern och tjänsten är borta" test -e "$FL_TIMERFIL" -o -e "$FL_TJANSTFIL"
  pastar_inte "den publika nyckeln är borta" test -e /etc/vibesandbox/backup-pub.asc
  pastar "visudo är fortfarande nöjd efter rivningen" visudo -cq
  pastar "flyttlådan ligger kvar utanför värden" test -s "${FL_LADA}/lada/manifest"

  # ── Ordningen ────────────────────────────────────────────────────────────────────────────
  test_rubrik "F-3: restore.sh FÖRE provision.sh vägrar — och lämnar inget halvt läge"
  fl_restore "${FL_LADA}/lada"
  if (( KOD == 2 )) && innehaller "$UT" "provision.sh"; then
    godkand "vägrar med kod 2 och säger att provision.sh ska köras först"
  else
    underkand "kod ${KOD} mot en oprovisionerad värd"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'
  fi
  pastar_inte "ingen katalog skapades under ${FL_ROT}" test -e "$FL_ROT"
  pastar_inte "ingen tillståndsfil hittades på sig själv" test -e "$FL_TILLSTAND"
  fl_restore --kontrollera "${FL_LADA}/lada"
  if (( KOD == 2 )); then godkand "inte ens --kontrollera går att köra före provisioneringen"; else underkand "--kontrollera gav kod ${KOD}"; fi

  # ── Värd B ───────────────────────────────────────────────────────────────────────────────
  test_rubrik "F-4: värd B — provision.sh hela vägen bygger värden igen"
  provision --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD == 0 )); then godkand "provision.sh avslutas med 0 på B"; else underkand "provision gav kod ${KOD}"; visa_vid_fel; fi
  pastar "tillståndsfilen finns igen" test -f "$FL_TILLSTAND"
  if [[ "$(stat -c '%a %u:%g' "$FL_DATA")" == "750 ${FL_UID}:${FL_UID}" ]]; then
    godkand "data/ är 750 och ägs av plattformens uid (${FL_UID})"
  else
    underkand "data/: $(stat -c '%a %u:%g' "$FL_DATA")"
  fi
  if [[ "$(stat -c '%a %u:%g' "$FL_COMPOSE")" == "750 0:0" && "$(stat -c '%a %u:%g' "$FL_BACKUPS")" == "700 0:0" ]]; then
    godkand "compose/ 750 root och backups/ 700 root"
  else
    underkand "fel rättigheter: compose $(stat -c '%a %u:%g' "$FL_COMPOSE"), backups $(stat -c '%a %u:%g' "$FL_BACKUPS")"
  fi
  pastar "backup.sh ligger på B, identisk med repots" cmp -s /infra/backup.sh "$FL_KMD"
  pastar "restore.sh ligger på B, identisk med repots" cmp -s /infra/restore.sh "$FL_ATERSTALL"
  pastar "sudo-regeln är tillbaka" grep -qx "ops ALL=(root) NOPASSWD: ${FL_KMD}" "$FL_REGELFIL"
  pastar "timern är aktiverad igen" test -e "${STUBBKATALOG}/tillstand/aktiverad/vibesandbox-backup.timer"
  if (( har_gpg )); then
    pastar "den publika nyckeln följde med i provision.env och ligger på B" cmp -s "$FL_PUB" /etc/vibesandbox/backup-pub.asc
  fi
  if [[ -z "$(find "$FL_DATA" -mindepth 1 -print -quit)" ]]; then
    godkand "B har ingen data — provision.sh ger en värd, inte ett innehåll"
  else
    underkand "B har data som inte kom från en återställning"
  fi

  # ── Den viktigaste negativa ──────────────────────────────────────────────────────────────
  test_rubrik "F-5: någon hinner starta plattformen på B innan kopian är tillbaka"
  bk_skapa_db "${FL_DATA}/control.sqlite" 3
  chown -R "${FL_UID}:${FL_UID}" "$FL_DATA"
  local fore efter
  fore="$(ogonblicksbild)"
  fl_restore "${FL_LADA}/lada"
  efter="$(ogonblicksbild)"
  if (( KOD == 2 )) && innehaller "$UT" 'skriv-over'; then
    godkand "restore.sh vägrar mot en värd som redan har data (kod 2)"
  else
    underkand "skrev över en värd med data (kod ${KOD})"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'
  fi
  if [[ "$fore" == "$efter" ]]; then godkand "…och rörde ingenting"; else underkand "något ändrades ändå:"; diff <(printf '%s\n' "$fore") <(printf '%s\n' "$efter") | head -n 10 | sed 's/^/      | /'; fi
  pastar_inte "ingen undanflyttad katalog lämnades kvar" bash -c "find '${FL_ROT}' -maxdepth 1 -name 'data.fore-aterstallning-*' | grep -q ."
  rm -rf -- "${FL_DATA:?}"/*

  # ── Torrkörning mitt i flytten ───────────────────────────────────────────────────────────
  test_rubrik "F-6: --dry-run i båda skripten mitt i flytten ändrar ingenting"
  fore="$(ogonblicksbild)"
  fl_backup --dry-run
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "backup.sh --dry-run avslutas med 0"; else underkand "kod ${KOD}"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'; fi
  if [[ "$fore" == "$efter" ]]; then godkand "…och filsystemet är orört"; else underkand "backup --dry-run ändrade:"; diff <(printf '%s\n' "$fore") <(printf '%s\n' "$efter") | head -n 10 | sed 's/^/      | /'; fi
  fore="$(ogonblicksbild)"
  fl_restore --dry-run "${FL_LADA}/lada"
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "restore.sh --dry-run avslutas med 0"; else underkand "kod ${KOD}"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'; fi
  if [[ "$fore" == "$efter" ]]; then godkand "…och filsystemet är orört"; else underkand "restore --dry-run ändrade:"; diff <(printf '%s\n' "$fore") <(printf '%s\n' "$efter") | head -n 10 | sed 's/^/      | /'; fi

  # ── Återställningen ──────────────────────────────────────────────────────────────────────
  test_rubrik "F-7: restore.sh på B — och B är A"
  fl_restore "${FL_LADA}/lada"
  if (( KOD == 0 )); then godkand "restore.sh avslutas med 0"; else underkand "restore gav kod ${KOD}"; printf '%s\n' "$UT" | tail -n 20 | sed 's/^/      | /'; fi
  fl_om "…och säger att värden var tom — en ren återställning" innehaller "$UT" 'värden är tom'
  local bild_b
  bild_b="$(fl_bild_av_datat)"
  if [[ "$bild_b" == "$bild_a" ]]; then
    godkand "varje databas har samma rader och samma innehåll som på A (fingeravtryck rad för rad)"
  else
    underkand "datat skiljer sig från A:"; diff <(printf '%s\n' "$bild_a") <(printf '%s\n' "$bild_b") | head -n 12 | sed 's/^/      | /'
  fi
  local d
  for d in "${FL_DATABASER[@]}"; do
    pastar "${d}: integrity_check ok efter flytten" bk_integritet "${FL_DATA}/${d}"
  done
  pastar "den största hyresgästens invariant håller (summan stämmer med raderna)" \
    bk_invariant_haller "${FL_DATA}/tenants/appett-published/data.sqlite"
  pastar "uppladdningarna kom tillbaka" test -s "${FL_DATA}/blobs/00112233445566778899aabbccddeeff" -a -s "${FL_DATA}/blobs/ffeeddccbbaa99887766554433221100"
  pastar "historikfilen kom tillbaka" grep -qx 'historik' "${FL_DATA}/history/bygge-1.log"
  pastar_inte "den halvskrivna uppladdningen följde inte med (den var aldrig färdig)" test -e "${FL_DATA}/tmp/0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f.tmp"
  local fel_agare
  fel_agare="$(find "$FL_DATA" ! -uid "$FL_UID" -printf '%p\n')"
  if [[ -z "$fel_agare" ]]; then
    godkand "allt under data/ ägs av ${FL_UID} — ingen chown behövdes vid flytten"
  else
    underkand "fel ägare efter flytten:"; printf '%s\n' "$fel_agare" | head -n 5 | sed 's/^/      | /'
  fi
  if [[ "$(stat -c '%a %u:%g' "${FL_COMPOSE}/.env")" == "600 0:0" ]]; then
    godkand "compose/.env är tillbaka som 0600 root:root"
  else
    underkand "compose/.env: $(stat -c '%a %u:%g' "${FL_COMPOSE}/.env" 2>/dev/null)"
  fi
  if [[ "$(sha256sum "${FL_COMPOSE}/.env" | cut -d' ' -f1)" == "$env_summa" ]]; then
    godkand "…med exakt samma innehåll — stacken går att starta på B"
  else
    underkand "compose/.env har ändrats under flytten"
  fi
  pastar "compose/app/VERSION kom tillbaka" grep -qx '2.0.0-flytt' "${FL_COMPOSE}/app/VERSION"
  pastar "compose/app/deploy/compose.yml kom tillbaka" test -s "${FL_COMPOSE}/app/deploy/compose.yml"

  # ── En ny kopia på B ─────────────────────────────────────────────────────────────────────
  test_rubrik "F-8: en NY säkerhetskopia på B är lika hel som den på A var"
  sleep 1
  fl_kor_tjanstens_backup
  if (( KOD == 0 )); then godkand "B tar en egen säkerhetskopia med enhetens ExecStart-rad"; else underkand "kod ${KOD}"; printf '%s\n' "$UT" | tail -n 20 | sed 's/^/      | /'; fi
  local kopia_b
  kopia_b="$(fl_senaste)"
  fl_restore --kontrollera "$kopia_b"
  if (( KOD == 0 )); then godkand "…och restore.sh --kontrollera godkänner den"; else underkand "B:s kopia underkändes (kod ${KOD})"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'; fi
  if [[ "$(grep -c '^databas ' "${kopia_b}/manifest")" == "$(grep -c '^databas ' "${FL_LADA}/lada/manifest")" ]]; then
    godkand "lika många databaser som i A:s kopia"
  else
    underkand "A hade $(grep -c '^databas ' "${FL_LADA}/lada/manifest") databaser, B:s kopia har $(grep -c '^databas ' "${kopia_b}/manifest")"
  fi
  local bild_kopia_b
  bild_kopia_b="$(fl_bild_av_datat "${kopia_b}/databaser")"
  if [[ "$bild_kopia_b" == "$bild_a" ]]; then
    godkand "och samma innehåll i varje kopierad databas — kedjan A → kopia → B → kopia tappar ingenting"
  else
    underkand "B:s kopia skiljer sig från A:s data:"; diff <(printf '%s\n' "$bild_a") <(printf '%s\n' "$bild_kopia_b") | head -n 12 | sed 's/^/      | /'
  fi
  pastar "compose/.env följde med också i B:s kopia" grep -qx 'compose_env=ja' "${kopia_b}/manifest"
  if (( har_gpg )); then
    pastar "B:s kopia är krypterad — hemligheterna kan lämna också den nya värden" grep -qx 'kryptering=gpg' "${kopia_b}/manifest"
  fi

  # ── Den krypterade flytten ───────────────────────────────────────────────────────────────
  if (( har_gpg )); then
    test_rubrik "F-9: en KRYPTERAD kopia flyttar likadant — värd A är borta, bara arkivet finns"
    if [[ "$(find "${FL_LADA}/nas" -type f -printf '%f\n' | LC_ALL=C sort | paste -sd, -)" == "arkiv.tar.gpg" ]]; then
      godkand "NAS-sidan har bara arkiv.tar.gpg — ingen klartext lämnade värden"
    else
      underkand "oväntat på NAS-sidan: $(find "${FL_LADA}/nas" -type f -printf '%f ')"
    fi
    pastar_inte "hemligheten ur .env syns inte bland arkivets byte" \
      bash -c "LC_ALL=C grep -a -q 'inte-en-riktig-hemlighet' '${FL_LADA}/nas/arkiv.tar.gpg'"
    if fl_packa_upp_arkivet "${FL_LADA}/nas/arkiv.tar.gpg" "${FL_LADA}/ur-arkivet"; then
      godkand "arkivet går att packa upp med den privata nyckeln — och blir en backupkatalog"
    else
      underkand "arkivet gick inte att packa upp"
    fi
    fl_restore --kontrollera "${FL_LADA}/ur-arkivet"
    if (( KOD == 0 )); then godkand "restore.sh godkänner katalogen ur arkivet (manifest, sha256, integrity_check)"; else underkand "katalogen ur arkivet underkändes (kod ${KOD})"; printf '%s\n' "$UT" | tail -n 12 | sed 's/^/      | /'; fi

    rm -rf -- "${FL_DATA:?}"/* "${FL_COMPOSE:?}"/* "${FL_COMPOSE:?}"/.env
    fl_restore "${FL_LADA}/ur-arkivet"
    if (( KOD == 0 )); then godkand "…och går att återställa ur"; else underkand "återställningen ur arkivet gav kod ${KOD}"; printf '%s\n' "$UT" | tail -n 20 | sed 's/^/      | /'; fi
    bild_b="$(fl_bild_av_datat)"
    if [[ "$bild_b" == "$bild_a" ]]; then
      godkand "datat är A:s igen, hela vägen genom kryptering och dekryptering"
    else
      underkand "datat ur arkivet skiljer sig från A:"; diff <(printf '%s\n' "$bild_a") <(printf '%s\n' "$bild_b") | head -n 12 | sed 's/^/      | /'
    fi
    if [[ "$(sha256sum "${FL_COMPOSE}/.env" | cut -d' ' -f1)" == "$env_summa" && "$(stat -c '%a %u:%g' "${FL_COMPOSE}/.env")" == "600 0:0" ]]; then
      godkand "compose/.env kom tillbaka ur arkivet, oförändrad och som 0600 root"
    else
      underkand "compose/.env stämmer inte efter återställningen ur arkivet"
    fi
  fi

  rm -rf -- "$FL_LADA"
}
