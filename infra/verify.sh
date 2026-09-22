#!/usr/bin/env bash
# verify.sh — kontrollerar värdens FAKTISKA läge, inte konfigurationsfilerna.
#
# Varför: hos många leverantörer kan en kontrollpanel köra root-skript i gästen (via
# gästagenten) och skriva om SSH-konfigurationen bakom ryggen. En fil som ser rätt ut bevisar
# ingenting — 'sshd -T', 'nft list', 'ss', 'sysctl -n' och 'docker info' gör det.
#
# Inga antaganden om vad andras filer heter: kontrollerna utgår från det sammanslagna,
# effektiva läget och pekar sedan ut VILKA filer som ligger i vägen.
#
# Utskrift: ✓ (rätt), ✗ (avvikelse ⇒ exit 1), ⚠ (medvetet val eller något att känna till).
# Fristående: installeras som /usr/local/sbin/vibesandbox-verify och körs varje timme av
# vibesandbox-verify.timer. Läser förväntat läge från /etc/vibesandbox/provision.state.

# Inte -e: en misslyckad kontroll ska rapporteras, inte avbryta resten.
# pipefail: ett kommando som misslyckas mitt i en pipeline får inte döljas av det sista ledet.
# Det går bara ihop med en regel som följs genomgående: INGEN 'kommando | grep -q' (grep -q
# slutar läsa vid första träffen, kommandot får SIGPIPE, och en RÄTT inställning skulle slumpvis
# rapporteras som avvikelse). Varje kommando körs i stället för sig via 'fanga'/'varde', och
# utdatan prövas sedan ur en variabel.
#
# Grundregeln (B7): utdata och slutkod bedöms VAR FÖR SIG. Ett kommando som misslyckas eller
# saknas ger aldrig ✓ — inte ens om det råkade skriva ut något som ser rätt ut.
set -uo pipefail

TYST=0
HOPPA_OVER=""
FEL=0
VARNINGAR=0

anvandning() {
  cat <<'EOF'
Användning: verify.sh [--tyst] [--hoppa-over <kontroll,kontroll>] [--lista]

  --tyst          Skriv bara avvikelser och varningar (för timer/cron).
  --hoppa-over    Kommaseparerade kontroller att hoppa över, t.ex. 'docker,kataloger'
                  när bara fas 1 är körd.
  --lista         Skriv ut kontrollernas namn.

Avslutar med 0 om allt stämmer, 1 vid minst en avvikelse (✗).
EOF
}

readonly KONTROLLER=(uppdateringar anvandare tailscale brandvagg ssh portar leverantor docker gvisor system kataloger backup)
# sshd lyssnar på 22 och nås bara via tailnetet. Porten är ingen inställning (en tidigare
# SSH_PORT nådde aldrig sshd) — ett kvarglömt SSH_PORT i state-filen ignoreras.
readonly SSHD_PORT=22
readonly SSH_DROPIN_KATALOG=/etc/ssh/sshd_config.d
readonly SSH_DROPIN=0-0-vibesandbox.conf
readonly SSH_OPS_DROPIN=0-0-0-vibesandbox-ops.conf

ok()    { (( TYST )) || printf '  ✓ %s\n' "$*"; }
fel()   { printf '  ✗ %s\n' "$*"; FEL=$(( FEL + 1 )); }
obs()   { printf '  ⚠ %s\n' "$*"; VARNINGAR=$(( VARNINGAR + 1 )); }
rubrik() { (( TYST )) || printf '\n%s\n' "$*"; }
har_kommando() { command -v "$1" >/dev/null 2>&1; }

# forvanta <beskrivning> <faktiskt> <förväntat>
forvanta() {
  if [[ "$2" == "$3" ]]; then ok "$1: $2"; else fel "$1: är '$2', ska vara '$3'"; fi
}

# fanga <variabel> <kommando…> — stdout till variabeln, slutkod i FANGAD_KOD (och som returvärde).
# stderr kastas. Används överallt där utdata ska prövas: slutkoden avgör först OM utdatan gäller.
FANGAD_KOD=0
fanga() {
  local __var="$1" __ut __kod=0
  shift
  __ut="$("$@" 2>/dev/null)" || __kod=$?
  printf -v "$__var" '%s' "$__ut"
  FANGAD_KOD=$__kod
  return "$__kod"
}

# varde <kommando…> — kommandots utdata om det lyckades, annars en markering som aldrig kan vara
# ett förväntat värde. För 'forvanta': ett misslyckat kommando blir alltid ✗, aldrig ✓.
varde() {
  local ut
  if fanga ut "$@"; then
    printf '%s' "$ut"
  else
    printf '‹%s misslyckades, kod %s›' "$1" "$FANGAD_KOD"
  fi
}

# Enhetens läge enligt 'systemctl is-enabled' — bara om svar och slutkod hänger ihop
# (0 för aktiverade lägen, ≠ 0 för 'disabled', 'masked' …). Annars returneras 1.
enhet_lage() {
  local ut kod=0
  ut="$(systemctl is-enabled "$1" 2>/dev/null)" || kod=$?
  ut="${ut%%$'\n'*}"
  case "$ut" in
    enabled | enabled-runtime | static | alias | indirect | generated | transient) (( kod == 0 )) || return 1 ;;
    disabled | masked | masked-runtime | linked | linked-runtime | not-found | bad) (( kod != 0 )) || return 1 ;;
    *) return 1 ;;
  esac
  printf '%s' "$ut"
}
enhet_lage_text() { enhet_lage "$1" || printf '‹systemctl is-enabled %s gav inget användbart svar›' "$1"; }

las_tillstand() {
  local fil="${VIBESANDBOX_STATE:-/etc/vibesandbox/provision.state}"
  if [[ -r "$fil" ]]; then
    # shellcheck disable=SC1090
    . "$fil"
  else
    obs "hittar inte ${fil} — använder standardvärden (har provision.sh körts?)"
  fi
  OPS_USER="${OPS_USER:-ops}"
  PUBLIC_TCP_PORTS="${PUBLIC_TCP_PORTS-443}"
  PUBLIC_UDP_PORTS="${PUBLIC_UDP_PORTS-443}"
  LOCK_ROOT_PASSWORD="${LOCK_ROOT_PASSWORD:-1}"
  HARDEN_GUEST_AGENT="${HARDEN_GUEST_AGENT:-0}"
  INSTALL_GVISOR="${INSTALL_GVISOR:-0}"
  DOCKER_XFS_LOOP="${DOCKER_XFS_LOOP:-0}"
  SWAPFILE_SIZE_GB="${SWAPFILE_SIZE_GB:-2}"
  VM_SWAPPINESS="${VM_SWAPPINESS:-20}"
  PLATFORM_ROOT="${PLATFORM_ROOT:-/srv/vibesandbox}"
  DATA_USER="${DATA_USER:-vibesandbox}"
  DATA_UID="${DATA_UID:-110001}"
  DOCKREMAP_SUBID_BASE="${DOCKREMAP_SUBID_BASE:-100000}"
  TAILSCALE_TAGS="${TAILSCALE_TAGS:-tag:vibesandbox}"
  AUTO_REBOOT="${AUTO_REBOOT:-1}"
  AUTO_REBOOT_TIME="${AUTO_REBOOT_TIME:-04:00}"
  DEPLOY_UTAN_LOSENORD="${DEPLOY_UTAN_LOSENORD:-0}"
  # Som DEPLOY_UTAN_LOSENORD: standard 0 här men 1 i provision.sh. En state-fil som inget säger
  # om säkerhetskopieringen ska inte få en NOPASSWD-regel eller en timer att passera som väntad.
  INSTALL_BACKUP="${INSTALL_BACKUP:-0}"
  BACKUP_TID="${BACKUP_TID:-02:30}"
  BACKUP_BEHALL="${BACKUP_BEHALL:-7}"
  BACKUP_MAX_ALDER_TIMMAR="${BACKUP_MAX_ALDER_TIMMAR:-36}"
}

# ── Kontroller ─────────────────────────────────────────────────────────────────────────────

