#!/usr/bin/env bash
# Tungt test av ÅNGRA-MEKANISMEN med riktig systemd som PID 1 (startas av tung-docker.sh).
#
# Allt som rör ångrandet är riktigt här: systemctl, systemd-run (den transienta timern),
# uppstartsenheten, nftables.service, sshd (ssh.service) och en OMSTART av "värden" — containern
# startas om med två obekräftade ändringar på disk. Stubbat: bara tailscale-klienten (och
# sessionskontrollen hoppas över med flaggan, eftersom ingen riktig tailnet-session finns).
#
#   i-container-systemd.sh fore     fram till omstarten (lämnar två obekräftade ändringar)
#   i-container-systemd.sh efter    efter omstarten: uppstartsenheten ska ha ångrat båda

# Inte pipefail — se i-container.sh.
set -u

FAS="${1:?ange fas: fore | efter}"

# shellcheck source=/dev/null
source <(sed -n '/^INFRA=/,/^# ── Scenarier/p' /infra/test/i-container.sh)

FRAGA="Skriv JA inom"
SPARAT=/var/tmp/vsb-test          # överlever omstarten (/run gör det inte)
FLAGGOR=(--bekrafta-tailscale-ssh --hoppa-over-sessionskontroll)

vanta_pa() { # <sekunder> <kommando…>
  local grans="$1" n=0
  shift
  until "$@" >/dev/null 2>&1; do n=$(( n + 1 )); (( n > grans )) && return 1; sleep 1; done
}
vard_uppe() {
  local s
  s="$(systemctl is-system-running 2>/dev/null)"
  [[ "$s" == running || "$s" == degraded ]]
}
angra_timrar() { systemctl list-timers --all --no-legend --no-pager 'vibesandbox-angra-*' 2>/dev/null; }

