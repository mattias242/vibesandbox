# shellcheck shell=bash
# Scenario 'verify' — B7: verify.sh får aldrig ge ✓ på något den inte faktiskt har sett.
#
# Varje kontroll prövas med sitt underliggande kommando i tre fellägen (se stubbar/stubb):
#   tyst    ingen utdata, slutkod 1        saknas  slutkod 127
#   ljuger  RÄTT utdata, men slutkod 1  — det svåraste: bara slutkoden avslöjar felet
# och i inget av dem får kontrollen skriva ✓ för det kommandot har att säga.
#
# Dessutom de nya kontrollerna: provinloggning med lösenord mot en RIKTIG sshd på loopback
# (det är demonen som ska neka, inte filerna), sshd bland lyssnarna, AuthorizedKeysCommand,
# NOPASSWD i sudoers.
#
# Source:as av i-container.sh.

# falla <kommando> <läge> — kommandot misslyckas i läget 'tyst', 'saknas' eller 'ljuger'.
falla() {
  mkdir -p "${STUBBKATALOG}/misslyckas"
  if [[ ! -e "${STUBBAR}/$1" ]]; then
    ln -s /infra/test/stubbar/stubb "${STUBBAR}/$1"
    touch "${STUBBKATALOG}/misslyckas/.lankad-$1"
  fi
  printf '%s\n' "$2" >"${STUBBKATALOG}/misslyckas/$1"
}
sluta_falla() {
  find "${STUBBKATALOG}/misslyckas/$1" -delete 2>/dev/null
  if [[ -e "${STUBBKATALOG}/misslyckas/.lankad-$1" ]]; then
    find "${STUBBAR}/$1" "${STUBBKATALOG}/misslyckas/.lankad-$1" -delete
  fi
}

# bara <kontroll> [flaggor…] — kör verify.sh med alla ANDRA kontroller överhoppade.
bara() {
  local k="$1" andra
  shift
  andra="$(PATH="${STUBBAR}:${PATH}" "${INFRA}/verify.sh" --lista | grep -vx "$k" | paste -sd, -)"
  verifiera --hoppa-over "$andra" "$@"
}

# aldrig_ok <kommando> <kontroll> <mönster för ✓-rader som bygger på kommandot>
aldrig_ok() {
  local kmd="$1" kontroll="$2" monster="$3" lage falska
  for lage in tyst saknas ljuger; do
    falla "$kmd" "$lage"
    bara "$kontroll"
    sluta_falla "$kmd"
    falska="$(grep '✓' <<<"$UT" | grep -E -- "$monster")"
    if (( KOD == 1 )) && [[ -z "$falska" ]]; then
      godkand "${kmd} ${lage} ⇒ '${kontroll}' ger ✗, inget falskt ✓"
    else
      underkand "${kmd} ${lage} ⇒ '${kontroll}' gav kod ${KOD}${falska:+ och ✓ på:}"
      [[ -n "$falska" ]] && head -n 4 <<<"$falska" | sed 's/^/      | /'
    fi
  done
}