kontroll_uppdateringar() {
  rubrik "Automatiska säkerhetsuppdateringar"
  local enhet lage timrar
  for enhet in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service; do
    if ! lage="$(enhet_lage "$enhet")"; then
      fel "${enhet}: 'systemctl is-enabled' gav inget användbart svar — läget är OKÄNT"
    elif [[ "$lage" == masked* ]]; then
      fel "${enhet} är MASKAD — uppdateringar kör aldrig"
    else
      ok "${enhet} är inte maskad (${lage})"
    fi
  done
  for enhet in apt-daily.timer apt-daily-upgrade.timer; do
    # Beviset är att timern faktiskt har en nästa körning.
    if ! fanga timrar systemctl list-timers --all --no-legend --no-pager "$enhet"; then
      fel "${enhet}: 'systemctl list-timers' misslyckades (kod ${FANGAD_KOD})"
    elif grep -qF -- "$enhet" <<<"$timrar" && systemctl is-active --quiet "$enhet" 2>/dev/null; then
      ok "${enhet} är schemalagd"
    else
      fel "${enhet} finns inte bland aktiva timrar (systemctl list-timers)"
    fi
  done
  forvanta "unattended-upgrades.service" "$(enhet_lage_text unattended-upgrades.service)" "enabled"
  # Allt som är maskat, utan antaganden om namn; det vi är beroende av får inte finnas bland dem.
  local lista alla maskade ovriga
  if ! fanga lista systemctl list-unit-files --state=masked --no-legend --no-pager; then
    fel "'systemctl list-unit-files --state=masked' misslyckades (kod ${FANGAD_KOD}) — vet inte vad som är maskat"
  else
    alla="$(awk '{print $1}' <<<"$lista")"
    maskade="$(grep -E '^(apt-daily|apt-daily-upgrade|unattended-upgrades|nftables|docker|containerd|tailscaled|ssh|sshd|systemd-timesyncd|systemd-resolved|vibesandbox-verify|vibesandbox-angra-uppstart)\.' <<<"$alla" || true)"
    if [[ -n "$maskade" ]]; then
      fel "maskade enheter som ska vara igång: $(tr '\n' ' ' <<<"$maskade")"
    else
      ok "inga av enheterna vi är beroende av är maskade"
    fi
    ovriga="$(grep -vxF -e "$maskade" <<<"$alla" | tr '\n' ' ' || true)"
    [[ -n "${ovriga// /}" ]] && ok "övriga maskade enheter på värden (lämnas orörda): ${ovriga}"
  fi
  if har_kommando apt-config; then
    local dump v=""
    if fanga dump apt-config dump; then
      v="$(grep -E '^APT::Periodic::Unattended-Upgrade ' <<<"$dump" | tr -dc '0-9' || true)"
      forvanta "APT::Periodic::Unattended-Upgrade (effektivt, apt-config dump)" "${v:-0}" "1"
      # Enkla värden gäller från den fil som läses sist — en leverantörs senare fil kan stänga av
      # allt utan att vår egen fil ändras. Därför det effektiva värdet, inte filen.
      v="$(grep -E '^APT::Periodic::Update-Package-Lists ' <<<"$dump" | tr -dc '0-9' || true)"
      forvanta "APT::Periodic::Update-Package-Lists (effektivt)" "${v:-0}" "1"
      v="$(grep -E '^Unattended-Upgrade::Automatic-Reboot ' <<<"$dump" | sed -E 's/.*"(.*)".*/\1/' || true)"
      forvanta "Unattended-Upgrade::Automatic-Reboot (effektivt)" "${v:-false}" "$( (( AUTO_REBOOT )) && echo true || echo false)"
      if (( AUTO_REBOOT )); then
        v="$(grep -E '^Unattended-Upgrade::Automatic-Reboot-Time ' <<<"$dump" | sed -E 's/.*"(.*)".*/\1/' || true)"
        forvanta "Unattended-Upgrade::Automatic-Reboot-Time (effektivt)" "${v:-‹saknas›}" "$AUTO_REBOOT_TIME"
      fi
    else
      fel "'apt-config dump' misslyckades (kod ${FANGAD_KOD})"
    fi
  fi
  [[ -e /var/run/reboot-required ]] && obs "en omstart väntar (/var/run/reboot-required)"
  return 0
}

kontroll_anvandare() {
  rubrik "Användare och grupper"
  if ! id "$OPS_USER" >/dev/null 2>&1; then
    fel "driftanvändaren ${OPS_USER} finns inte"
    return 0
  fi
  local grupper
  if ! fanga grupper id -nG "$OPS_USER"; then
    fel "'id -nG ${OPS_USER}' misslyckades (kod ${FANGAD_KOD}) — gruppmedlemskapen är okända"
  else
    grupper="$(tr ' ' '\n' <<<"$grupper")"
    if grep -qx sudo <<<"$grupper"; then ok "${OPS_USER} är med i sudo"; else fel "${OPS_USER} är INTE med i sudo"; fi
    if grep -qx docker <<<"$grupper"; then
      fel "${OPS_USER} är med i docker-gruppen (= root utan lösenord)"
    else
      ok "${OPS_USER} är inte med i gruppen docker (id -nG)"
    fi
  fi
  local rad
  # getent: 0 = gruppen finns, 2 = gruppen finns inte (före Docker-steget). Allt annat är ett fel.
  fanga rad getent group docker
  case "$FANGAD_KOD" in
    0) if [[ -n "$(cut -d: -f4 <<<"$rad")" ]]; then fel "docker-gruppen har medlemmar: $(cut -d: -f4 <<<"$rad")"; else ok "docker-gruppen är tom"; fi ;;
    2) ok "docker-gruppen finns inte (än)" ;;
    *) fel "'getent group docker' misslyckades (kod ${FANGAD_KOD}) — vet inte vilka som är med i docker-gruppen" ;;
  esac
  if fanga rad getent group sudo; then
    forvanta "medlemmar i sudo" "$(cut -d: -f4 <<<"$rad")" "$OPS_USER"
  else
    fel "'getent group sudo' misslyckades (kod ${FANGAD_KOD})"
  fi
  forvanta "lösenordsstatus för ${OPS_USER} (krävs för sudo och webbkonsol)" "$(losenordsstatus "$OPS_USER")" "P"
  if (( LOCK_ROOT_PASSWORD )); then
    forvanta "lösenordsstatus för root" "$(losenordsstatus root)" "L"
  fi
  kontroll_sudoers
  # Andra konton med uid 0 eller med inloggningsskal är avdrift.
  local extra
  # shellcheck disable=SC2016  # awk-program, inte skalvariabler
  if fanga extra awk -F: '$3==0 && $1!="root"{print $1}' /etc/passwd; then
    if [[ -n "$extra" ]]; then fel "fler konton med uid 0: $(tr '\n' ' ' <<<"$extra")"; else ok "bara root har uid 0"; fi
  else
    fel "/etc/passwd gick inte att läsa (kod ${FANGAD_KOD})"
  fi
  # shellcheck disable=SC2016  # awk-program, inte skalvariabler
  if fanga extra awk -F: -v ops="$OPS_USER" '$7 ~ /(bash|sh|zsh|dash)$/ && $1!="root" && $1!=ops {print $1}' /etc/passwd; then
    if [[ -n "$extra" ]]; then fel "oväntade konton med inloggningsskal: $(tr '\n' ' ' <<<"$extra")"; else ok "inga oväntade konton med skal"; fi
  else
    fel "/etc/passwd gick inte att läsa (kod ${FANGAD_KOD})"
  fi
  return 0
}

# Andra fältet i 'passwd -S' — eller en markering om kommandot misslyckades.
losenordsstatus() {
  local ut
  if fanga ut passwd -S "$1"; then
    awk '{print $2}' <<<"$ut"
  else
    printf '‹passwd -S misslyckades, kod %s›' "$FANGAD_KOD"
  fi
}