forbered_systemdvard() {
  mkdir -p "$INFRA" "$STUBBAR" "${STUBBKATALOG}/tillstand"/{maskad,aktiverad,aktiv,paket} "$SPARAT"
  cp /infra/provision.sh /infra/verify.sh /infra/angra.sh /infra/vibesandbox-angra-uppstart.service \
    /infra/README.md /infra/provision.env.example "$INFRA/"
  chmod +x "$INFRA"/*.sh
  # Bara tailscale-klienten stubbas; 'tailscale ip -4' svarar som om noden vore ansluten.
  ln -sf /infra/test/stubbar/stubb "${STUBBAR}/tailscale"
  touch "${STUBBKATALOG}/tillstand/tailscale-uppe"
  : >"$ANROP"
  ssh-keygen -q -t ed25519 -N '' -C test@example.org -f /root/testnyckel
  cat >"${INFRA}/provision.env" <<EOF
OPS_SSH_PUBKEY_FILE=/root/testnyckel.pub
OPS_PASSWORD_HASH='$(openssl passwd -6 -salt testsalt 'bara-ett-testlosenord')'
EOF
  chmod 600 "${INFRA}/provision.env"
  usermod -p "$(openssl passwd -6 -salt rotsalt 'leverantorens-rotlosenord')" root
}

fas_fore() {
  test_rubrik "Förutsättningar: systemd är PID 1"
  if vanta_pa 60 vard_uppe; then godkand "systemd är uppe ($(systemctl is-system-running))"; else underkand "systemd kom aldrig upp: $(systemctl is-system-running)"; fi
  pastar "PID 1 är systemd" test "$(cat /proc/1/comm)" = systemd
  forbered_systemdvard
  # Paketets nftables.service kan vara aktiverad från början (granskningens öppna fråga 1). Då
  # laddas /etc/nftables.conf vid VARJE uppstart — det är det som gör A3 farligt. Värsta fallet:
  systemctl enable nftables.service >/dev/null 2>&1
  pastar "ssh.service är igång (riktig sshd)" systemctl is-active --quiet ssh.service
  cp /etc/nftables.conf "${SPARAT}/nft.paketets"

  test_rubrik "Steget 'anvandare' med riktig systemctl"
  provision --steg anvandare
  if (( KOD == 0 )); then godkand "anvandare: slutkod 0"; else underkand "anvandare gav kod ${KOD}"; visa_vid_fel; fi

  test_rubrik "Brandvägg + JA: backstoppet är en RIKTIG transient timer, och den stoppas vid JA"
  provision_pty "${FRAGA}=>kor:systemctl list-timers --all --no-legend --no-pager 'vibesandbox-angra-*'" "=>skicka:JA" -- --steg brandvagg "${FLAGGOR[@]}"
  if (( KOD == 0 )); then godkand "JA: slutkod 0"; else underkand "JA: kod ${KOD}"; visa_vid_fel; fi
  if sed -n '/^\[\[kor: systemctl list-timers/,/^\[\[\/kor/p' <<<"$UT" | grep -q 'vibesandbox-angra-brandvagg-[0-9]*\.timer'; then
    godkand "medan frågan stod obesvarad fanns timern i systemd (systemctl list-timers)"
  else underkand "ingen timer syntes i systemd medan frågan stod obesvarad"; fi
  if [[ -z "$(angra_timrar)" ]]; then godkand "efter JA: ingen vibesandbox-angra-timer finns kvar i systemd"; else underkand "efter JA ligger timern kvar: $(angra_timrar)"; fi
  pastar_inte "efter JA: ingen obekräftad-markör" test -e /etc/vibesandbox/angra/brandvagg/obekraftad
  pastar "efter JA: tabellen är laddad" nft list table inet vibesandbox
  cp /etc/nftables.conf "${SPARAT}/nft.bekraftad"

  test_rubrik "kill -9 vid frågan ⇒ systemd kör backstoppet när timern löper ut (~240 s)"
  PUBLIC_TCP_PORTS="80 443" provision_pty "${FRAGA}=>signal:KILL" -- --steg brandvagg "${FLAGGOR[@]}"
  if (( KOD == 137 )); then godkand "provision.sh dog av SIGKILL vid frågan"; else underkand "oväntad slutkod ${KOD}"; visa_vid_fel 137; fi
  pastar "obekräftat läge: markören finns" test -e /etc/vibesandbox/angra/brandvagg/obekraftad
  if nft list table inet vibesandbox 2>/dev/null | grep -q 'tcp dport { 80, 443 }'; then godkand "obekräftat läge: den NYA tabellen (med port 80) är laddad"; else underkand "den nya tabellen laddades inte"; fi
  if angra_timrar | grep -q 'vibesandbox-angra-brandvagg-'; then godkand "timern väntar i systemd, fast provision.sh är död"; else underkand "ingen timer i systemd efter kill -9"; fi
  local start=$SECONDS
  if vanta_pa 330 bash -c '! test -e /etc/vibesandbox/angra/brandvagg/obekraftad'; then
    godkand "timern löste ut och ångrade efter $(( SECONDS - start )) s"
  else underkand "markören låg kvar efter 330 s"; fi
  pastar "…/etc/nftables.conf är den senast BEKRÄFTADE versionen" cmp -s "${SPARAT}/nft.bekraftad" /etc/nftables.conf
  if nft list table inet vibesandbox 2>/dev/null | grep -q 'tcp dport { 80, 443 }'; then underkand "…port 80 ligger kvar i kärnan"; else godkand "…den bekräftade tabellen är laddad igen (port 80 borta)"; fi
  if journalctl --no-pager -o cat -u 'vibesandbox-angra-brandvagg-*' 2>/dev/null | grep -q 'brandvagg: ÅNGRAT'; then godkand "…journalen visar att systemd körde ångra-skriptet"; else underkand "…journalen saknar ångrandet"; fi
  if [[ -z "$(angra_timrar)" ]]; then godkand "…och timern är borta ur systemd"; else underkand "…timern ligger kvar: $(angra_timrar)"; fi

  test_rubrik "Två obekräftade ändringar kvar när värden startas om (brandvägg + SSH)"
  cp /etc/ssh/sshd_config "${SPARAT}/sshd_config.fore"
  PUBLIC_TCP_PORTS="80 443" provision_pty "${FRAGA}=>signal:KILL" -- --steg brandvagg "${FLAGGOR[@]}"
  provision_pty "${FRAGA}=>signal:KILL" -- --steg ssh "${FLAGGOR[@]}"
  pastar "brandväggen är obekräftad (markör)" test -e /etc/vibesandbox/angra/brandvagg/obekraftad
  pastar "SSH är obekräftat (markör)" test -e /etc/vibesandbox/angra/ssh/obekraftad
  pastar "den obekräftade dropinen ligger på disk" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  pastar "den obekräftade nftables.conf (med port 80) ligger på disk" grep -q 'tcp dport { 80, 443 }' /etc/nftables.conf
  pastar "uppstartsenheten är aktiverad" test "$(systemctl is-enabled vibesandbox-angra-uppstart.service)" = enabled
  if [[ "$(passwd -S root | awk '{print $2}')" != L ]]; then godkand "root är inte låst"; else underkand "root är låst"; fi
  printf '\n   systemd före omstart: %d godkända, %d underkända\n' "$GODKANDA" "$UNDERKANDA"
  (( UNDERKANDA == 0 ))
}

fas_efter() {
  test_rubrik "Efter omstarten: uppstartsenheten har ångrat båda, INNAN brandvägg och sshd startade"
  if vanta_pa 60 vard_uppe; then godkand "systemd är uppe igen ($(systemctl is-system-running))"; else underkand "systemd kom inte upp: $(systemctl is-system-running)"; fi
  pastar_inte "ingen obekräftad-markör finns kvar" bash -c 'ls /etc/vibesandbox/angra/*/obekraftad'
  pastar "/etc/nftables.conf är den senast bekräftade (inte den obekräftade med port 80)" cmp -s "${SPARAT}/nft.bekraftad" /etc/nftables.conf
  if nft list table inet vibesandbox 2>/dev/null | grep -q 'tcp dport { 80, 443 }'; then
    underkand "nftables.service laddade den OBEKRÄFTADE regeluppsättningen vid uppstart"
  elif nft list table inet vibesandbox >/dev/null 2>&1; then
    godkand "nftables.service laddade den bekräftade regeluppsättningen vid uppstart"
  else underkand "ingen tabell laddades vid uppstart (nftables.service: $(systemctl is-active nftables.service))"; fi
  pastar_inte "den obekräftade SSH-dropinen är borta" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  pastar "sshd_config är byte-identisk med läget före" cmp -s "${SPARAT}/sshd_config.fore" /etc/ssh/sshd_config
  pastar "ssh.service startade (med den återställda konfigurationen)" systemctl is-active --quiet ssh.service
  local j
  j="$(journalctl -b --no-pager -o cat -u vibesandbox-angra-uppstart.service 2>/dev/null)"
  if grep -q 'brandvagg: ÅNGRAT' <<<"$j" && grep -q 'ssh: ÅNGRAT' <<<"$j"; then godkand "journalen: uppstartsenheten ångrade både brandvägg och SSH"; else underkand "journalen visar inte båda ångrandena:"; head -n 12 <<<"$j" | sed 's/^/      | /'; fi
  # Ordningen: ångrandet ska vara KLART innan nftables.service och ssh.service startar.
  local klar nft ssh
  klar="$(systemctl show -p ExecMainExitTimestampMonotonic --value vibesandbox-angra-uppstart.service)"
  nft="$(systemctl show -p ExecMainStartTimestampMonotonic --value nftables.service)"
  ssh="$(systemctl show -p ExecMainStartTimestampMonotonic --value ssh.service)"
  if [[ "$klar" =~ ^[0-9]+$ && "$nft" =~ ^[0-9]+$ ]] && (( klar > 0 && nft > 0 && klar <= nft )); then
    godkand "ångrandet var klart före nftables.service (${klar} ≤ ${nft} µs)"; else underkand "ordningen ångra → nftables stämmer inte (${klar} / ${nft})"; fi
  if [[ "$ssh" =~ ^[0-9]+$ ]] && (( klar > 0 && ssh > 0 && klar <= ssh )); then
    godkand "ångrandet var klart före ssh.service (${klar} ≤ ${ssh} µs)"; else underkand "ordningen ångra → ssh stämmer inte (${klar} / ${ssh})"; fi
  if [[ "$(passwd -S root | awk '{print $2}')" != L ]]; then godkand "root är inte låst"; else underkand "root är låst"; fi
  printf '\n   systemd efter omstart: %d godkända, %d underkända\n' "$GODKANDA" "$UNDERKANDA"
  (( UNDERKANDA == 0 ))
}

case "$FAS" in
  fore) fas_fore ;;
  efter) fas_efter ;;
  *) echo "okänd fas: ${FAS}" >&2; exit 2 ;;
esac
