# shellcheck shell=bash
# Scenario 'filer' — filer som skriptet lägger till i eller skapar, och inställningar som avvisas.
#
#   B4  tillägg i /etc/fstab, /etc/subuid, /etc/subgid: radbrytning, säkerhetskopia, findmnt --verify
#   B5  överlapp mellan dockremap-intervallet och andras subuid/subgid upptäcks; ops får inga
#   B6  SSH_PORT finns inte längre; 22 får inte stå bland de publika portarna
#   C   env-filens ägare, PLATFORM_ROOT, halvfärdig swapfil/XFS-avbild, gVisor utan kontrollsumma,
#       daemon.json valideras FÖRE bytet, inga kvarglömda tempfiler, Documentation= i enheten
#
# Source:as av i-container.sh.

scenario_filer() {
  forbered_vard
  lat_tailnet_session_finnas

  # ── B6 + C: inställningar som avvisas (ingenting på värden ska ha ändrats) ───────────────
  test_rubrik "B6: SSH_PORT är borttagen; port 22 får aldrig öppnas mot internet"
  SSH_PORT=2222 provision --dry-run
  if (( KOD != 0 )) && innehaller "$UT" "SSH_PORT"; then godkand "SSH_PORT=2222 avvisas med besked (den nådde aldrig sshd)"; else underkand "SSH_PORT=2222 godtogs (kod ${KOD})"; fi
  PUBLIC_TCP_PORTS="22 443" provision --dry-run
  if (( KOD != 0 )) && innehaller "$UT" "22"; then godkand "PUBLIC_TCP_PORTS med 22 avvisas"; else underkand "22 bland publika portar godtogs (kod ${KOD})"; fi
  PUBLIC_TCP_PORTS="443 70000" provision --dry-run
  if (( KOD != 0 )); then godkand "portnummer över 65535 avvisas"; else underkand "port 70000 godtogs"; fi
  PUBLIC_UDP_PORTS="0" provision --dry-run
  if (( KOD != 0 )); then godkand "port 0 avvisas"; else underkand "port 0 godtogs"; fi

  test_rubrik "C: env-filens ÄGARE kontrolleras, inte bara skrivbitarna"
  chown nobody "${INFRA}/provision.env"
  provision --dry-run
  if (( KOD != 0 )) && innehaller "$UT" "root"; then godkand "en provision.env som ägs av någon annan än root läses inte"; else underkand "en provision.env ägd av 'nobody' lästes in som root (kod ${KOD})"; fi
  chown root "${INFRA}/provision.env"

  test_rubrik "C: PLATFORM_ROOT valideras — state-filen source:as av verify.sh som root varje timme"
  local dalig
  # shellcheck disable=SC2016  # värdena ska stå ORDAGRANT, det är poängen
  for dalig in '/srv/x y' '/srv/$(touch /tmp/pwn)' '/srv/x;touch /tmp/pwn' '/srv/`id`' '/srv/../etc' 'srv/relativ' '/'; do
    PLATFORM_ROOT="$dalig" provision --dry-run
    if (( KOD != 0 )) && innehaller "$UT" "PLATFORM_ROOT"; then godkand "avvisas: ${dalig}"; else underkand "godtogs: ${dalig} (kod ${KOD})"; fi
  done
  kor_fas1
  PLATFORM_ROOT=/srv/plattform-2 provision --steg uppdatering >/dev/null
  PLATFORM_ROOT=/srv/plattform-2 provision --steg kataloger
  # shellcheck disable=SC1091
  if [[ "$( (. /etc/vibesandbox/provision.state; printf '%s' "$PLATFORM_ROOT") )" == "/srv/plattform-2" ]]; then godkand "state-filen går att läsa in och ger rätt PLATFORM_ROOT"; else underkand "state-filen ger fel PLATFORM_ROOT"; fi
  pastar_inte "state-filen innehåller ingen SSH_PORT" grep -q '^SSH_PORT=' /etc/vibesandbox/provision.state
  pastar_inte "inget av de avvisade värdena kördes som kod" test -e /tmp/pwn

  test_rubrik "C: gVisor utan låst kontrollsumma ⇒ avbrott (inte bara en varning)"
  : >"$ANROP"
  INSTALL_GVISOR=1 GVISOR_RELEASE=20260101 provision --steg gvisor
  if (( KOD != 0 )) && innehaller "$UT" "GVISOR_SHA512"; then godkand "INSTALL_GVISOR=1 utan GVISOR_SHA512 avbryter"; else underkand "gVisor utan kontrollsumma godtogs (kod ${KOD})"; fi
  pastar_inte "…och ingen runsc installerades" test -e /usr/local/bin/runsc
  INSTALL_GVISOR=1 GVISOR_RELEASE=20260101 GVISOR_SHA512=abc provision --steg gvisor --dry-run
  if (( KOD != 0 )); then godkand "en kontrollsumma som inte är 128 hex-tecken avvisas"; else underkand "trasig kontrollsumma godtogs"; fi

  # ── B5 ───────────────────────────────────────────────────────────────────────────────────
  test_rubrik "B5: ops får inga underordnade id:n — useradd ger annars ops just dockremap-intervallet"
  pastar_inte "ingen rad för ops i /etc/subuid" grep -q '^ops:' /etc/subuid
  pastar_inte "ingen rad för ops i /etc/subgid" grep -q '^ops:' /etc/subgid

  provision --steg brandvagg --bekrafta-tailscale-ssh --ingen-bekraftelse >/dev/null
  test_rubrik "B5: överlapp mellan dockremap-intervallet och en annan post ⇒ avbrott, ingen gissning"
  local post fil
  for post in 'annan:100000:65536' 'annan:165000:1000' 'annan:90000:10001' 'annan:120000:1'; do
    for fil in /etc/subuid /etc/subgid; do
      cp "$fil" /tmp/subid.fore; echo "$post" >>"$fil"
      provision --steg docker
      if (( KOD != 0 )) && innehaller "$UT" "annan" && innehaller "$UT" "överlappar"; then godkand "${fil}: ${post} ⇒ avbryter och pekar ut posten"; else underkand "${fil}: ${post} godtogs (kod ${KOD})"; visa_vid_fel 1; fi
      pastar_inte "  …och ingen dockremap-rad lades till" grep -q '^dockremap:' "$fil"
      cp /tmp/subid.fore "$fil"
    done
  done
  pastar_inte "…och Docker installerades inte av något av försöken" grep -q 'apt-get.*docker-ce' "$ANROP"

  # ── B4 ───────────────────────────────────────────────────────────────────────────────────
  test_rubrik "B4: tillägg i /etc/subuid och /etc/subgid när filen saknar avslutande radbrytning"
  printf 'annan:300000:65536' >/etc/subuid          # angränsar inte, överlappar inte
  printf 'annan:300000:65536' >/etc/subgid
  provision --steg docker
  if (( KOD == 0 )); then godkand "Docker-steget avslutas med 0"; else underkand "Docker-steget gav kod ${KOD}"; visa_vid_fel; fi
  for fil in /etc/subuid /etc/subgid; do
    if grep -qx 'annan:300000:65536' "$fil" && grep -qx 'dockremap:100000:65536' "$fil"; then godkand "${fil}: raderna smälte inte ihop"; else underkand "${fil}: $(tr '\n' '|' <"$fil")"; fi
    pastar "${fil}: säkerhetskopia av läget före finns" grep -qx 'annan:300000:65536' "${fil}.vibesandbox-fore"
    pastar "${fil}: läge 644 root" test "$(stat -c '%a %U' "$fil")" = "644 root"
  done

  test_rubrik "B4: tillägg i /etc/fstab — radbrytning, säkerhetskopia, findmnt --verify FÖRE bytet"
  printf '# en fstab utan avslutande radbrytning' >/etc/fstab
  cp /etc/fstab /tmp/fstab.fore
  provision --steg system
  if (( KOD == 0 )); then godkand "system-steget avslutas med 0"; else underkand "system-steget gav kod ${KOD}"; visa_vid_fel; fi
  if grep -qx '# en fstab utan avslutande radbrytning' /etc/fstab && grep -qx '/swapfile none swap sw,pri=10 0 0' /etc/fstab; then
    godkand "fstab: den gamla sista raden och swapraden är två rader"; else underkand "fstab: raderna smälte ihop: $(tr '\n' '|' </etc/fstab)"; fi
  pastar "fstab: säkerhetskopia av läget före finns" cmp -s /tmp/fstab.fore /etc/fstab.vibesandbox-fore
  pastar "fstab: kandidaten kontrollerades med findmnt --verify" grep -q '^findmnt --verify' "$ANROP"
  cp /etc/fstab /tmp/fstab.fore
  touch "${STUBBKATALOG}/findmnt-verify-fel"
  DOCKER_XFS_LOOP=1 provision --steg dockerdisk
  if (( KOD != 0 )) && innehaller "$UT" "findmnt --verify"; then godkand "underkänner findmnt --verify ⇒ steget avbryts"; else underkand "steget fortsatte trots underkänd fstab (kod ${KOD})"; fi
  pastar "…och /etc/fstab är orörd, byte för byte" cmp -s /tmp/fstab.fore /etc/fstab
  pastar_inte "…och ingenting monterades" test -e "${STUBBKATALOG}/tillstand/docker-monterad"
  find "${STUBBKATALOG}/findmnt-verify-fel" -delete
  if compgen -G '/etc/.fstab*' >/dev/null || compgen -G '/etc/fstab.vsb*' >/dev/null; then underkand "en tempfil ligger kvar bredvid fstab"; else godkand "ingen tempfil ligger kvar bredvid fstab"; fi

  # ── C: halvfärdiga filer ─────────────────────────────────────────────────────────────────
  test_rubrik "C: en halvfärdig XFS-avbild (avbrott mellan fallocate och mkfs) tolkas inte som klar"
  find /var/lib/vibesandbox-docker.xfs* -delete 2>/dev/null
  truncate -s 1G /var/lib/vibesandbox-docker.xfs
  DOCKER_XFS_LOOP=1 provision --steg dockerdisk
  if (( KOD != 0 )) && innehaller "$UT" "inte ett XFS"; then godkand "en fil på avbildens plats som inte är XFS ⇒ avbrott med besked"; else underkand "en tom fil godtogs som färdig XFS-avbild (kod ${KOD})"; fi
  pastar_inte "…och ingenting monterades" test -e "${STUBBKATALOG}/tillstand/docker-monterad"
  find /var/lib/vibesandbox-docker.xfs -delete
  truncate -s 1G /var/lib/vibesandbox-docker.xfs.ofardig
  DOCKER_XFS_LOOP=1 provision --steg dockerdisk
  if (( KOD == 0 )) && xfs_db -r -c 'sb 0' -c 'p magicnum' /var/lib/vibesandbox-docker.xfs 2>/dev/null | grep -q 0x58465342; then
    godkand "en kvarlämnad '.ofardig' görs om från början och blir ett riktigt XFS"; else underkand "kvarlämnad .ofardig hanterades inte (kod ${KOD})"; visa_vid_fel; fi
  pastar_inte "…och '.ofardig' är borta" test -e /var/lib/vibesandbox-docker.xfs.ofardig

  test_rubrik "C: en halvfärdig swapfil tolkas inte som klar"
  find "${STUBBKATALOG}/tillstand/swap-aktiv" /swapfile -delete 2>/dev/null
  truncate -s 64M /swapfile
  provision --steg system
  if (( KOD != 0 )) && innehaller "$UT" "swap"; then godkand "en /swapfile utan swap-huvud ⇒ avbrott med besked"; else underkand "en tom /swapfile aktiverades som swap (kod ${KOD})"; fi
  pastar_inte "…och ingen swapon kördes" test -e "${STUBBKATALOG}/tillstand/swap-aktiv"
  find /swapfile -delete
  truncate -s 64M /swapfile.ofardig
  provision --steg system
  if (( KOD == 0 )) && [[ "$(blkid -p -o value -s TYPE /swapfile 2>/dev/null)" == "swap" ]]; then godkand "en kvarlämnad '/swapfile.ofardig' görs om och blir riktig swap (blkid)"; else underkand "kvarlämnad swap-.ofardig hanterades inte (kod ${KOD})"; visa_vid_fel; fi
  pastar_inte "…och '.ofardig' är borta" test -e /swapfile.ofardig

  # ── C: validering före bytet ─────────────────────────────────────────────────────────────
  test_rubrik "C: daemon.json valideras som TEMPFIL — en underkänd kandidat ersätter aldrig den som gäller"
  cp /etc/docker/daemon.json /tmp/daemon.fore
  touch "${STUBBKATALOG}/dockerd-validate-fel"
  INSTALL_GVISOR=1 provision --steg docker
  if (( KOD != 0 )) && innehaller "$UT" "daemon.json"; then godkand "underkänd kandidat ⇒ avbrott"; else underkand "steget fortsatte med underkänd daemon.json (kod ${KOD})"; fi
  pastar "…och den gällande daemon.json är orörd" cmp -s /tmp/daemon.fore /etc/docker/daemon.json
  find "${STUBBKATALOG}/dockerd-validate-fel" -delete

  test_rubrik "C: övrigt"
  provision --steg overvakning
  if grep -Eq '^Documentation=(file:/[^ ]+|man:[^ ]+|https?://[^ ()]+)$' /etc/systemd/system/vibesandbox-verify.service; then godkand "Documentation= i enheten är en giltig URI"; else underkand "Documentation= är ogiltig: $(grep '^Documentation=' /etc/systemd/system/vibesandbox-verify.service)"; fi
  local mal
  mal="$(sed -n 's|^Documentation=file:||p' /etc/systemd/system/vibesandbox-verify.service)"
  if [[ -z "$mal" || -s "$mal" ]]; then godkand "…och pekar på något som finns"; else underkand "Documentation= pekar på ${mal}, som saknas"; fi
  local kvar
  kvar="$(find /etc /usr/local /var/lib -xdev \( -name '*.vsb-ny' -o -name '.*.vsb-ny' \) 2>/dev/null)"
  if [[ -z "$kvar" ]]; then godkand "inga kvarglömda tempfiler från atomiska skrivningar"; else underkand "kvarglömda tempfiler: ${kvar}"; fi
}