# bara_egna_kommandon <rad ur 'sudo -l'> <tillåtet kommando…> — sant om raden är lösenordsfri
# JUST för de kommandon vi själva har lagt dit. sudo slår ibland ihop flera regler till en rad
# ("(root) NOPASSWD: /a, /b"), så raden prövas kommando för kommando i stället för som exakt
# text: annars kunde en hopslagning ge ett falskt ✗ varje timme. Ett kommando till, eller en
# annan körsomanvändare än root, gör att raden står kvar.
bara_egna_kommandon() {
  local rad="$1" kmd
  shift
  (( $# > 0 )) || return 1
  [[ "$rad" == "(root) NOPASSWD: "* ]] || return 1
  rad="${rad#"(root) NOPASSWD: "}"
  while [[ -n "$rad" ]]; do
    kmd="${rad%%, *}"
    [[ " $* " == *" ${kmd} "* ]] || return 1
    [[ "$kmd" == "$rad" ]] && break
    rad="${rad#*, }"
  done
  return 0
}

# Lösenordsfri sudo (NOPASSWD, eller '!authenticate') gör varje process som kör som ops till
# root utan hinder — och tar bort lösenordet som skydd om ops nyckel läcker.
# Två bevis: filerna, rad för rad (pekar ut VAR), och sudos egen tolkning för driftanvändaren.
kontroll_sudoers() {
  local filer=() f traffar kod=0
  for f in /etc/sudoers /etc/sudoers.d/*; do [[ -f "$f" ]] && filer+=("$f"); done
  if (( ${#filer[@]} == 0 )); then
    fel "hittar varken /etc/sudoers eller något i /etc/sudoers.d"
  else
    traffar="$(grep -HnE '^[^#]*(NOPASSWD|!authenticate)' -- "${filer[@]}" 2>/dev/null)" || kod=$?
    # En rad för exakt användaren root ger inget nytt — root är redan root. cloud-init lägger en
    # sådan på Debian-avbilder, och den ska inte ge ett falskt ✗. Bara exakt "root" undantas:
    # "%rootgrupp", "rootish" och alla andra namn räknas fortfarande.
    if (( kod == 0 )); then
      traffar="$(grep -vE '^[^:]+:[0-9]+:[[:space:]]*root[[:space:]]' <<<"$traffar" || true)"
      # Driftsättningens regel (DEPLOY_UTAN_LOSENORD=1) — exakt den raden, i exakt den filen.
      if (( DEPLOY_UTAN_LOSENORD )); then
        traffar="$(grep -vxF "${DRIFTSATT_REGELFIL}:1:${OPS_USER} ALL=(root) NOPASSWD: ${DRIFTSATT_KMD}" <<<"$traffar" || true)"
      fi
      # Säkerhetskopieringens regel (INSTALL_BACKUP=1) — egen fil, en rad, ett kommando.
      # Återställningen står MED FLIT inte här: den är sällsynt och förstörande.
      if (( INSTALL_BACKUP )); then
        traffar="$(grep -vxF "${BACKUP_REGELFIL}:1:${OPS_USER} ALL=(root) NOPASSWD: ${BACKUP_KMD}" <<<"$traffar" || true)"
      fi
      [[ -n "$traffar" ]] || kod=1
    fi
    case "$kod" in
      0) fel "lösenordsfri sudo (NOPASSWD / !authenticate): $(tr '\n' ' ' <<<"$traffar")" ;;
      1) ok "inga lösenordsfria sudo-regler i /etc/sudoers och /etc/sudoers.d" ;;
      *) fel "sudoers-filerna gick inte att läsa (grep, kod ${kod})" ;;
    esac
  fi
  local lista
  if ! har_kommando sudo; then
    fel "sudo saknas — ${OPS_USER} kan inte bli root"
  elif ! fanga lista sudo -n -l -U "$OPS_USER"; then
    fel "'sudo -l -U ${OPS_USER}' misslyckades (kod ${FANGAD_KOD}) — sudos regler för ${OPS_USER} är okända"
  else
    local losenordsfria rad kvar=() egna=()
    (( DEPLOY_UTAN_LOSENORD )) && egna+=("$DRIFTSATT_KMD")
    (( INSTALL_BACKUP )) && egna+=("$BACKUP_KMD")
    losenordsfria="$(grep -E 'NOPASSWD|!authenticate' <<<"$lista" | sed -E 's/^[[:space:]]+//' || true)"
    while IFS= read -r rad; do
      [[ -n "$rad" ]] || continue
      bara_egna_kommandon "$rad" "${egna[@]}" || kvar+=("$rad")
    done <<<"$losenordsfria"
    if (( ${#kvar[@]} > 0 )); then
      fel "sudo -l -U ${OPS_USER}: lösenordsfri sudo för ${OPS_USER}: ${kvar[*]}"
    elif (( ${#egna[@]} > 0 )); then
      ok "sudo -l -U ${OPS_USER}: sudo kräver lösenord utom för ${egna[*]}"
    else
      ok "sudo -l -U ${OPS_USER}: sudo kräver lösenord"
    fi
  fi
  kontroll_driftsattning
}

# Rotsteget körs som root utan lösenord: är filen (eller katalogen den ligger i) skrivbar för
# någon annan än root blir den personen root. Därför ägare och läge, inte bara att regeln finns.
DRIFTSATT_KMD=/usr/local/sbin/vibesandbox-driftsatt
DRIFTSATT_REGELFIL=/etc/sudoers.d/vibesandbox-driftsatt
kontroll_driftsattning() {
  if (( ! DEPLOY_UTAN_LOSENORD )); then
    if [[ -e "$DRIFTSATT_REGELFIL" ]]; then fel "${DRIFTSATT_REGELFIL} finns trots DEPLOY_UTAN_LOSENORD=0"; fi
    return 0
  fi
  local lage
  if ! fanga lage stat -c '%U:%G %a' "$DRIFTSATT_KMD"; then
    fel "${DRIFTSATT_KMD} saknas (stat, kod ${FANGAD_KOD}) — regeln pekar på ingenting"
  elif [[ "$lage" != "root:root 755" ]]; then
    fel "${DRIFTSATT_KMD} är ${lage}, ska vara root:root 755 — annars blir den som kan skriva i den root"
  elif ! fanga lage stat -c '%U %a' "$(dirname "$DRIFTSATT_KMD")" || [[ "$lage" != "root 755" ]]; then
    fel "$(dirname "$DRIFTSATT_KMD") är '${lage}', ska vara root 755"
  else
    ok "lösenordsfri sudo bara för ${DRIFTSATT_KMD} (rootägd, 755)"
  fi
  if fanga lage stat -c '%U %a' "$DRIFTSATT_REGELFIL" && [[ "$lage" == "root 440" ]]; then
    ok "${DRIFTSATT_REGELFIL}: root 440"
  else
    fel "${DRIFTSATT_REGELFIL} är '${lage:-‹saknas›}', ska vara root 440"
  fi
}

kontroll_tailscale() {
  rubrik "Tailscale"
  if ! har_kommando tailscale; then fel "tailscale är inte installerat"; return 0; fi
  if systemctl is-active --quiet tailscaled 2>/dev/null; then ok "tailscaled är igång"; else fel "tailscaled är inte igång"; fi
  local ip
  if fanga ip tailscale ip -4 && [[ -n "$ip" ]]; then
    ok "ansluten till tailnetet"
  else
    fel "inte ansluten till tailnetet ('tailscale ip -4': kod ${FANGAD_KOD}, utdata '${ip%%$'\n'*}')"
    return 0
  fi
  # Utan rätt tagg räknas servern som en av ägarens egna enheter, och ACL:en släpper den in i
  # tailnetet. Det syns inte i någon fil på värden — bara i nodens faktiska taggar.
  local json taggar onskade
  onskade="$(tr ',' '\n' <<<"$TAILSCALE_TAGS" | sed '/^$/d' | sort -u | paste -sd, -)"
  if ! har_kommando python3; then
    fel "python3 saknas — nodens taggar går inte att läsa"
  elif ! fanga json tailscale status --json; then
    fel "'tailscale status --json' misslyckades (kod ${FANGAD_KOD}) — nodens taggar är okända"
  elif ! taggar="$(python3 -c 'import json,sys
s = json.load(sys.stdin).get("Self") or {}
print(",".join(sorted(s.get("Tags") or [])))' <<<"$json" 2>/dev/null)"; then
    fel "'tailscale status --json' gick inte att tolka — nodens taggar är okända"
  elif [[ "$taggar" == "$onskade" ]]; then
    ok "noden har taggarna ${taggar}"
  else
    fel "noden har taggarna '${taggar:-‹inga›}', inte '${onskade}' — utan tagg når servern hela tailnetet"
  fi
  return 0
}

kontroll_brandvagg() {
  rubrik "Brandvägg (laddat regelverk, nft list)"
  if ! har_kommando nft; then fel "nft saknas"; return 0; fi
  local tabell
  if ! fanga tabell nft -s list table inet vibesandbox || [[ -z "$tabell" ]]; then
    fel "tabellen 'inet vibesandbox' är INTE laddad — värden saknar brandvägg ('nft list table': kod ${FANGAD_KOD})"
    return 0
  fi
  ok "tabellen inet vibesandbox är laddad"
  if grep -Eq 'hook input priority (filter|0); policy drop;' <<<"$tabell"; then ok "input: policy drop"; else fel "input-kedjan har inte policy drop"; fi
  if grep -Eq 'hook forward priority (filter - 10|-10); policy drop;' <<<"$tabell"; then ok "forward: policy drop, före Dockers kedjor"; else fel "forward-kedjan har inte policy drop med prioritet filter - 10"; fi
  if grep -Eq "iifname \"tailscale0\" tcp dport ${SSHD_PORT} accept" <<<"$tabell"; then ok "SSH tillåts på tailscale0"; else fel "regeln för SSH på tailscale0 saknas"; fi
  # Ingen annan regel får släppa in SSH. (Utdatan är redan fångad ⇒ ingen SIGPIPE här.)
  local ssh_regler
  ssh_regler="$(grep -E "dport.*\b${SSHD_PORT}\b.*accept" <<<"$tabell" || true)"
  if [[ -n "$ssh_regler" ]] && grep -qv 'iifname "tailscale0"' <<<"$ssh_regler"; then
    fel "SSH-porten släpps in på fler gränssnitt än tailscale0"
  else
    ok "SSH släpps inte in någon annanstans"
  fi
  if grep -q 'ip daddr @sparrade_v4 counter drop' <<<"$tabell" && grep -q '100.64.0.0/10' <<<"$tabell"; then
    ok "containrars trafik mot tailnet/privata nät spärras"
  else
    fel "spärren för containrars trafik mot tailnet/privata nät saknas"
  fi
  # Helheten: exakt det regelverk som provision.sh laddade.
  local summafil=/etc/vibesandbox/nft.sha256 summa bekraftad=/etc/vibesandbox/brandvagg.bekraftad
  if [[ -r "$summafil" ]]; then
    summa="$(sha256sum <<<"$tabell" | awk '{print $1}')"
    if [[ "$summa" == "$(cat "$summafil")" ]]; then
      ok "laddat regelverk är identiskt med det provision.sh laddade"
    else
      fel "laddat regelverk AVVIKER från det provision.sh laddade (någon har ändrat reglerna)"
    fi
  elif [[ -e "$bekraftad" ]]; then
    # Efter en bekräftelse skrivs summan alltid. Saknas den går avdrift i kärnan inte att se.
    fel "kontrollsumman för det laddade regelverket saknas (${summafil}) fast brandväggen är bekräftad — avdrift i kärnan går inte att upptäcka"
  else
    obs "ingen kontrollsumma för regelverket (${summafil} saknas)"
  fi
  forvanta "nftables.service" "$(enhet_lage_text nftables.service)" "enabled"
  # Filen på disk är det som laddas vid NÄSTA uppstart — att tabellen i kärnan stämmer säger
  # ingenting om den. Tre frågor: går den att ladda, är det den ägaren bekräftade, och
  # raderar den andras regler?
  local ut
  if [[ ! -r /etc/nftables.conf ]]; then
    fel "/etc/nftables.conf saknas — brandväggen laddas inte vid nästa uppstart"
  else
    if fanga ut nft -c -f /etc/nftables.conf; then
      ok "/etc/nftables.conf går att ladda (nft -c -f)"
    else
      fel "/etc/nftables.conf går INTE att ladda ('nft -c -f': kod ${FANGAD_KOD}) — ingen brandvägg efter nästa uppstart, och Docker startar inte"
    fi
    if [[ ! -s "$bekraftad" ]]; then
      fel "brandväggen har aldrig bekräftats (${bekraftad} saknas) — kör steget brandvagg och svara JA"
    elif fanga ut sha256sum -c --status "$bekraftad"; then
      ok "/etc/nftables.conf är den fil ägaren bekräftade (sha256, ${bekraftad})"
    else
      fel "/etc/nftables.conf stämmer INTE med den bekräftade summan (${bekraftad}) — ändrad efter bekräftelsen; laddas så vid nästa uppstart"
    fi
    if grep -Eq '^\s*flush ruleset' /etc/nftables.conf; then
      fel "/etc/nftables.conf innehåller 'flush ruleset' — en omladdning raderar Dockers regler"
    else
      ok "/etc/nftables.conf saknar 'flush ruleset'"
    fi
  fi
  # Ångra-mekanismen måste finnas på plats innan nästa riskabla ändring — och uppstartsenheten
  # är det enda som ångrar en obekräftad ändring efter en omstart.
  local angra=/usr/local/sbin/vibesandbox-angra
  if [[ -f "$angra" && -x "$angra" && ! -L "$angra" ]] && [[ "$(stat -c '%u' "$angra" 2>/dev/null)" == 0 ]]; then
    ok "ångra-skriptet ${angra} finns, är körbart och ägs av root"
  else
    fel "ångra-skriptet ${angra} saknas, är inte körbart eller ägs inte av root"
  fi
  forvanta "vibesandbox-angra-uppstart.service" "$(enhet_lage_text vibesandbox-angra-uppstart.service)" "enabled"
  # En obekräftad ändring (JA-frågan besvarades aldrig) som ligger kvar ångras vid nästa omstart.
  local markor
  for markor in /etc/vibesandbox/angra/*/obekraftad; do
    [[ -e "$markor" ]] && fel "en OBEKRÄFTAD ändring ligger kvar: ${markor} — ångras vid nästa omstart; kör steget igen eller vibesandbox-angra"
  done
  if har_kommando iptables; then
    local version
    if fanga version iptables --version && grep -q nf_tables <<<"$version"; then ok "iptables använder nf_tables-bakänden"; else fel "iptables använder INTE nf_tables ('${version}', kod ${FANGAD_KOD})"; fi
  fi
  return 0
}

kontroll_ssh() {
  rubrik "SSH (effektivt läge, sshd -T)"
  if ! har_kommando sshd; then fel "sshd saknas"; return 0; fi
  local anv adress utdata par nyckel varde faktiskt
  # Både en publik adress och en tailnet-adress: ett Match-block kan ge olika svar.
  for anv in root "$OPS_USER"; do
    for adress in 203.0.113.10 100.64.0.10; do
      if ! fanga utdata sshd -T -C "user=${anv},host=localhost,addr=${adress}" || [[ -z "$utdata" ]]; then
        fel "sshd -T misslyckades (kod ${FANGAD_KOD}; user=${anv}, addr=${adress}) — konfigurationen är trasig eller okänd"
        continue
      fi
      # AuthorizedKeysCommand: ett kommando som får avgöra vilka nycklar som gäller kan släppa in
      # vem som helst, förbi authorized_keys — det ska inte finnas något.
      for par in "permitrootlogin no" "passwordauthentication no" "kbdinteractiveauthentication no" \
        "pubkeyauthentication yes" "authenticationmethods publickey" "allowusers ${OPS_USER}" \
        "authorizedkeyscommand none" "allowagentforwarding no" \
        "allowtcpforwarding no" "maxauthtries 3" "x11forwarding no" "permittunnel no" "permitemptypasswords no"; do
        nyckel="${par%% *}"; varde="${par#* }"
        faktiskt="$(grep -i "^${nyckel} " <<<"$utdata" | cut -d' ' -f2- | tr '\n' ' ' | sed 's/ $//')"
        if [[ "${faktiskt,,}" == "${varde,,}" ]]; then
          ok "${nyckel} ${faktiskt} (user=${anv}, addr=${adress})"
        else
          fel "${nyckel} är '${faktiskt}', ska vara '${varde}' (user=${anv}, addr=${adress})"
        fi
      done
    done
  done
  # Placeringen: vår dropin måste komma FÖRST, annars kan en annan fil vinna i morgon även om
  # 'sshd -T' råkar stämma i dag. Inga antaganden om vad andras filer heter. Vår egen fil för
  # driftanvändaren (fas 1) sorteras före med flit — den kontrolleras i stället på innehållet.
  local var="$SSH_DROPIN" katalog="$SSH_DROPIN_KATALOG" fore="" f forsta
  if [[ -f "${katalog}/${var}" ]]; then
    fore="$(
      LC_ALL=C
      cd "$katalog" || exit 0
      for f in *.conf; do [[ -e "$f" && "$f" != "$var" && "$f" != "$SSH_OPS_DROPIN" && "$f" < "$var" ]] && printf '%s ' "$f"; done
      true
    )"
    if [[ -n "$fore" ]]; then
      fel "andra dropins sorteras FÖRE vår och kan vinna över den: ${fore}"
    else
      ok "vår dropin sorteras först i ${katalog}"
    fi
  else
    fel "${katalog}/${var} saknas"
  fi
  kontroll_ops_dropin
  if [[ ! -r /etc/ssh/sshd_config ]]; then
    fel "/etc/ssh/sshd_config saknas eller går inte att läsa"
    return 0
  fi
  forsta="$(awk '!/^[[:space:]]*(#|$)/ { print; exit }' /etc/ssh/sshd_config | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')"
  if [[ "${forsta,,}" == "include ${katalog}/*.conf" ]]; then
    ok "sshd_config: Include-raden står före alla direktiv"
  else
    fel "sshd_config: första direktivet är '${forsta}', inte Include-raden — direktiv i huvudfilen kan vinna över dropins"
  fi
  if [[ -s /root/.ssh/authorized_keys ]]; then
    obs "root har authorized_keys (verkningslöst så länge PermitRootLogin=no, men en kontrollpanel kan skriva dit)"
  fi
  provinloggning
  return 0
}

# Fas 1-filen som stänger lösenord för driftanvändaren: exakt vårt Match-block, inget annat.
# (Den sorteras före alla andra — en främmande rad här skulle vinna över allt.)
kontroll_ops_dropin() {
  local fil="${SSH_DROPIN_KATALOG}/${SSH_OPS_DROPIN}" innehall forvantat
  if [[ ! -f "$fil" ]]; then
    fel "${fil} saknas (stänger lösenordsinloggning för ${OPS_USER}; skrivs av steget 'anvandare')"
    return 0
  fi
  forvantat="$(printf 'Match User %s\nPasswordAuthentication no\nKbdInteractiveAuthentication no' "$OPS_USER")"
  innehall="$(sed -E '/^[[:space:]]*(#|$)/d; s/^[[:space:]]+//; s/[[:space:]]+$//' "$fil")"
  if [[ "$innehall" == "$forvantat" ]]; then
    ok "${SSH_OPS_DROPIN}: bara vårt Match-block för ${OPS_USER}"
  else
    fel "${SSH_OPS_DROPIN} innehåller annat än vårt Match-block för ${OPS_USER}: $(tr '\n' '|' <<<"$innehall")"
  fi
}

# 'sshd -T' läser FILER. Det här frågar den KÖRANDE demonen: en inloggning som ops mot loopback
# där klienten vägrar allt utom att fråga vilka metoder som finns. Rätt svar är att servern
# bara erbjuder nyckel: 'Permission denied (publickey)'. Erbjuder den lösenord kör demonen med
# en annan konfiguration än filerna (inte omladdad, eller startad med -f/-o från annat håll).
# Provet loggas i journalen som en misslyckad inloggning från 127.0.0.1 — det är väntat.
provinloggning() {
  if ! har_kommando ssh; then
    fel "ssh (klienten) saknas — provinloggningen mot loopback kan inte göras"
    return 0
  fi
  local ut kod=0 metoder
  ut="$(ssh -F /dev/null -p "$SSHD_PORT" -l "$OPS_USER" \
    -o BatchMode=yes -o PubkeyAuthentication=no -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no -o GSSAPIAuthentication=no -o HostbasedAuthentication=no \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -o LogLevel=ERROR 127.0.0.1 true </dev/null 2>&1)" || kod=$?
  metoder="$(sed -n 's/.*Permission denied (\([^)]*\)).*/\1/p' <<<"$ut" | tail -n1)"
  if (( kod == 255 )) && [[ "$metoder" == "publickey" ]]; then
    ok "provinloggning med lösenord mot 127.0.0.1 som ${OPS_USER}: Permission denied (publickey) — demonen erbjuder bara nyckel"
  elif [[ -n "$metoder" ]] && (( kod == 255 )); then
    fel "provinloggning mot 127.0.0.1: den KÖRANDE sshd erbjuder '${metoder}', inte bara publickey — demonen kör inte med filernas konfiguration"
  else
    fel "provinloggning mot 127.0.0.1 gav inget besked om metoder (ssh kod ${kod}: $(tr '\n' ' ' <<<"${ut:0:160}")) — svarar sshd på port ${SSHD_PORT}?"
  fi
}

kontroll_portar() {
  rubrik "Lyssnande portar (ss)"
  if ! har_kommando ss; then fel "ss saknas"; return 0; fi
  local lyssnare rad proto lokal port adress process tillatna_tcp tillatna_udp ovantade=0 sshd_syns=0
  if ! fanga lyssnare ss -H -lntup; then
    fel "'ss -lntup' misslyckades (kod ${FANGAD_KOD}) — vet inte vad som lyssnar"
    return 0
  fi
  tillatna_tcp=" ${SSHD_PORT} ${PUBLIC_TCP_PORTS} "
  tillatna_udp=" ${PUBLIC_UDP_PORTS} "
  while read -r rad; do
    [[ -n "$rad" ]] || continue
    proto="$(awk '{print $1}' <<<"$rad")"
    lokal="$(awk '{print $5}' <<<"$rad")"
    process="$(grep -o 'users:.*' <<<"$rad" || true)"
    port="${lokal##*:}"
    adress="${lokal%:*}"
    case "$adress" in
      127.*|\[::1\]|'[::ffff:127.'*) continue ;;                       # loopback
    esac
    # sshd ska synas (Ubuntu 24.04 kan socketaktivera: då är det systemd som håller porten).
    if [[ "$proto" == tcp* && "$port" == "$SSHD_PORT" && ( "$process" == *'"sshd"'* || "$process" == *'"systemd"'* ) ]]; then
      sshd_syns=1
    fi
    [[ "$adress" == 127.* || "$adress" == *%lo ]] && continue
    [[ "$process" == *tailscaled* ]] && continue                         # tailscaleds egna portar
    [[ "$adress" == \[fe80:* && "$port" == 546 ]] && continue            # DHCPv6-klient, länklokal
    [[ "$proto" == udp* && "$port" == 68 ]] && continue                  # DHCP-klient
    if [[ "$proto" == tcp* && "$tillatna_tcp" == *" ${port} "* ]]; then continue; fi
    if [[ "$proto" == udp* && "$tillatna_udp" == *" ${port} "* ]]; then continue; fi
    fel "oväntad lyssnare: ${proto} ${lokal} ${process}"
    ovantade=$(( ovantade + 1 ))
  done <<<"$lyssnare"
  (( ovantade == 0 )) && ok "inga oväntade lyssnare utanför loopback"
  if (( sshd_syns )); then
    ok "sshd lyssnar på tcp/${SSHD_PORT}"
  else
    fel "ingen sshd lyssnar på tcp/${SSHD_PORT} — då finns ingen väg in via tailnetet"
  fi
  if [[ -n "$(awk '$5 ~ /:5355$/' <<<"$lyssnare")" ]]; then
    fel "LLMNR lyssnar på port 5355"
  else
    ok "LLMNR (5355) lyssnar inte"
  fi
  return 0
}

kontroll_leverantor() {
  rubrik "Kanaler utifrån (cloud-init, gästagent)"
  if [[ -d /etc/cloud/cloud.cfg.d ]]; then
    local effektivt=""
    # Helst det sammanslagna läget, så som cloud-init självt läser det. Finns python3 men går
    # det inte att läsa är det ett fel — reservvägen nedan är bara för värdar UTAN python3.
    if har_kommando python3; then
      if fanga effektivt python3 -c 'from cloudinit import stages
i = stages.Init()
i.read_cfg()
print("ssh_pwauth=%s disable_root=%s" % (i.cfg.get("ssh_pwauth"), i.cfg.get("disable_root")))' && [[ -n "$effektivt" ]]; then
        forvanta "cloud-init, sammanslagen konfiguration" "$effektivt" "ssh_pwauth=False disable_root=True"
      else
        fel "cloud-inits sammanslagna konfiguration gick inte att läsa (python3, kod ${FANGAD_KOD})"
      fi
    else
      # Reserv när cloud-inits python-modul inte går att nå: sista filen (i namnordning) som
      # sätter ssh_pwauth avgör — vilken fil det än är.
      local f sist="" varde=""
      for f in /etc/cloud/cloud.cfg /etc/cloud/cloud.cfg.d/*.cfg; do
        grep -Eq '^ssh_pwauth:' "$f" 2>/dev/null && sist="$f"
      done
      [[ -n "$sist" ]] && varde="$(sed -n 's/^ssh_pwauth:[[:space:]]*//p' "$sist" | tail -n1 | tr -d '"'"'"' ' | tr '[:upper:]' '[:lower:]')"
      if [[ "$varde" == "false" || "$varde" == "no" || "$varde" == "0" ]]; then
        ok "cloud-init: sista filen som sätter ssh_pwauth (${sist}) säger ${varde}"
      else
        fel "cloud-init: ssh_pwauth är '${varde:-osatt}' efter sammanslagning (sista fil: ${sist:-ingen})"
      fi
    fi
  else
    ok "cloud-init finns inte"
  fi

  if har_kommando qemu-ga; then
    local sparrade=""
    if fanga sparrade qemu-ga -D; then
      sparrade="$(grep -E '^(block-rpcs|blacklist)=' <<<"$sparrade" | cut -d= -f2- || true)"
    else
      sparrade=""
      fel "'qemu-ga -D' misslyckades (kod ${FANGAD_KOD}) — gästagentens läge är okänt"
    fi
    if (( HARDEN_GUEST_AGENT )); then
      if [[ "$sparrade" == *guest-exec* && "$sparrade" == *guest-set-user-password* && "$sparrade" == *guest-file-write* ]]; then
        ok "gästagenten spärrar guest-exec, filskrivning och lösenordsbyte"
      else
        fel "gästagenten ska vara härdad (HARDEN_GUEST_AGENT=1) men spärrar: '${sparrade:-ingenting}'"
      fi
      # Konfigurationen läses bara vid start ⇒ agenten måste ha startats efter att filen skrevs.
      local start fil
      fanga start systemctl show -p ActiveEnterTimestampMonotonic --value qemu-guest-agent.service || start=""
      fil="$(stat -c %Y /etc/qemu/qemu-ga.conf 2>/dev/null || echo 0)"
      if [[ -n "$start" && "$start" != 0 ]]; then
        local nu uppe startad
        nu="$(date +%s)"; uppe="$(cut -d. -f1 /proc/uptime)"
        startad=$(( nu - uppe + start / 1000000 ))
        if (( startad + 5 < fil )); then fel "qemu-guest-agent har inte startats om sedan qemu-ga.conf ändrades"; fi
      fi
    else
      obs "gästagenten är obegränsad (medvetet val, HARDEN_GUEST_AGENT=0): kontot hos leverantören är root här — kräver 2FA på kontot"
    fi
  else
    ok "qemu-guest-agent finns inte"
  fi
  return 0
}

kontroll_docker() {
  rubrik "Docker (docker info)"
  if ! har_kommando docker; then fel "docker är inte installerat"; return 0; fi
  local ut
  if ! fanga ut docker info; then fel "docker-demonen svarar inte ('docker info': kod ${FANGAD_KOD})"; return 0; fi
  local sakerhet val
  if fanga sakerhet docker info --format '{{json .SecurityOptions}}'; then
    for val in userns no-new-privileges seccomp apparmor cgroupns; do
      if grep -q "name=${val}" <<<"$sakerhet"; then ok "säkerhetsval aktivt: ${val}"; else fel "säkerhetsval SAKNAS i docker info: ${val}"; fi
    done
  else
    fel "'docker info' (säkerhetsval) misslyckades (kod ${FANGAD_KOD})"
  fi
  forvanta "cgroup-drivrutin" "$(varde docker info --format '{{.CgroupDriver}}')" "systemd"
  forvanta "cgroup-version" "$(varde docker info --format '{{.CgroupVersion}}')" "2"
  forvanta "lagringsdrivrutin" "$(varde docker info --format '{{.Driver}}')" "overlay2"
  forvanta "live-restore" "$(varde docker info --format '{{.LiveRestoreEnabled}}')" "true"
  forvanta "standardruntime" "$(varde docker info --format '{{.DefaultRuntime}}')" "runc"
  forvanta "loggdrivrutin" "$(varde docker info --format '{{.LoggingDriver}}')" "json-file"
  forvanta "Dockers rotkatalog (userns-remap ⇒ underkatalog per id-intervall)" \
    "$(varde docker info --format '{{.DockerRootDir}}')" "/var/lib/docker/${DOCKREMAP_SUBID_BASE}.${DOCKREMAP_SUBID_BASE}"
  forvanta "icc på standardbryggan" \
    "$(varde docker network inspect bridge --format '{{index .Options "com.docker.network.bridge.enable_icc"}}')" "false"

  local runtimes
  # shellcheck disable=SC2016  # Go-mall, inte skalvariabler
  fanga runtimes docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' \
    || fel "'docker info' (runtimes) misslyckades (kod ${FANGAD_KOD})"
  if (( INSTALL_GVISOR )); then
    if [[ " $runtimes " == *" runsc "* ]]; then ok "runtime runsc är registrerad"; else fel "runsc ska finnas (INSTALL_GVISOR=1) men saknas: ${runtimes}"; fi
  elif [[ " $runtimes " == *" runsc "* ]]; then
    obs "runsc är registrerad fast INSTALL_GVISOR=0"
  fi

  # Containrar som kör utan skydden — det är så en avdrift i compose-filen syns.
  local idn inspektion c farliga=0
  if ! fanga idn docker ps -q; then
    fel "'docker ps' misslyckades (kod ${FANGAD_KOD}) — containrarnas inställningar är okända"
  elif [[ -n "$idn" ]]; then
    # shellcheck disable=SC2086  # en id per ord, med flit
    if fanga inspektion docker inspect --format \
      '{{.Name}} privileged={{.HostConfig.Privileged}} userns={{.HostConfig.UsernsMode}} net={{.HostConfig.NetworkMode}} pid={{.HostConfig.PidMode}}' $idn; then
      while read -r c; do
        [[ -n "$c" ]] || continue
        fel "container med farliga inställningar: ${c}"; farliga=1
      done <<<"$(grep -E 'privileged=true|userns=host|net=host|pid=host' <<<"$inspektion" || true)"
      (( farliga )) || ok "inga körande containrar med privileged, userns/net/pid=host"
    else
      fel "'docker inspect' misslyckades (kod ${FANGAD_KOD})"
    fi
  else
    ok "inga körande containrar"
  fi

  if (( DOCKER_XFS_LOOP )); then
    forvanta "filsystem under /var/lib/docker" "$(varde findmnt -no FSTYPE /var/lib/docker)" "xfs"
    local flaggor
    if fanga flaggor findmnt -no OPTIONS /var/lib/docker && grep -Eq 'p(rj)?quota' <<<"$flaggor"; then ok "projektkvot påslagen på /var/lib/docker"; else fel "projektkvot (pquota) saknas på /var/lib/docker"; fi
  fi
  # docker.service ska vägra starta utan brandvägg.
  local enhet
  if fanga enhet systemctl cat docker.service && grep -q 'ExecStartPre=/usr/sbin/nft list table inet vibesandbox' <<<"$enhet"; then
    ok "docker.service kräver laddad brandvägg (ExecStartPre)"
  else
    fel "docker.service saknar spärren mot start utan brandvägg"
  fi
  return 0
}

kontroll_gvisor() {
  (( INSTALL_GVISOR )) || return 0
  rubrik "gVisor"
  local version
  if [[ -x /usr/local/bin/runsc ]] && fanga version /usr/local/bin/runsc --version; then ok "runsc finns (${version%%$'\n'*})"; else fel "runsc saknas eller går inte att köra"; fi
  return 0
}

# Vilka ANDRA filer sätter den här nyckeln? Inga antaganden om namn — alla sysctl-kataloger söks.
sysctl_andra_filer() {
  local nyckel="$1" f ut=""
  for f in /etc/sysctl.conf /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/local/lib/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf; do
    [[ -f "$f" && "$f" != /etc/sysctl.d/zz-vibesandbox.conf ]] || continue
    grep -Eq "^-?${nyckel//./[.]}[[:space:]]*=" "$f" 2>/dev/null && ut+="$(basename "$f") "
  done
  printf '%s' "${ut% }"
}

kontroll_system() {
  rubrik "Kärnparametrar, swap, tid (sysctl, swapon, timedatectl)"
  local par nyckel varde faktiskt andra
  for par in "kernel.kptr_restrict=2" "kernel.yama.ptrace_scope=2" "kernel.dmesg_restrict=1" \
    "kernel.kexec_load_disabled=1" "net.core.bpf_jit_harden=2" "fs.suid_dumpable=0" \
    "net.ipv4.conf.all.rp_filter=2" "net.ipv4.conf.default.rp_filter=2" \
    "net.ipv6.conf.all.forwarding=0" "net.ipv4.conf.all.accept_redirects=0" \
    "net.ipv4.conf.all.send_redirects=0" "net.ipv4.conf.all.accept_source_route=0" \
    "net.ipv4.tcp_syncookies=1" "vm.swappiness=${VM_SWAPPINESS}"; do
    nyckel="${par%%=*}"; varde="${par#*=}"
    faktiskt="$(varde sysctl -n "$nyckel")"
    andra="$(sysctl_andra_filer "$nyckel")"
    if [[ "$faktiskt" == "$varde" ]]; then
      ok "${nyckel}: ${faktiskt}${andra:+ (sätts också av: ${andra})}"
    else
      fel "${nyckel}: är '${faktiskt}', ska vara '${varde}'${andra:+ — sätts också av: ${andra}}"
    fi
  done
  # En fil som sorteras EFTER vår vinner vid nästa omstart, även om värdena stämmer just nu.
  local var=/etc/sysctl.d/zz-vibesandbox.conf efter="" f
  if [[ -f "$var" ]]; then
    efter="$(
      LC_ALL=C
      for f in /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/local/lib/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf; do
        [[ -f "$f" && "$f" != "$var" && "$(basename "$f")" > "$(basename "$var")" ]] && printf '%s ' "$f"
      done
    )"
    if [[ -n "$efter" ]]; then fel "sysctl-filer som sorteras EFTER vår och vinner vid nästa omstart: ${efter}"; else ok "vår sysctl-fil sorteras sist"; fi
  else
    fel "${var} saknas"
  fi
  local bpf
  bpf="$(varde sysctl -n kernel.unprivileged_bpf_disabled)"
  if [[ "$bpf" == 1 || "$bpf" == 2 ]]; then ok "kernel.unprivileged_bpf_disabled: ${bpf}"; else fel "kernel.unprivileged_bpf_disabled är '${bpf}'"; fi
  # Nyckeln finns bara i Debians kärna. Om den finns avgör /proc, inte om sysctl lyckas.
  if [[ -e /proc/sys/kernel/unprivileged_userns_clone ]]; then
    forvanta "kernel.unprivileged_userns_clone" "$(varde sysctl -n kernel.unprivileged_userns_clone)" "0"
  fi

  if (( SWAPFILE_SIZE_GB > 0 )); then
    local swap prio_fil="" prio_zram=""
    if ! fanga swap swapon --show=NAME,PRIO --noheadings; then
      fel "'swapon --show' misslyckades (kod ${FANGAD_KOD}) — swapläget är okänt"
      swap=""
    fi
    prio_fil="$(awk '$1=="/swapfile"{print $2}' <<<"$swap")"
    prio_zram="$(awk '$1 ~ /zram/{print $2; exit}' <<<"$swap")"
    if (( FANGAD_KOD != 0 )); then
      :
    elif [[ -z "$prio_fil" ]]; then
      fel "swapfilen /swapfile är inte aktiv"
    elif [[ -n "$prio_zram" ]] && (( prio_fil >= prio_zram )); then
      fel "swapfilen har prioritet ${prio_fil}, inte lägre än zram (${prio_zram})"
    else
      ok "swapfilen är aktiv med prioritet ${prio_fil}${prio_zram:+ (zram: ${prio_zram})}"
    fi
  fi

  if har_kommando timedatectl; then
    forvanta "klockan synkad (NTPSynchronized)" "$(varde timedatectl show -p NTPSynchronized --value)" "yes"
  fi
  if har_kommando aa-status || [[ -r /sys/module/apparmor/parameters/enabled ]]; then
    forvanta "AppArmor" "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" "Y"
  fi

  local df_ut anvant
  if ! fanga df_ut df --output=pcent /; then
    fel "'df' misslyckades (kod ${FANGAD_KOD}) — diskutrymmet är okänt"
  else
    anvant="$(tail -n1 <<<"$df_ut" | tr -dc '0-9')"
    if [[ -z "$anvant" ]]; then
      fel "'df' gav inget användbart svar ('${df_ut}')"
    elif (( anvant >= 85 )); then
      obs "rotfilsystemet är ${anvant} % fullt"
    else
      ok "rotfilsystemet: ${anvant} % använt"
    fi
  fi
  return 0
}