scenario_verify() {
  forbered_vard
  lat_tailnet_session_finnas
  kor_fas1
  provision --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD == 0 )); then godkand "förutsättning: fas 2 klar"; else underkand "fas 2 gav kod ${KOD}"; visa_vid_fel; fi
  # --ingen-bekraftelse låser aldrig root (B-2) — SSH-steget en gång till med ett riktigt JA.
  provision_pty "Skriv JA inom=>skicka:JA" -- --steg ssh --bekrafta-tailscale-ssh
  if (( KOD == 0 )); then godkand "förutsättning: SSH bekräftat med JA (root låst)"; else underkand "SSH-steget med JA gav kod ${KOD}"; visa_vid_fel; fi
  if starta_sshd; then godkand "förutsättning: en riktig sshd lyssnar på loopback"; else underkand "sshd startade inte"; fi

  test_rubrik "B7: utgångsläget är rätt ⇒ 0"
  verifiera
  if (( KOD == 0 )); then godkand "verify.sh avslutas med 0"; else underkand "verify.sh gav kod ${KOD}"; grep '✗' <<<"$UT" | head | sed 's/^/      | /'; fi

  test_rubrik "B7: ett kommando som misslyckas eller saknas är aldrig ✓ (utdata och slutkod var för sig)"
  # (En .service som är 'disabled' svarar med kod 1 även i verkligheten — där är 'ljuger' sanning.)
  aldrig_ok systemctl uppdateringar 'timer är inte maskad|schemalagd|unattended-upgrades\.service|maskade'
  aldrig_ok getent anvandare 'docker-gruppen (är tom|finns inte)|medlemmar i sudo'
  aldrig_ok passwd anvandare 'lösenordsstatus'
  aldrig_ok sudo anvandare 'sudo -l'
  aldrig_ok tailscale tailscale 'ansluten|taggarna'
  aldrig_ok nft brandvagg 'tabellen|policy|SSH|spärren|regelverk'
  aldrig_ok sshd ssh '\(user='
  aldrig_ok ssh ssh 'provinloggning'
  aldrig_ok ss portar '.'
  aldrig_ok docker docker '.'
  aldrig_ok sysctl system 'kernel\.|net\.|vm\.|fs\.'
  aldrig_ok swapon system 'swapfilen'
  aldrig_ok df system 'rotfilsystemet'
  aldrig_ok stat kataloger '/srv'
  aldrig_ok id kataloger 'uid för'
  aldrig_ok python3 leverantor 'sammanslagen'

  test_rubrik "Automatiska uppdateringar: det effektiva värdet, inte vår fil"
  printf 'APT::Periodic::Unattended-Upgrade "0";\nUnattended-Upgrade::Automatic-Reboot "false";\n' >/etc/apt/apt.conf.d/zzzz-avdrift
  bara uppdateringar
  if (( KOD == 1 )) && grep -q "✗ APT::Periodic::Unattended-Upgrade (effektivt" <<<"$UT" && grep -q "✗ Unattended-Upgrade::Automatic-Reboot (effektivt)" <<<"$UT"; then
    godkand "en senare fil som stänger av uppdateringar och omstart ⇒ ✗ för båda"; else underkand "avstängda uppdateringar gav kod ${KOD}"; visa_vid_fel 1; fi
  find /etc/apt/apt.conf.d/zzzz-avdrift -delete
  bara uppdateringar
  if (( KOD == 0 )) && grep -q "✓ Unattended-Upgrade::Automatic-Reboot (effektivt)" <<<"$UT"; then godkand "utan avdriften ⇒ ✓"; else underkand "utan avdriften gav kod ${KOD}"; visa_vid_fel; fi

  test_rubrik "Nodens tagg: utan den räknas servern som ägarens enhet och når hela tailnetet"
  bara tailscale
  if (( KOD == 0 )) && grep -q '✓ noden har taggarna tag:vibesandbox' <<<"$UT"; then godkand "rätt tagg ⇒ ✓"; else underkand "rätt tagg gav kod ${KOD}"; visa_vid_fel; fi
  mv "${STUBBKATALOG}/tillstand/tailscale-taggar" /tmp/taggar.bak
  bara tailscale
  if (( KOD == 1 )) && grep -q "✗ noden har taggarna '‹inga›'" <<<"$UT"; then godkand "otaggad nod ⇒ ✗"; else underkand "otaggad nod gav kod ${KOD}"; visa_vid_fel 1; fi
  printf 'tag:annan' >"${STUBBKATALOG}/tillstand/tailscale-taggar"
  bara tailscale
  if (( KOD == 1 )) && grep -q "✗ noden har taggarna 'tag:annan'" <<<"$UT"; then godkand "fel tagg ⇒ ✗"; else underkand "fel tagg gav kod ${KOD}"; visa_vid_fel 1; fi
  mv /tmp/taggar.bak "${STUBBKATALOG}/tillstand/tailscale-taggar"
  falla python3 saknas
  bara tailscale
  sluta_falla python3
  if (( KOD == 1 )) && ! grep '✓' <<<"$UT" | grep -q taggarna; then godkand "python3 saknas ⇒ ✗, inget falskt ✓ på taggarna"; else underkand "python3 saknas gav kod ${KOD}"; fi

  test_rubrik "B7: provinloggning med lösenord mot loopback — det är DEMONEN som ska neka"
  bara ssh
  if grep '✓' <<<"$UT" | grep -q 'Permission denied (publickey)'; then godkand "rätt läge: 'Permission denied (publickey)' ⇒ ✓"; else underkand "provinloggningen gav inte ✓ i rätt läge"; grep -E '✗|provinloggning' <<<"$UT" | head -n 5 | sed 's/^/      | /'; fi
  # Filerna är rätt (sshd -T ser inget fel), men DEN KÖRANDE demonen startades med en annan,
  # öppen konfiguration — just det glapp som 'sshd -T' inte kan se.
  printf 'PasswordAuthentication yes\nKbdInteractiveAuthentication yes\nUsePAM yes\n' >/tmp/sshd-oppen.conf
  starta_sshd -f /tmp/sshd-oppen.conf
  bara ssh
  if (( KOD == 1 )) && grep '✗' <<<"$UT" | grep -q 'provinloggning'; then godkand "demonen tillåter lösenord (filerna gör det inte) ⇒ ✗ på provinloggningen"; else underkand "en demon som tar emot lösenord upptäcktes inte (kod ${KOD})"; grep -E '✓.*(provinloggning|passwordauth)' <<<"$UT" | head -n 3 | sed 's/^/      | /'; fi
  pkill -x sshd
  bara ssh
  if (( KOD == 1 )) && grep '✗' <<<"$UT" | grep -q 'provinloggning'; then godkand "ingen sshd som svarar ⇒ ✗ på provinloggningen"; else underkand "utebliven sshd gav kod ${KOD}"; fi
  starta_sshd

  test_rubrik "B7: sshd ska synas bland lyssnarna"
  cp "${STUBBKATALOG}/ss-lyssnare" /tmp/ss-lyssnare.bra
  grep -v '"sshd"' /tmp/ss-lyssnare.bra >"${STUBBKATALOG}/ss-lyssnare"
  bara portar
  if (( KOD == 1 )) && grep '✗' <<<"$UT" | grep -q 'sshd'; then godkand "ingen sshd på port 22 bland lyssnarna ⇒ ✗"; else underkand "saknad sshd-lyssnare gav kod ${KOD}"; fi
  cp /tmp/ss-lyssnare.bra "${STUBBKATALOG}/ss-lyssnare"

  test_rubrik "B7: AuthorizedKeysCommand ska vara 'none' (ett sådant kommando kan släppa in vem som helst)"
  pastar "provision.sh:s dropin låser AuthorizedKeysCommand none (första förekomsten vinner)" grep -qx 'AuthorizedKeysCommand none' /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  printf 'AuthorizedKeysCommand /usr/bin/true\nAuthorizedKeysCommandUser nobody\n' >/etc/ssh/sshd_config.d/0-0-aaa.conf
  bara ssh
  if (( KOD == 1 )) && grep '✗' <<<"$UT" | grep -q 'authorizedkeyscommand'; then godkand "en fil som vinner över vår och sätter AuthorizedKeysCommand ⇒ ✗"; else underkand "AuthorizedKeysCommand upptäcktes inte (kod ${KOD})"; fi
  find /etc/ssh/sshd_config.d/0-0-aaa.conf -delete

  test_rubrik "B7: ingen NOPASSWD i sudoers"
  echo 'ops ALL=(ALL:ALL) NOPASSWD: ALL' >/etc/sudoers.d/zz-panel
  chmod 440 /etc/sudoers.d/zz-panel
  bara anvandare
  if (( KOD == 1 )) && grep '✗' <<<"$UT" | grep -q 'NOPASSWD'; then godkand "NOPASSWD för ops ⇒ ✗"; else underkand "NOPASSWD upptäcktes inte (kod ${KOD})"; fi
  echo 'annan ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/zz-panel
  bara anvandare
  if (( KOD == 1 )) && grep '✗' <<<"$UT" | grep -q 'zz-panel'; then godkand "NOPASSWD för en ANNAN användare ⇒ ✗ med filen utpekad"; else underkand "NOPASSWD för annan användare upptäcktes inte (kod ${KOD})"; fi
  printf '# ops ALL=(ALL) NOPASSWD: ALL  (bortkommenterad)\n' >/etc/sudoers.d/zz-panel
  bara anvandare
  if (( KOD == 0 )); then godkand "en bortkommenterad rad räknas inte"; else underkand "bortkommenterad NOPASSWD gav kod ${KOD}"; grep '✗' <<<"$UT" | sed 's/^/      | /'; fi
  # cloud-inits standardfil på Debian-avbilder: root får inget nytt av en NOPASSWD-rad — root är
  # redan root. Att larma på den ger ett falskt ✗ på en ren server.
  echo 'root ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/zz-panel
  bara anvandare
  if (( KOD == 0 )); then godkand "NOPASSWD för root (cloud-inits standardrad) räknas inte"; else underkand "NOPASSWD för root gav kod ${KOD}"; grep '✗' <<<"$UT" | sed 's/^/      | /'; fi
  printf 'root ALL=(ALL) NOPASSWD:ALL\nops ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/zz-panel
  bara anvandare
  if (( KOD == 1 )) && grep '✗' <<<"$UT" | grep -q 'ops ALL'; then godkand "en ops-rad bredvid root-raden ⇒ ✗"; else underkand "ops-raden bredvid root-raden upptäcktes inte (kod ${KOD})"; fi
  printf '%%rootgrupp ALL=(ALL) NOPASSWD: ALL\nrootish ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/zz-panel
  bara anvandare
  if (( KOD == 1 )); then godkand "bara exakt 'root' undantas — inte '%rootgrupp' eller 'rootish'"; else underkand "ett namn som bara börjar på root undantogs (kod ${KOD})"; fi
  find /etc/sudoers.d/zz-panel -delete

  test_rubrik "B6: SSH_PORT i en gammal state-fil påverkar ingenting"
  echo 'SSH_PORT=2222' >>/etc/vibesandbox/provision.state
  bara brandvagg
  if (( KOD == 0 )); then godkand "verify.sh kontrollerar port 22 oavsett SSH_PORT i state-filen"; else underkand "SSH_PORT i state-filen gav kod ${KOD}"; grep '✗' <<<"$UT" | sed 's/^/      | /'; fi
  sed -i '/^SSH_PORT=/d' /etc/vibesandbox/provision.state

  test_rubrik "B7: pipefail utan SIGPIPE-kapplöpning — 20 körningar i rad ger samma svar"
  local avvik=0
  for _ in $(seq 1 20); do verifiera --tyst; (( KOD == 0 )) || avvik=$(( avvik + 1 )); done
  if (( avvik == 0 )); then godkand "20 av 20 körningar gav 0"; else underkand "${avvik} av 20 körningar gav fel"; fi
  pastar "verify.sh kör med pipefail" grep -qE '^set -[a-z]*o pipefail|^set -o pipefail|^set -uo pipefail' /infra/verify.sh
  pkill -x sshd
}