kontroll_kataloger() {
  rubrik "Kataloger"
  local rad katalog forvantat
  for rad in "${PLATFORM_ROOT}|755 0:0" "${PLATFORM_ROOT}/compose|750 0:0" \
    "${PLATFORM_ROOT}/data|750 ${DATA_UID}:${DATA_UID}" "${PLATFORM_ROOT}/backups|700 0:0"; do
    katalog="${rad%%|*}"; forvantat="${rad#*|}"
    if [[ -d "$katalog" ]]; then
      forvanta "$katalog" "$(varde stat -c '%a %u:%g' "$katalog")" "$forvantat"
    else
      fel "${katalog} saknas"
    fi
  done
  forvanta "uid för ${DATA_USER}" "$(varde id -u "$DATA_USER")" "$DATA_UID"
  return 0
}

# ── Säkerhetskopiering ─────────────────────────────────────────────────────────────────────
#
# Skripten, sudo-regeln och timern kontrolleras som allt annat. Den kontroll som gör skillnad
# är den sista: HUR GAMMAL är den nyaste färdiga säkerhetskopian. En timer kan vara aktiv och
# schemalagd medan varje körning misslyckas — databasen låst, disken full, plattformsbilden
# borta — och det läget upptäcks annars först den dagen någon behöver kopian.
BACKUP_KMD=/usr/local/sbin/vibesandbox-backup
BACKUP_ATERSTALL_KMD=/usr/local/sbin/vibesandbox-restore
BACKUP_REGELFIL=/etc/sudoers.d/vibesandbox-backup
BACKUP_TJANSTFIL=/etc/systemd/system/vibesandbox-backup.service
BACKUP_TIMERFIL=/etc/systemd/system/vibesandbox-backup.timer
BACKUP_TIMER=vibesandbox-backup.timer
# Samma mönster som backup.sh döper sina kataloger efter. Bara de räknas som säkerhetskopior:
# en katalog någon lagt dit för hand, och backup.sh:s egen .ofullstandig, är inte det.
BACKUP_NAMNMONSTER='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z(-[0-9]+)?'

kontroll_backup() {
  rubrik "Säkerhetskopiering"
  local f lage
  if (( ! INSTALL_BACKUP )); then
    for f in "$BACKUP_REGELFIL" "$BACKUP_TIMERFIL" "$BACKUP_TJANSTFIL" "$BACKUP_KMD" "$BACKUP_ATERSTALL_KMD"; do
      if [[ -e "$f" ]]; then fel "${f} finns trots INSTALL_BACKUP=0"; fi
    done
    obs "INSTALL_BACKUP=0 — ingen säkerhetskopiering på värden. Den måste köras ur repot för hand, och finns inte efter en flytt."
    return 0
  fi

  # Rotägda, icke skrivbara för andra: både sudo-regeln och timern kör dem som root.
  for f in "$BACKUP_KMD" "$BACKUP_ATERSTALL_KMD"; do
    if ! fanga lage stat -c '%U:%G %a' "$f"; then
      fel "${f} saknas (stat, kod ${FANGAD_KOD}) — säkerhetskopieringen finns inte på den här värden"
    elif [[ "$lage" != "root:root 755" ]]; then
      fel "${f} är ${lage}, ska vara root:root 755 — annars blir den som kan skriva i filen root"
    else
      ok "${f}: root:root 755"
    fi
  done

  # Sudo-regeln: exakt den rad vi skrev, i vår egen fil, 440 root.
  if fanga lage stat -c '%U %a' "$BACKUP_REGELFIL" && [[ "$lage" == "root 440" ]]; then
    ok "${BACKUP_REGELFIL}: root 440"
  else
    fel "${BACKUP_REGELFIL} är '${lage:-‹saknas›}', ska vara root 440"
  fi
  forvanta "regeln i ${BACKUP_REGELFIL}" "$(varde cat "$BACKUP_REGELFIL")" \
    "${OPS_USER} ALL=(root) NOPASSWD: ${BACKUP_KMD}"

  # Enheterna: att de är VÅRA och inte har skrivits om (t.ex. en ExecStart utan rotation).
  forvanta "ExecStart i ${BACKUP_TJANSTFIL}" "$(varde sed -n 's/^ExecStart=//p' "$BACKUP_TJANSTFIL")" \
    "${BACKUP_KMD} --behall ${BACKUP_BEHALL}"
  forvanta "OnCalendar i ${BACKUP_TIMERFIL}" "$(varde sed -n 's/^OnCalendar=//p' "$BACKUP_TIMERFIL")" \
    "*-*-* ${BACKUP_TID}:00"

  if ! lage="$(enhet_lage "$BACKUP_TIMER")"; then
    fel "${BACKUP_TIMER}: 'systemctl is-enabled' gav inget användbart svar — läget är OKÄNT"
  elif [[ "$lage" != enabled* ]]; then
    fel "${BACKUP_TIMER} är '${lage}', ska vara enabled — säkerhetskopieringen startar inte efter en omstart"
  else
    ok "${BACKUP_TIMER} är ${lage}"
  fi
  local timrar
  if ! fanga timrar systemctl list-timers --all --no-legend --no-pager "$BACKUP_TIMER"; then
    fel "${BACKUP_TIMER}: 'systemctl list-timers' misslyckades (kod ${FANGAD_KOD}) — vet inte om den är schemalagd"
  elif grep -qF -- "$BACKUP_TIMER" <<<"$timrar" && systemctl is-active --quiet "$BACKUP_TIMER" 2>/dev/null; then
    ok "${BACKUP_TIMER} är schemalagd"
  else
    fel "${BACKUP_TIMER} finns inte bland aktiva timrar (systemctl list-timers) — ingen säkerhetskopia tas"
  fi

  kontroll_backup_alder
  return 0
}

# Hur gammal är den nyaste FÄRDIGA säkerhetskopian? Finns ingen alls räknas tiden från när
# backup.sh lades på värden: annars larmade en nyss förberedd värd (där timern inte hunnit köra
# än), medan en värd där varje körning misslyckats sedan dag ett aldrig larmade — precis tvärtom
# mot vad man vill veta.
kontroll_backup_alder() {
  local nu kataloger nyast namn tidpunkt alder
  if ! fanga nu date +%s; then
    fel "'date +%s' misslyckades (kod ${FANGAD_KOD}) — kan inte avgöra hur gammal säkerhetskopian är"
    return 0
  fi
  if ! fanga kataloger find "${PLATFORM_ROOT}/backups" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %P\n'; then
    fel "${PLATFORM_ROOT}/backups gick inte att läsa ('find', kod ${FANGAD_KOD}) — vet inte om det finns någon säkerhetskopia"
    return 0
  fi
  nyast="$(grep -E "^[0-9.]+ ${BACKUP_NAMNMONSTER}\$" <<<"$kataloger" | LC_ALL=C sort -n | tail -n1)"
  if [[ -n "$nyast" ]]; then
    namn="${nyast#* }"
    tidpunkt="${nyast%% *}"; tidpunkt="${tidpunkt%%.*}"
    # Katalogen får sitt namn först när manifestet ligger där (backup.sh byter namn sist av
    # allt). Saknas det är det ingen säkerhetskopia — restore.sh vägrar den.
    if [[ ! -f "${PLATFORM_ROOT}/backups/${namn}/manifest" ]]; then
      fel "den nyaste säkerhetskopian (${namn}) saknar manifest — den är inte färdigskriven och går inte att återställa"
    fi
  else
    namn=""
    if ! fanga tidpunkt stat -c '%Y' "$BACKUP_KMD"; then
      fel "hittar ingen säkerhetskopia, och ${BACKUP_KMD} gick inte att läsa (stat, kod ${FANGAD_KOD})"
      return 0
    fi
  fi
  alder=$(( (nu - tidpunkt) / 3600 ))
  if (( alder > BACKUP_MAX_ALDER_TIMMAR )); then
    if [[ -z "$namn" ]]; then
      fel "INGEN säkerhetskopia finns, och backup.sh lades på värden för ${alder} h sedan (gränsen är ${BACKUP_MAX_ALDER_TIMMAR} h). Timern kan vara aktiv och ändå misslyckas varje gång: journalctl -u vibesandbox-backup"
    else
      fel "den nyaste säkerhetskopian är ${alder} h gammal (gränsen är ${BACKUP_MAX_ALDER_TIMMAR} h): ${namn}. Timern ser aktiv ut men körningarna ger inget resultat: journalctl -u vibesandbox-backup"
    fi
  elif [[ -z "$namn" ]]; then
    obs "ingen säkerhetskopia än (backup.sh lades på värden för ${alder} h sedan; timern kör ${BACKUP_TID}). Larmar efter ${BACKUP_MAX_ALDER_TIMMAR} h."
  else
    ok "nyaste säkerhetskopian är ${alder} h gammal (gränsen är ${BACKUP_MAX_ALDER_TIMMAR} h): ${namn}"
  fi
  return 0
}

# ── Huvudprogram ───────────────────────────────────────────────────────────────────────────

main() {
  while (( $# > 0 )); do
    case "$1" in
      --tyst) TYST=1 ;;
      --hoppa-over) HOPPA_OVER="${2:-}"; shift ;;
      --hoppa-over=*) HOPPA_OVER="${1#--hoppa-over=}" ;;
      --lista) printf '%s\n' "${KONTROLLER[@]}"; exit 0 ;;
      --hjalp | --help | -h) anvandning; exit 0 ;;
      *) anvandning >&2; exit 2 ;;
    esac
    shift
  done
  if (( EUID != 0 )); then
    printf '✗ måste köras som root (sshd -T, nft och ss -p kräver det).\n' >&2
    exit 2
  fi
  las_tillstand

  local k
  for k in ${HOPPA_OVER//,/ }; do
    [[ " ${KONTROLLER[*]} " == *" ${k} "* ]] || { printf '✗ okänd kontroll: %s\n' "$k" >&2; exit 2; }
  done
  for k in "${KONTROLLER[@]}"; do
    if [[ ",${HOPPA_OVER}," == *",${k},"* ]]; then
      obs "hoppar över kontrollen '${k}'"
      continue
    fi
    # Uttrycklig växel i stället för "kontroll_${k}": då ser shellcheck att funktionerna används.
    case "$k" in
      uppdateringar) kontroll_uppdateringar ;;
      anvandare) kontroll_anvandare ;;
      tailscale) kontroll_tailscale ;;
      brandvagg) kontroll_brandvagg ;;
      ssh) kontroll_ssh ;;
      portar) kontroll_portar ;;
      leverantor) kontroll_leverantor ;;
      docker) kontroll_docker ;;
      gvisor) kontroll_gvisor ;;
      system) kontroll_system ;;
      kataloger) kontroll_kataloger ;;
      backup) kontroll_backup ;;
    esac
  done

  if (( FEL > 0 )); then
    printf '\n✗ %d avvikelse(r), %d varning(ar).\n' "$FEL" "$VARNINGAR"
    exit 1
  fi
  (( TYST )) || printf '\n✓ Inga avvikelser (%d varning(ar)).\n' "$VARNINGAR"
  exit 0
}

main "$@"
