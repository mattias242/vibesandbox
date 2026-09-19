#!/usr/bin/env bash
# Testsviten som körs INUTI en engångscontainer (startas av kor-tester.sh, aldrig direkt på
# din dator eller på en server). Ett scenario per container ⇒ varje scenario börjar på en
# orörd "värd".
#
# Riktigt i containern: useradd/usermod, sshd -t / sshd -T, nft (kräver --cap-add NET_ADMIN),
# cloud-inits sammanslagning, gpg-fingeravtryck, filrättigheter.
# Stubbat (se stubbar/stubb): systemctl, apt-get, tailscale, docker, sysctl, swap, mount.

# Inte pipefail: 'nft list … | grep -q' ger SIGPIPE till nft när grep hittar sin träff, och
# ett godkänt test skulle då slumpvis räknas som underkänt.
set -u

SCENARIO="${1:?ange scenario}"
INFRA=/opt/infra
STUBBAR=/opt/stubbar
export STUBBKATALOG=/var/lib/stubb
ANROP="${STUBBKATALOG}/anrop.log"

GODKANDA=0
UNDERKANDA=0

godkand()  { printf '  ✓ %s\n' "$*"; GODKANDA=$(( GODKANDA + 1 )); }
underkand() { printf '  ✗ %s\n' "$*"; UNDERKANDA=$(( UNDERKANDA + 1 )); }
test_rubrik() { printf '\n── %s\n' "$*"; }

# pastar <beskrivning> <kommando…> — godkänt om kommandot lyckas.
pastar() { local b="$1"; shift; if "$@" >/dev/null 2>&1; then godkand "$b"; else underkand "$b"; fi; }
pastar_inte() { local b="$1"; shift; if "$@" >/dev/null 2>&1; then underkand "$b"; else godkand "$b"; fi; }
innehaller() { grep -qE -- "$2" <<<"$1"; }

# Kör provision/verify med stubbarna först i PATH. Utdata i $UT, slutkod i $KOD.
UT=""; KOD=0
provision() {
  UT="$(PATH="${STUBBAR}:${PATH}" "${INFRA}/provision.sh" "$@" 2>&1)"; KOD=$?
}
verifiera() {
  UT="$(PATH="${STUBBAR}:${PATH}" "${INFRA}/verify.sh" "$@" 2>&1)"; KOD=$?
}
# provision_pty <handling>… -- <flaggor>: som provision, men med en RIKTIG styrterminal, så att
# JA-frågan går att besvara — eller avbryta med Ctrl-C, SIGTERM och kill -9. Se pty-kor.py.
provision_pty() {
  local h=()
  while [[ "$1" != "--" ]]; do h+=(--handling "$1"); shift; done
  shift
  UT="$(PATH="${STUBBAR}:${PATH}" python3 /infra/test/pty-kor.py --tidsgrans 120 "${h[@]}" -- "${INFRA}/provision.sh" "$@" 2>&1)"; KOD=$?
}
# Starta en riktig sshd i containern (ingen systemd här). Läser samma filer som på en värd.
# shellcheck disable=SC2120  # flaggorna ges från scenarier/verify.sh och i-container-tung.sh
starta_sshd() { # [extra flaggor till sshd]
  pkill -x sshd 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x sshd >/dev/null || break; sleep 0.2; done
  ssh-keygen -A >/dev/null 2>&1
  mkdir -p /run/sshd
  # Nyare OpenSSH straffar en källadress efter upprepade misslyckade inloggningar — testet gör
  # många provinloggningar i rad från 127.0.0.1. (Äldre sshd känner inte flaggan.)
  local straff=()
  /usr/sbin/sshd -t -o PerSourcePenalties=no "$@" >/dev/null 2>&1 && straff=(-o PerSourcePenalties=no)
  /usr/sbin/sshd "${straff[@]}" "$@"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ssh-keyscan -T 1 127.0.0.1 >/dev/null 2>&1 && return 0
    sleep 0.3
  done
  return 1
}

visa_vid_fel() { if (( KOD != ${1:-0} )); then printf '%s\n' "$UT" | tail -n 25 | sed 's/^/      | /'; fi; }

# Ögonblicksbild av allt skripten får röra: sökväg, läge, ägare, ändringstid och innehåll.
ogonblicksbild() {
  find /etc /srv /home /usr/local /var/lib/vibesandbox-docker.xfs /swapfile "${STUBBKATALOG}/tillstand" \
    -xdev \( -type f -o -type d -o -type l \) \
    -not -path '/etc/.pwd.lock' -not -path '/etc/ld.so.cache' \
    -printf '%p %m %u:%g %T@ %s\n' 2>/dev/null | sort
  find /etc /srv /home /usr/local -xdev -type f -not -path '/etc/.pwd.lock' -exec sha256sum {} + 2>/dev/null | sort -k2
}

forbered_vard() {
  mkdir -p "$INFRA" "$STUBBAR" "${STUBBKATALOG}/tillstand"/{maskad,aktiverad,aktiv,paket}
  cp /infra/provision.sh /infra/verify.sh /infra/angra.sh /infra/vibesandbox-angra-uppstart.service \
    /infra/README.md /infra/provision.env.example "$INFRA/"
  chmod +x "$INFRA"/*.sh
  local k
  for k in systemctl systemd-run journalctl apt-get dpkg-query tailscale docker dockerd sysctl swapon fallocate mkswap mount findmnt timedatectl usermod chpasswd; do
    ln -sf /infra/test/stubbar/stubb "${STUBBAR}/${k}"
  done
  # Ångra-skriptet har FAST PATH (det körs av en timer, utan vår miljö) och ser därför inte
  # stubbkatalogen. /usr/local/sbin står först i den fasta sökvägen ⇒ där når stubben det.
  ln -sf /infra/test/stubbar/stubb /usr/local/sbin/systemctl
  # …och det ångra-skriptet använder när ett ångrande misslyckas: en ny timer, journalen, wall.
  for k in systemd-run systemd-cat wall; do ln -sf /infra/test/stubbar/stubb "/usr/local/sbin/${k}"; done

  # Leverantörens egenheter, så som kartläggningen beskriver dem.
  for k in apt-daily.service apt-daily.timer apt-daily-upgrade.service apt-daily-upgrade.timer unattended-upgrades.service; do
    touch "${STUBBKATALOG}/tillstand/maskad/${k}"
  done
  # …och två till: en som skriptet behöver (ska avmaskas) och en som det inte behöver (ska lämnas).
  touch "${STUBBKATALOG}/tillstand/maskad/nftables.service" "${STUBBKATALOG}/tillstand/maskad/cockpit.socket"
  cp /infra/test/fixturer/ssh/*.conf /etc/ssh/sshd_config.d/
  cp /infra/test/fixturer/sysctl/*.conf /etc/sysctl.d/
  mkdir -p /etc/cloud/cloud.cfg.d && cp /infra/test/fixturer/cloud/*.cfg /etc/cloud/cloud.cfg.d/
  # Ubuntus containeravbild har en standardanvändare 'ubuntu' i sudo. verify.sh flaggar den
  # (med rätta) som avdrift; en riktig Ubuntu-värd ska inte ha den kvar. Se README.
  if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu >/dev/null 2>&1; fi
  # Leverantören sätter ett root-lösenord; i Debians containeravbild är root låst från början.
  usermod -p "$(openssl passwd -6 -salt rotsalt 'leverantorens-rotlosenord')" root
  : >"$ANROP"

  # En riktig nyckel och en riktig lösenordshash, skapade här — inga hemligheter i repot.
  ssh-keygen -q -t ed25519 -N '' -C test@example.org -f /tmp/testnyckel
  cat >"${INFRA}/provision.env" <<EOF
OPS_SSH_PUBKEY_FILE=/tmp/testnyckel.pub
OPS_PASSWORD_HASH='$(openssl passwd -6 -salt testsalt 'bara-ett-testlosenord')'
DOCKER_XFS_SIZE_GB=1
EOF
  chmod 600 "${INFRA}/provision.env"
}

# En pågående SSH-session från tailnetet, så som 'ss' skulle visa den — och raden i sshd:s
# journal som visar att JUST DEN sessionen (samma adress och port) loggade in med NYCKEL som ops.
lat_tailnet_session_finnas() {
  ln -sf /infra/test/stubbar/stubb "${STUBBAR}/ss"
  echo "0 0 203.0.113.10:22 100.101.102.103:51234" >"${STUBBKATALOG}/ss-etablerade"
  # sshd själv lyssnar på 22 (verify.sh kräver att den syns bland lyssnarna).
  printf 'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=2,fd=3))\n' >"${STUBBKATALOG}/ss-lyssnare"
  echo "Accepted publickey for ops from 100.101.102.103 port 51234 ssh2: ED25519 SHA256:exempelexempelexempelexempelexempelexempel" >"${STUBBKATALOG}/journal"
}

# Auth-nyckeln ges som en rootägd 600-fil — aldrig via miljön (B3). Filen raderas av skriptet
# efter lyckad anslutning; vid en andra körning är värden redan ansluten och filen behövs inte.
kor_fas1() {
  ( umask 077; printf 'tskey-auth-HEMLIG-TESTNYCKEL' >/root/ts.nyckel )
  TAILSCALE_AUTHKEY_FILE=/root/ts.nyckel provision
}

# ── Scenarier ──────────────────────────────────────────────────────────────────────────────

scenario_statisk() {
  test_rubrik "Statisk granskning"
  pastar "bash -n provision.sh" bash -n /infra/provision.sh
  pastar "bash -n verify.sh" bash -n /infra/verify.sh
  pastar "bash -n angra.sh" bash -n /infra/angra.sh
  pastar "pty-kor.py går att kompilera" python3 -c 'import ast,sys; ast.parse(open("/infra/test/pty-kor.py").read())'
  if LC_ALL=C.UTF-8 shellcheck -x /infra/provision.sh /infra/verify.sh /infra/angra.sh /infra/test/*.sh /infra/test/scenarier/*.sh /infra/test/stubbar/stubb; then
    godkand "shellcheck utan anmärkningar ($(shellcheck --version | sed -n 's/^version: //p'))"
  else
    underkand "shellcheck har anmärkningar"
  fi
  # Det publika repot får inte innehålla adresser eller nycklar. Dokumentationsnäten
  # (203.0.113.0/24 m.fl.), CGNAT-exemplet 100.64–100.127 och RFC1918-näten i brandväggen är tillåtna.
  local traffar
  traffar="$(grep -rnoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' /infra --include='*' \
    | grep -vE ':(203\.0\.113\.|192\.0\.2\.|198\.51\.100\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|10\.0\.0\.0|127\.|169\.254\.|172\.16\.0\.0|192\.168\.0\.0|0\.0\.0\.0|1\.1\.1\.1)' || true)"
  if [[ -z "$traffar" ]]; then godkand "inga riktiga IP-adresser i infra/"; else underkand "möjliga riktiga IP-adresser: ${traffar}"; fi
  # Skripten ska vara leverantörsoberoende. Namnet skrivs isär här så att kontrollen inte träffar sig själv.
  pastar_inte "leverantörens namn förekommer inte i infra/" grep -rqi "host""up" /infra
  pastar_inte "inga privata nycklar eller auth-nycklar i infra/" \
    grep -rqE 'BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|tskey-(auth|api)-[A-Za-z0-9]{8,}-' /infra --exclude=i-container.sh
}

scenario_vagran() {
  forbered_vard
  test_rubrik "Skriptet vägrar när förutsättningarna inte stämmer"

  chmod -R a+rX "$INFRA" "$STUBBAR"
  UT="$(su nobody -s /bin/bash -c "${INFRA}/provision.sh --dry-run" 2>&1)"; KOD=$?
  if (( KOD != 0 )) && innehaller "$UT" "måste köras som root"; then godkand "vägrar utan root"; else underkand "kör utan root (kod ${KOD})"; fi
  UT="$(su nobody -s /bin/bash -c "${INFRA}/verify.sh" 2>&1)"; KOD=$?
  if (( KOD == 2 )); then godkand "verify.sh vägrar utan root"; else underkand "verify.sh utan root gav kod ${KOD}"; fi

  OS_RELEASE_FILE=/infra/test/fixturer/os/fedora provision --dry-run
  if (( KOD != 0 )) && innehaller "$UT" "stöder bara Debian"; then godkand "vägrar på Fedora"; else underkand "kör på Fedora"; fi
  OS_RELEASE_FILE=/infra/test/fixturer/os/debian11 provision --dry-run
  if (( KOD != 0 )); then godkand "vägrar på Debian 11"; else underkand "kör på Debian 11"; fi

  chmod 666 "${INFRA}/provision.env"; provision --dry-run
  if (( KOD != 0 )) && innehaller "$UT" "chmod 600"; then godkand "vägrar läsa en provision.env som andra kan skriva i"; else underkand "läser en skrivbar provision.env"; fi
  chmod 600 "${INFRA}/provision.env"

  provision --steg finns-inte
  if (( KOD != 0 )) && innehaller "$UT" "okänt steg"; then godkand "vägrar okänt steg"; else underkand "okänt steg accepterades"; fi
  provision --okand-flagga
  if (( KOD != 0 )); then godkand "vägrar okänd flagga"; else underkand "okänd flagga accepterades"; fi
  SSH_PORT=abc provision --dry-run
  if (( KOD != 0 )) && innehaller "$UT" "SSH_PORT"; then godkand "vägrar SSH_PORT (inställningen finns inte längre)"; else underkand "SSH_PORT accepterades"; fi
  OPS_USER=root provision --dry-run
  if (( KOD != 0 )); then godkand "vägrar OPS_USER=root"; else underkand "OPS_USER=root accepterades"; fi
  PUBLIC_TCP_PORTS='443; drop' provision --dry-run
  if (( KOD != 0 )); then godkand "vägrar portlista med skräp (nft-injektion)"; else underkand "portlista med skräp accepterades"; fi
  INSTALL_GVISOR=1 provision --steg gvisor
  if (( KOD != 0 )) && innehaller "$UT" "GVISOR_RELEASE"; then godkand "gVisor kräver låst utgåva"; else underkand "gVisor utan låst utgåva accepterades"; fi

  test_rubrik "Ordningen är ett säkerhetskrav"
  provision --steg brandvagg
  if (( KOD != 0 )) && innehaller "$UT" "bekrafta-tailscale-ssh"; then godkand "brandvägg vägrar utan --bekrafta-tailscale-ssh"; else underkand "brandvägg kördes utan bekräftelse"; fi
  provision --steg ssh
  if (( KOD != 0 )); then godkand "SSH-härdning vägrar utan --bekrafta-tailscale-ssh"; else underkand "SSH-härdning kördes utan bekräftelse"; fi
  provision --steg brandvagg --bekrafta-tailscale-ssh
  if (( KOD != 0 )) && innehaller "$UT" "Tailscale är inte anslutet"; then godkand "brandvägg vägrar när Tailscale inte är uppe"; else underkand "brandvägg kördes utan Tailscale"; fi
  provision --steg docker
  if (( KOD != 0 )) && innehaller "$UT" "aldrig vara uppe utan brandvägg"; then godkand "Docker vägrar utan laddad brandvägg"; else underkand "Docker installerades utan brandvägg"; visa_vid_fel 1; fi
  pastar_inte "…och ingen Docker-installation påbörjades" grep -q 'apt-get.*docker-ce' "$ANROP"

  kor_fas1
  provision --steg brandvagg --bekrafta-tailscale-ssh
  if (( KOD != 0 )) && innehaller "$UT" "ingen pågående SSH-session från tailnetet"; then godkand "brandvägg vägrar utan pågående tailnet-session"; else underkand "brandvägg kördes utan tailnet-session"; visa_vid_fel 1; fi
  ln -sf /infra/test/stubbar/stubb "${STUBBAR}/ss"
  echo "0 0 203.0.113.10:22 198.51.100.7:40000" >"${STUBBKATALOG}/ss-etablerade"
  provision --steg brandvagg --bekrafta-tailscale-ssh
  if (( KOD != 0 )); then godkand "en session från en PUBLIK adress räknas inte"; else underkand "publik session godtogs som tailnet"; fi
  pastar_inte "ingen brandväggstabell laddades av de vägrade försöken" nft list table inet vibesandbox

  # SSH-steget får inte stänga roots väg in om ops inte kan ta över.
  lat_tailnet_session_finnas
  passwd -d ops >/dev/null 2>&1
  sed -i '/^OPS_PASSWORD_HASH/d' "${INFRA}/provision.env"
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD != 0 )) && innehaller "$UT" "saknar lösenord"; then godkand "SSH-härdning vägrar när ops saknar lösenord (ingen kunde bli root)"; else underkand "SSH härdades fast ops saknar lösenord"; fi
  pastar_inte "…och ingen dropin skrevs" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
}

scenario_dryrun() {
  forbered_vard
  test_rubrik "--dry-run ändrar ingenting"
  local fore efter
  fore="$(ogonblicksbild)"
  : >"$ANROP"
  provision --dry-run
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "dry-run avslutas med 0"; else underkand "dry-run gav kod ${KOD}"; visa_vid_fel; fi
  if [[ "$fore" == "$efter" ]]; then godkand "filsystemet är orört (läge, ägare, tid och innehåll)"; else underkand "dry-run ändrade filer:"; diff <(echo "$fore") <(echo "$efter") | head -n 20; fi
  local n
  n="$(grep -c '^==> Steg' <<<"$UT")"
  if (( n == 12 )); then godkand "alla 12 steg redovisas"; else underkand "bara ${n} steg redovisades"; fi
  if grep -vE '^(systemctl (is-enabled|is-active|list-timers|list-unit-files)|dpkg-query|tailscale (ip|status)|swapon --show[^ ]*|findmnt) ' "$ANROP" | grep -q .; then
    underkand "dry-run körde ändrande kommandon:"; grep -vE '^(systemctl (is-enabled|is-active|list-timers|list-unit-files)|dpkg-query|tailscale (ip|status)|swapon --show[^ ]*|findmnt) ' "$ANROP" | head | sed 's/^/      | /'
  else
    godkand "bara läsande kommandon kördes"
  fi
  pastar_inte "ingen loggfil skapades" test -e /var/log/vibesandbox-provision.log
  pastar_inte "ingen brandväggstabell laddades" nft list table inet vibesandbox
  provision --dry-run --bekrafta-tailscale-ssh
  if (( KOD == 0 )); then godkand "dry-run med --bekrafta-tailscale-ssh avslutas med 0"; else underkand "kod ${KOD}"; fi

  # Sett på en riktig värd: förrådsnyckeln fanns redan men gnupg gör det inte (installeras först
  # i steg 1, vilket en torrkörning hoppar över). gpg:s "command not found" gick till /dev/null
  # och skriptet dog tyst med 127 mitt i steg 3.
  test_rubrik "--dry-run när en förrådsnyckel redan finns men gpg saknas"
  local gpg_sokvag
  gpg_sokvag="$(command -v gpg)"
  mv "$gpg_sokvag" /tmp/gpg.undanstoppad
  mkdir -p /usr/share/keyrings
  printf 'inte en riktig nyckel\n' >/usr/share/keyrings/tailscale-archive-keyring.gpg
  provision --dry-run
  if (( KOD == 0 )); then godkand "dry-run avslutas med 0 trots att gpg saknas"; else underkand "dry-run gav kod ${KOD}"; visa_vid_fel; fi
  if innehaller "$UT" "gpg saknas"; then godkand "torrkörningen säger att fingeravtrycket inte kunde kontrolleras"; else underkand "inget besked om att gpg saknas"; fi
  n="$(grep -c '^==> Steg' <<<"$UT")"
  if (( n == 12 )); then godkand "alla 12 steg redovisas ändå"; else underkand "bara ${n} steg redovisades"; fi
  mv /tmp/gpg.undanstoppad "$gpg_sokvag"
  rm -f /usr/share/keyrings/tailscale-archive-keyring.gpg
}

scenario_fas1() {
  forbered_vard
  test_rubrik "Fas 1: uppdatering, driftanvändare, Tailscale — och sedan STOPP"
  kor_fas1
  if (( KOD == 0 )); then godkand "fas 1 avslutas med 0"; else underkand "fas 1 gav kod ${KOD}"; visa_vid_fel; fi
  if innehaller "$UT" "FAS 1 KLAR"; then godkand "skriptet stannar och ber ägaren verifiera SSH över tailnet"; else underkand "inget stopp efter fas 1"; fi
  pastar_inte "brandväggen är INTE laddad" nft list table inet vibesandbox
  pastar_inte "SSH är INTE härdat" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  # Körordningen kräver att fas 2 körs i tmux (en tappad anslutning får inte döda skriptet mitt i
  # brandväggssteget) — då måste tmux finnas när fas 1 är klar. En ren Debian-avbild saknar det.
  pastar "tmux installeras i fas 1, så att fas 2 kan köras i tmux" test -e "${STUBBKATALOG}/tillstand/paket/tmux"

  local e
  for e in apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service; do
    pastar_inte "${e} är avmaskad" test -e "${STUBBKATALOG}/tillstand/maskad/${e}"
    pastar "${e} är aktiverad" test -e "${STUBBKATALOG}/tillstand/aktiverad/${e}"
  done
  if awk '/unmask apt-daily.timer/{u=NR} /enable --now apt-daily.timer/{e=NR} END{exit !(u && e && u<e)}' "$ANROP"; then
    godkand "unmask sker FÖRE enable"; else underkand "unmask/enable i fel ordning"; fi
  pastar "apt-konfigurationen går att läsa (apt-config dump)" apt-config dump
  # shellcheck disable=SC2016  # ${distro_codename} ska matchas ordagrant
  if apt-config dump | grep -qE 'Unattended-Upgrade::Origins-Pattern:: "origin=(Debian,codename|Ubuntu,archive)=\$\{distro_codename\}-security'; then
    godkand "säkerhetsarkivet finns i Origins-Pattern (effektivt)"; else underkand "säkerhetsarkivet saknas i Origins-Pattern"; fi

  pastar "ops finns" id ops
  if id -nG ops | grep -qw sudo; then godkand "ops är med i sudo"; else underkand "ops är inte med i sudo"; fi
  if id -nG ops | grep -qw docker; then underkand "ops är med i docker"; else godkand "ops är inte med i docker"; fi
  pastar "authorized_keys är exakt den konfigurerade nyckeln" cmp -s /tmp/testnyckel.pub /home/ops/.ssh/authorized_keys
  if [[ "$(stat -c '%a %U' /home/ops/.ssh/authorized_keys)" == "600 ops" && "$(stat -c '%a %U' /home/ops/.ssh)" == "700 ops" ]]; then
    godkand ".ssh 700 / authorized_keys 600, ägda av ops"; else underkand "fel rättigheter på .ssh"; fi
  if [[ "$(passwd -S ops | awk '{print $2}')" == "P" ]]; then godkand "ops har ett användbart lösenord (sudo + webbkonsol)"; else underkand "ops saknar lösenord"; fi

  pastar "Tailscales nyckel installerad efter fingeravtryckskontroll" test -s /usr/share/keyrings/tailscale-archive-keyring.gpg
  if grep -q 'HEMLIG' "$ANROP"; then underkand "auth-nyckeln syns på kommandoraden"; else godkand "auth-nyckeln ges via fil, syns aldrig på kommandoraden"; fi
  if [[ "$(cat "${STUBBKATALOG}/tillstand/tailscale-nyckelfil-lage" 2>/dev/null)" == "600" ]]; then godkand "nyckelfilen hade läge 600"; else underkand "nyckelfilen hade fel läge"; fi
  if compgen -G '/run/vibesandbox-ts.*' >/dev/null; then underkand "nyckelfilen ligger kvar i /run"; else godkand "nyckelfilen är borttagen"; fi
  if grep -rq 'HEMLIG' /etc /var/log 2>/dev/null; then underkand "auth-nyckeln har hamnat på disk"; else godkand "auth-nyckeln finns inte i /etc eller loggen"; fi
  if grep -q 'tailscale up.*--ssh=false.*--accept-routes=false' "$ANROP"; then godkand "tailscale up: --ssh=false --accept-routes=false"; else underkand "tailscale up saknar spärrflaggor"; fi
  if innehaller "$UT" "med taggarna tag:vibesandbox"; then godkand "noden kontrolleras ha taggen tag:vibesandbox efter anslutning"; else underkand "ingen kontroll av nodens tagg"; fi

  test_rubrik "Fas 1 en gång till: idempotens"
  local fore efter
  fore="$(ogonblicksbild)"; : >"$ANROP"
  kor_fas1
  efter="$(ogonblicksbild)"
  if [[ "$fore" == "$efter" ]]; then godkand "andra körningen ändrade inga filer"; else underkand "andra körningen ändrade filer:"; diff <(echo "$fore") <(echo "$efter") | head -n 20; fi
  if grep -E '^(systemctl (unmask|enable|restart)|tailscale up|apt-get install)' "$ANROP" | grep -q .; then
    underkand "andra körningen gjorde om saker:"; grep -E '^(systemctl (unmask|enable|restart)|tailscale up|apt-get install)' "$ANROP" | sed 's/^/      | /'
  else godkand "inget avmaskades, aktiverades, installerades eller anslöts en gång till"; fi

  test_rubrik "Fel fingeravtryck ⇒ nyckeln installeras inte"
  mv /usr/share/keyrings/tailscale-archive-keyring.gpg /tmp/ts-nyckel.bak
  TAILSCALE_NYCKEL_FPR=0000000000000000000000000000000000000000 provision --steg tailscale
  if (( KOD != 0 )) && innehaller "$UT" "Installerar den INTE"; then godkand "avbryter vid fel fingeravtryck"; else underkand "fel fingeravtryck accepterades"; fi
  pastar_inte "ingen nyckel installerades" test -e /usr/share/keyrings/tailscale-archive-keyring.gpg
  mv /tmp/ts-nyckel.bak /usr/share/keyrings/tailscale-archive-keyring.gpg

  # Sett på en riktig värd: Tailscale installerat och inloggat för hand, utan tagg. Då räknas
  # servern som en av ägarens enheter och når hela tailnetet — "ansluten" är inte "klart".
  test_rubrik "Redan ansluten UTAN tagg ⇒ fas 1 stannar, torrkörningen säger till"
  find "${STUBBKATALOG}/tillstand/tailscale-taggar" -delete
  : >"$ANROP"
  kor_fas1
  if (( KOD != 0 )) && innehaller "$UT" "taggarna '‹inga›', inte 'tag:vibesandbox'"; then
    godkand "fas 1 avbryter när noden saknar taggen"; else underkand "otaggad nod accepterades (kod ${KOD})"; visa_vid_fel 1; fi
  if innehaller "$UT" "FAS 1 KLAR"; then underkand "fas 1 sade KLAR trots otaggad nod"; else godkand "inget FAS 1 KLAR med otaggad nod"; fi
  if grep -q '^tailscale up' "$ANROP"; then underkand "skriptet bytte identitet på noden på egen hand"; else godkand "skriptet rör inte nodens identitet — ägaren loggar ut själv"; fi
  provision --dry-run
  if (( KOD == 0 )) && innehaller "$UT" "skulle avbryta här: servern är redan ansluten"; then
    godkand "torrkörningen visar att fas 1 skulle stanna"; else underkand "torrkörningen sade inget (kod ${KOD})"; visa_vid_fel; fi
  printf 'tag:annan' >"${STUBBKATALOG}/tillstand/tailscale-taggar"
  kor_fas1
  if (( KOD != 0 )) && innehaller "$UT" "taggarna 'tag:annan', inte 'tag:vibesandbox'"; then
    godkand "fel tagg avvisas också"; else underkand "fel tagg accepterades (kod ${KOD})"; fi
}

scenario_angra() {
  forbered_vard
  lat_tailnet_session_finnas
  kor_fas1
  test_rubrik "Död mans grepp: ingen bekräftelse ⇒ ändringen ångras (containern saknar terminal)"

  provision --steg brandvagg --bekrafta-tailscale-ssh
  if (( KOD != 0 )); then godkand "brandväggssteget avslutas med fel utan JA"; else underkand "brandväggssteget lyckades utan JA"; fi
  pastar_inte "brandväggstabellen är borttagen igen" nft list table inet vibesandbox

  provision --steg brandvagg --bekrafta-tailscale-ssh --ingen-bekraftelse
  provision --steg ssh --bekrafta-tailscale-ssh
  if (( KOD != 0 )); then godkand "SSH-steget avslutas med fel utan JA"; else underkand "SSH-steget lyckades utan JA"; fi
  pastar_inte "SSH-dropin är borttagen igen" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  pastar "sshd-konfigurationen är fortfarande giltig" sshd -t
  if [[ "$(passwd -S root | awk '{print $2}')" != "L" ]]; then godkand "roots lösenord låstes INTE (låses först efter bekräftelse)"; else underkand "root låstes trots ångrad härdning"; fi
  pastar "ångrandet är loggat" grep -q 'ÅNGRAR SSH-härdning' /var/log/vibesandbox-provision.log

  test_rubrik "En främmande dropin som sorteras före vår och vinner ⇒ ingen härdning, tydligt besked"
  echo "PermitRootLogin yes" >/etc/ssh/sshd_config.d/0-0-aaa.conf
  : >"$ANROP"
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD != 0 )) && innehaller "$UT" "0-0-aaa.conf"; then godkand "avbryter och pekar ut filen"; else underkand "härdade trots en dropin som vinner över vår"; fi
  pastar_inte "sshd laddades inte om" grep -q 'systemctl reload' "$ANROP"
  pastar_inte "vår dropin ligger inte kvar" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  mv /etc/ssh/sshd_config.d/0-0-aaa.conf /tmp/

  test_rubrik "sshd_config utan Include-rad (eller med direktiv före den)"
  cp /etc/ssh/sshd_config /tmp/sshd_config.orig
  { echo "PermitRootLogin yes"; grep -v '^Include' /tmp/sshd_config.orig; } >/etc/ssh/sshd_config
  provision --steg ssh --bekrafta-tailscale-ssh
  if (( KOD != 0 )) && cmp -s <(echo "PermitRootLogin yes"; grep -v '^Include' /tmp/sshd_config.orig) /etc/ssh/sshd_config; then godkand "utan JA: även ändringen i sshd_config ångras, byte för byte"; else underkand "sshd_config återställdes inte"; fi
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD == 0 )) && [[ "$(sshd -T -C user=root,host=localhost,addr=203.0.113.10 2>/dev/null | grep -i '^permitrootlogin ')" == "permitrootlogin no" ]]; then
    godkand "Include läggs först ⇒ vår dropin vinner över direktivet i huvudfilen (sshd -T: permitrootlogin no)"
  else underkand "Include-hanteringen fungerade inte"; visa_vid_fel; fi
  cp /tmp/sshd_config.orig /etc/ssh/sshd_config
  mv /etc/ssh/sshd_config.d/0-0-vibesandbox.conf /tmp/
  passwd -u root >/dev/null 2>&1

  test_rubrik "En trasig sshd-konfiguration laddas aldrig"
  echo "DettaArIngetDirektiv ja" >/etc/ssh/sshd_config.d/10-trasig.conf
  : >"$ANROP"
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD != 0 )) && innehaller "$UT" "sshd -t"; then godkand "avbryter när 'sshd -t' underkänner"; else underkand "fortsatte trots trasig konfiguration"; fi
  pastar_inte "sshd laddades inte om" grep -q 'systemctl reload' "$ANROP"
  pastar_inte "vår dropin ligger inte kvar" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
}

scenario_fas2() {
  forbered_vard
  lat_tailnet_session_finnas
  kor_fas1
  test_rubrik "Fas 2: brandvägg → SSH → leverantör → Docker → system → kataloger → övervakning"
  provision --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD == 0 )); then godkand "fas 2 avslutas med 0"; else underkand "fas 2 gav kod ${KOD}"; visa_vid_fel; fi
  FAS2_UT="$UT"

  test_rubrik "Brandvägg (riktigt laddad med nft i containerns nätverksnamnrymd)"
  local regler
  regler="$(nft -s list table inet vibesandbox 2>&1)"
  if innehaller "$regler" 'hook input priority filter; policy drop;'; then godkand "input: policy drop"; else underkand "input saknar policy drop"; fi
  if innehaller "$regler" 'hook forward priority filter - 10; policy drop;'; then godkand "forward: policy drop, prioritet före Docker"; else underkand "forward saknar policy drop"; fi
  if innehaller "$regler" 'iifname "tailscale0" tcp dport 22 accept'; then godkand "SSH bara på tailscale0"; else underkand "SSH-regeln saknas"; fi
  if [[ "$(grep -c 'dport 22 ' <<<"$regler")" == 1 ]]; then godkand "ingen annan regel nämner port 22"; else underkand "port 22 förekommer i fler regler"; fi
  if innehaller "$regler" 'tcp dport 443 accept' && innehaller "$regler" 'udp dport 443 accept'; then godkand "443/tcp och 443/udp öppna"; else underkand "443 saknas"; fi
  if innehaller "$regler" '100\.64\.0\.0/10' && innehaller "$regler" '169\.254\.0\.0/16' && innehaller "$regler" '192\.168\.0\.0/16'; then godkand "containrar spärras mot tailnet, länklokalt och RFC1918"; else underkand "spärrlistan är ofullständig"; fi
  if innehaller "$regler" 'tcp dport \{ 25, 465, 587 \} counter drop'; then godkand "containrar spärras mot SMTP"; else underkand "SMTP-spärren saknas"; fi
  if innehaller "$regler" 'ct status dnat .*ct original proto-dst 443 accept'; then godkand "bara DNAT mot uttryckligen öppnade portar släpps in till containrar"; else underkand "DNAT-regeln saknas"; fi
  pastar_inte "/etc/nftables.conf saknar 'flush ruleset'" grep -Eq '^\s*flush ruleset' /etc/nftables.conf
  pastar "nftables.service aktiverad" test -e "${STUBBKATALOG}/tillstand/aktiverad/nftables.service"
  # En främmande tabell (som Dockers) ska överleva en omladdning av vår.
  nft add table ip docker-latsas && nft -f /etc/nftables.conf
  pastar "omladdning rör inte andras tabeller" nft list table ip docker-latsas
  nft delete table ip docker-latsas

  test_rubrik "SSH (riktig sshd -T, med leverantörens dropins på plats)"
  local t
  t="$(sshd -T -C user=root,host=localhost,addr=203.0.113.10 2>/dev/null)"
  local par
  for par in "permitrootlogin no" "passwordauthentication no" "kbdinteractiveauthentication no" "allowusers ops" \
    "allowagentforwarding no" "allowtcpforwarding no" "maxauthtries 3"; do
    if grep -qix "$par" <<<"$t"; then godkand "effektivt: ${par}"; else underkand "effektivt läge saknar '${par}' (är: $(grep -i "^${par%% *} " <<<"$t"))"; fi
  done
  pastar "andras dropins ligger orörda kvar" cmp -s /infra/test/fixturer/ssh/00-leverantor-auth.conf /etc/ssh/sshd_config.d/00-leverantor-auth.conf
  if awk '/reload ssh/{r=NR} END{exit !r}' "$ANROP"; then godkand "sshd laddades om (inte omstartad)"; else underkand "sshd laddades aldrig om"; fi
  # B-2: med --ingen-bekraftelse har ingen människa svarat JA ⇒ root låses inte.
  if [[ "$(passwd -S root | awk '{print $2}')" != "L" ]] && innehaller "$FAS2_UT" 'roots lösenord låses INTE'; then
    godkand "--ingen-bekraftelse: roots lösenord låses INTE, och skriptet säger det"; else underkand "root låstes med --ingen-bekraftelse, eller inget besked"; fi
  provision_pty "Skriv JA inom=>skicka:JA" -- --steg ssh --bekrafta-tailscale-ssh
  if (( KOD == 0 )) && [[ "$(passwd -S root | awk '{print $2}')" == "L" ]]; then godkand "SSH-steget med ett riktigt JA: roots lösenord är låst"; else underkand "root låstes inte efter JA (kod ${KOD})"; visa_vid_fel; fi

  test_rubrik "Leverantörens kanaler"
  local ci
  ci="$(python3 -c 'from cloudinit import stages; i=stages.Init(); i.read_cfg(); print(i.cfg.get("ssh_pwauth"), i.cfg.get("disable_root"))' 2>/dev/null)"
  if [[ "$ci" == "False True" ]]; then godkand "cloud-init (riktig sammanslagning): ssh_pwauth=False, disable_root=True"; else underkand "cloud-init sammanslaget: '${ci}'"; fi
  pastar "andras cloud-init-filer ligger orörda kvar" cmp -s /infra/test/fixturer/cloud/99_leverantor-post-provision.cfg /etc/cloud/cloud.cfg.d/99_leverantor-post-provision.cfg

  test_rubrik "Docker"
  pastar "daemon.json är giltig JSON" jq -e . /etc/docker/daemon.json
  if jq -e '."userns-remap"=="default" and ."no-new-privileges"==true and .icc==false and ."live-restore"==true
      and ."storage-driver"=="overlay2" and .features."containerd-snapshotter"==false
      and (."exec-opts"|index("native.cgroupdriver=systemd")!=null)
      and ."log-opts"."max-size"=="10m" and ."log-opts"."max-file"=="5"
      and ."default-ulimits".nofile.Hard==32768 and (has("runtimes")|not)' /etc/docker/daemon.json >/dev/null; then
    godkand "daemon.json har alla härdningsval (och ingen runsc utan flagga)"; else underkand "daemon.json saknar val"; fi
  pastar "daemon.json fanns FÖRE paketinstallationen" grep -q 'daemon.json-fanns-fore-installation' "$ANROP"
  pastar "brandväggen var laddad FÖRE paketinstallationen" grep -q 'brandvagg-fanns-fore-installation' "$ANROP"
  pastar "subuid låst: dockremap:100000:65536" grep -qx 'dockremap:100000:65536' /etc/subuid
  pastar "subgid låst: dockremap:100000:65536" grep -qx 'dockremap:100000:65536' /etc/subgid
  pastar "Dockers nyckel installerad efter fingeravtryckskontroll" test -s /etc/apt/keyrings/docker.asc
  pastar "docker.service kräver laddad brandvägg" grep -q 'ExecStartPre=/usr/sbin/nft list table inet vibesandbox' /etc/systemd/system/docker.service.d/vibesandbox.conf
  if [[ -z "$(getent group docker | cut -d: -f4)" ]]; then godkand "docker-gruppen är tom"; else underkand "docker-gruppen har medlemmar"; fi

  test_rubrik "System och kataloger"
  pastar "sysctl-filen finns och sorteras sist" test -f /etc/sysctl.d/zz-vibesandbox.conf
  pastar "andras sysctl-fil ligger orörd kvar" cmp -s /infra/test/fixturer/sysctl/97-leverantor-natverk.conf /etc/sysctl.d/97-leverantor-natverk.conf
  if innehaller "$FAS2_UT" 'net.ipv4.conf.all.rp_filter sätts också av: .*97-leverantor-natverk.conf'; then godkand "andra filer som sätter samma sysctl-nycklar redovisas (utan antaganden om namn)"; else underkand "andra sysctl-filer redovisas inte"; fi
  if innehaller "$FAS2_UT" 'avmaskar nftables.service' && [[ ! -e "${STUBBKATALOG}/tillstand/maskad/nftables.service" ]]; then godkand "en maskad enhet vi behöver (nftables) avmaskas generiskt före enable"; else underkand "nftables.service avmaskades inte"; fi
  pastar "en maskad enhet vi INTE behöver lämnas orörd" test -e "${STUBBKATALOG}/tillstand/maskad/cockpit.socket"
  pastar "swapfil med läge 600" test "$(stat -c '%a' /swapfile)" = 600
  pastar "swapfilen i fstab med lägre prioritet" grep -qx '/swapfile none swap sw,pri=10 0 0' /etc/fstab
  pastar "LLMNR av" grep -qx 'LLMNR=no' /etc/systemd/resolved.conf.d/zz-vibesandbox.conf
  if [[ "$(stat -c '%a %u:%g' /srv/vibesandbox/data)" == "750 110001:110001" ]]; then godkand "data/ ägs av 110001 (= dockremap-bas + uid i containern)"; else underkand "data/: $(stat -c '%a %u:%g' /srv/vibesandbox/data)"; fi
  if [[ "$(stat -c '%a %u:%g' /srv/vibesandbox/backups)" == "700 0:0" && "$(stat -c '%a %u:%g' /srv/vibesandbox/compose)" == "750 0:0" ]]; then godkand "compose/ 750 och backups/ 700, root"; else underkand "fel rättigheter på compose/ eller backups/"; fi
  if [[ "$(id -u vibesandbox)" == 110001 && "$(getent passwd vibesandbox | cut -d: -f7)" == "/usr/sbin/nologin" ]]; then godkand "systemanvändaren vibesandbox: uid 110001, inget skal"; else underkand "systemanvändaren är fel"; fi
  pastar "verify.sh installerad" cmp -s /infra/verify.sh /usr/local/sbin/vibesandbox-verify
  pastar "timern aktiverad" test -e "${STUBBKATALOG}/tillstand/aktiverad/vibesandbox-verify.timer"
  if grep -qiE 'hash|authkey|[$]6[$]' /etc/vibesandbox/provision.state; then underkand "tillståndsfilen innehåller hemligheter"; else godkand "tillståndsfilen innehåller inga hemligheter"; fi

  test_rubrik "Hela körningen en gång till: idempotens"
  local fore efter
  fore="$(ogonblicksbild)"; fore_nft="$(nft -s list ruleset)"; : >"$ANROP"
  provision --bekrafta-tailscale-ssh --ingen-bekraftelse
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "andra körningen avslutas med 0"; else underkand "andra körningen gav kod ${KOD}"; visa_vid_fel; fi
  if [[ "$fore" == "$efter" ]]; then godkand "inga filer ändrades (läge, ägare, tid, innehåll)"; else underkand "andra körningen ändrade filer:"; diff <(echo "$fore") <(echo "$efter") | head -n 20; fi
  if [[ "$fore_nft" == "$(nft -s list ruleset)" ]]; then godkand "regelverket är oförändrat"; else underkand "regelverket ändrades"; fi
  local andrande
  andrande="$(grep -vE '^(systemctl (is-enabled|is-active|list-timers|list-unit-files)|sysctl -n|dpkg-query|tailscale (ip|status)|swapon --show[^ ]*|findmnt|ss |journalctl |docker info|dockerd --validate|apt-get (update|-y .*full-upgrade)|passwd -S)' "$ANROP" || true)"
  if [[ -z "$andrande" ]]; then godkand "inga ändrande kommandon utöver apt-uppdateringen"; else underkand "andra körningen körde:"; head <<<"$andrande" | sed 's/^/      | /'; fi
  if grep -q '^  → ' <<<"$(grep -v 'apt-get update' <<<"$UT")"; then underkand "utskriften visar åtgärder:"; grep '^  → ' <<<"$UT" | grep -v 'apt-get update' | head | sed 's/^/      | /'; else godkand "utskriften visar bara ✓"; fi

  test_rubrik "verify.sh: rätt läge ger 0"
  # verify.sh provar en inloggning mot den KÖRANDE sshd ⇒ en riktig sshd behövs.
  # shellcheck disable=SC2119  # inga extra flaggor här
  if starta_sshd; then godkand "en riktig sshd lyssnar på loopback"; else underkand "sshd startade inte"; fi
  verifiera
  if (( KOD == 0 )); then godkand "verify.sh avslutas med 0"; else underkand "verify.sh gav kod ${KOD}:"; grep -E '✗' <<<"$UT" | sed 's/^/      | /'; fi
  if grep -q '⚠.*gästagenten\|✓ qemu-guest-agent finns inte' <<<"$UT"; then godkand "gästagentens läge redovisas"; else underkand "gästagenten redovisas inte"; fi
  verifiera --tyst
  if (( KOD == 0 )) && ! grep -q '✓' <<<"$UT"; then godkand "--tyst skriver inga ✓-rader"; else underkand "--tyst är inte tyst"; fi

  test_rubrik "verify.sh: avdrift upptäcks (exit ≠ 0 och rätt ✗-rad)"
  avdrift() { # <beskrivning> <mönster i utdata>
    verifiera
    if (( KOD == 1 )) && grep -E '✗' <<<"$UT" | grep -qE -- "$2"; then godkand "$1"; else underkand "$1 (kod ${KOD})"; grep -E '✗' <<<"$UT" | head -n 5 | sed 's/^/      | /'; fi
  }
  aterstalld() { verifiera; if (( KOD == 0 )); then godkand "  …och 0 igen när det är återställt"; else underkand "  …fortfarande avvikelse efter återställning"; grep -E '✗' <<<"$UT" | head -n 5 | sed 's/^/      | /'; fi; }

  # Panelen skriver en direktiv ÖVERST i sshd_config (före Include) — vår dropin förlorar.
  cp /etc/ssh/sshd_config /tmp/sshd_config.bak
  { echo "PasswordAuthentication yes"; cat /tmp/sshd_config.bak; } >/etc/ssh/sshd_config
  avdrift "en kontrollpanel slår på lösenordsinloggning överst i sshd_config" "passwordauthentication är 'yes'"
  avdrift "…och verify pekar ut att Include-raden inte längre står först" "första direktivet är 'PasswordAuthentication yes'"
  # Läkning: provision.sh flyttar inte andras rader, den lägger Include FÖRST så att vår dropin vinner igen.
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD == 0 )) && innehaller "$UT" "lägger Include-raden FÖRST"; then godkand "provision.sh läker: Include läggs först i sshd_config"; else underkand "provision.sh läkte inte sshd_config"; visa_vid_fel; fi
  aterstalld
  pastar "andras rad i sshd_config ligger kvar (vi tar inte bort den, vi vinner över den)" grep -qx 'PasswordAuthentication yes' /etc/ssh/sshd_config

  echo "PermitRootLogin yes" >/etc/ssh/sshd_config.d/0-0-aaa.conf
  avdrift "en dropin som sorteras före vår tillåter root" "permitrootlogin är 'yes'"
  avdrift "…och verify pekar ut filen vid namn" "sorteras FÖRE vår.*0-0-aaa.conf"
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD != 0 )) && innehaller "$UT" "0-0-aaa.conf"; then godkand "provision.sh vägrar gå vidare och pekar ut filen"; else underkand "provision.sh godtog en dropin som vinner över vår"; fi
  echo "# ofarlig: sätter inget vi sätter" >/etc/ssh/sshd_config.d/0-0-aaa.conf
  avdrift "även en OFARLIG fil som sorteras före vår larmas (den kan ändras i morgon)" "sorteras FÖRE vår"
  mv /etc/ssh/sshd_config.d/0-0-aaa.conf /tmp/; aterstalld

  nft add rule inet vibesandbox input tcp dport 22 accept
  avdrift "någon öppnar port 22 mot internet" "SSH-porten släpps in på fler gränssnitt"
  nft -f /etc/nftables.conf; aterstalld

  nft add rule inet vibesandbox input tcp dport 8080 accept
  avdrift "någon lägger till en regel (kontrollsumman)" "AVVIKER"
  nft -f /etc/nftables.conf; aterstalld

  nft delete table inet vibesandbox
  avdrift "brandväggen är urladdad" "INTE laddad"
  nft -f /etc/nftables.conf; aterstalld

  # C-5: filen på disk är det som laddas vid nästa uppstart — inte tabellen i kärnan.
  cp -p /etc/nftables.conf /tmp/nft.bra
  printf 'detta är ingen nft-regel\n' >>/etc/nftables.conf
  avdrift "/etc/nftables.conf går inte att ladda (nft -c -f)" "nft -c -f"
  avdrift "…och den stämmer inte med den bekräftade summan" "bekräftade"
  cp -p /tmp/nft.bra /etc/nftables.conf; aterstalld
  printf '# en kommentar\n' >>/etc/nftables.conf
  avdrift "/etc/nftables.conf ändrad efter bekräftelsen (men giltig)" "bekräftade"
  cp -p /tmp/nft.bra /etc/nftables.conf; aterstalld
  mv /etc/vibesandbox/nft.sha256 /tmp/
  avdrift "kontrollsumman för regelverket saknas efter bekräftelse ⇒ ✗, inte ⚠" "kontrollsumma"
  mv /tmp/nft.sha256 /etc/vibesandbox/; aterstalld
  mv /etc/vibesandbox/brandvagg.bekraftad /tmp/
  avdrift "brandväggen saknar bekräftelsemarkör" "brandvagg.bekraftad"
  mv /tmp/brandvagg.bekraftad /etc/vibesandbox/; aterstalld
  mv /usr/local/sbin/vibesandbox-angra /tmp/
  avdrift "ångra-skriptet saknas" "vibesandbox-angra "
  mv /tmp/vibesandbox-angra /usr/local/sbin/; aterstalld
  mv "${STUBBKATALOG}/tillstand/aktiverad/vibesandbox-angra-uppstart.service" /tmp/
  avdrift "uppstartsenheten är inte aktiverad" "vibesandbox-angra-uppstart"
  mv /tmp/vibesandbox-angra-uppstart.service "${STUBBKATALOG}/tillstand/aktiverad/"; aterstalld

  touch "${STUBBKATALOG}/tillstand/maskad/apt-daily-upgrade.timer"
  avdrift "uppdateringstimern maskas igen" "apt-daily-upgrade.timer är MASKAD"
  mv "${STUBBKATALOG}/tillstand/maskad/apt-daily-upgrade.timer" /tmp/; aterstalld

  groupadd -f docker; usermod -aG docker ops
  avdrift "ops hamnar i docker-gruppen" "docker-gruppen"
  gpasswd -d ops docker >/dev/null; aterstalld

  printf 'ssh_pwauth: true\n' >/etc/cloud/cloud.cfg.d/zzzz-panel.cfg
  avdrift "en cloud-init-fil som sorteras efter vår slår på lösenord (sammanslaget resultat)" "cloud-init"
  provision --steg leverantor
  if innehaller "$UT" "någon fil vinner över vår"; then godkand "provision.sh varnar när det sammanslagna resultatet är fel"; else underkand "provision.sh märkte inte cloud-init-avvikelsen"; fi
  mv /etc/cloud/cloud.cfg.d/zzzz-panel.cfg /tmp/; aterstalld

  printf 'vm.swappiness = 1\n' >/etc/sysctl.d/zzz-panel.conf
  avdrift "en sysctl-fil som sorteras efter vår (vinner vid nästa omstart)" "sorteras EFTER vår.*zzz-panel.conf"
  mv /etc/sysctl.d/zzz-panel.conf /tmp/; aterstalld

  printf 'udp UNCONN 0 0 0.0.0.0:5355 0.0.0.0:* users:(("systemd-resolve",pid=1,fd=1))\ntcp LISTEN 0 0 0.0.0.0:8080 0.0.0.0:* users:(("okand",pid=9,fd=3))\n' >"${STUBBKATALOG}/ss-lyssnare"
  avdrift "LLMNR lyssnar igen" "LLMNR lyssnar"
  avdrift "en okänd tjänst lyssnar mot internet" "oväntad lyssnare: tcp 0.0.0.0:8080"
  printf 'tcp LISTEN 0 0 0.0.0.0:443 0.0.0.0:* users:(("docker-proxy",pid=5,fd=4))\ntcp LISTEN 0 0 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=2,fd=3))\nudp UNCONN 0 0 127.0.0.53%%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=1,fd=1))\ntcp LISTEN 0 0 100.64.0.5:40123 0.0.0.0:* users:(("tailscaled",pid=3,fd=9))\n' >"${STUBBKATALOG}/ss-lyssnare"
  verifiera; if (( KOD == 0 )); then godkand "443, sshd, resolved på loopback och tailscaled godtas"; else underkand "förväntade lyssnare underkändes"; grep '✗' <<<"$UT" | sed 's/^/      | /'; fi

  chmod 777 /srv/vibesandbox/data
  avdrift "data/ får fel rättigheter" "/srv/vibesandbox/data"
  chmod 750 /srv/vibesandbox/data; aterstalld

  passwd -u root >/dev/null 2>&1 || usermod -p "$(openssl passwd -6 x)" root
  avdrift "root får ett lösenord igen (panelens lösenordsåterställning)" "lösenordsstatus för root"
}

scenario_flaggor() {
  forbered_vard
  lat_tailnet_session_finnas
  ln -sf /infra/test/stubbar/stubb "${STUBBAR}/qemu-ga"
  kor_fas1
  test_rubrik "Flaggor: HARDEN_GUEST_AGENT, DOCKER_XFS_LOOP, extra portar"

  HARDEN_GUEST_AGENT=1 provision --steg leverantor
  if (( KOD == 0 )) && grep -q '^block-rpcs=guest-exec,guest-exec-status,guest-file-open' /etc/qemu/qemu-ga.conf; then godkand "HARDEN_GUEST_AGENT=1 spärrar guest-exec m.fl."; else underkand "qemu-ga.conf skrevs inte"; visa_vid_fel; fi
  pastar "gästagenten startades om" grep -q 'systemctl restart qemu-guest-agent' "$ANROP"
  : >"$ANROP"; HARDEN_GUEST_AGENT=1 provision --steg leverantor
  pastar_inte "…men inte en gång till när inget ändrats" grep -q 'systemctl restart qemu-guest-agent' "$ANROP"
  HARDEN_GUEST_AGENT=0 provision --steg leverantor
  if [[ ! -e /etc/qemu/qemu-ga.conf ]] && innehaller "$UT" "OBEGRÄNSAD"; then godkand "HARDEN_GUEST_AGENT=0 tar bort härdningen och varnar tydligt"; else underkand "härdningen ligger kvar eller ingen varning"; fi

  DOCKER_XFS_LOOP=1 provision --steg dockerdisk
  if (( KOD == 0 )); then godkand "DOCKER_XFS_LOOP=1 avslutas med 0"; else underkand "dockerdisk gav kod ${KOD}"; visa_vid_fel; fi
  pastar "avbildsfilen är ett riktigt XFS-filsystem (mkfs.xfs kördes på riktigt)" bash -c "xfs_db -r -c 'sb 0' -c 'p magicnum' /var/lib/vibesandbox-docker.xfs | grep -q 0x58465342"
  pastar "fstab: loop,pquota,nofail" grep -q '/var/lib/docker xfs loop,pquota,nofail' /etc/fstab
  local fore; fore="$(cat /etc/fstab)"
  DOCKER_XFS_LOOP=1 provision --steg dockerdisk
  if [[ "$fore" == "$(cat /etc/fstab)" ]] && innehaller "$UT" "redan en XFS-montering"; then godkand "andra körningen rör inte fstab"; else underkand "fstab ändrades igen"; fi

  PUBLIC_TCP_PORTS="80 443" provision --steg brandvagg --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD == 0 )) && nft list table inet vibesandbox | grep -q 'tcp dport { 80, 443 } accept'; then godkand "PUBLIC_TCP_PORTS=\"80 443\" ger giltiga regler"; else underkand "extra port gav fel regler"; visa_vid_fel; fi
  PUBLIC_TCP_PORTS="" PUBLIC_UDP_PORTS="" OPEN_TAILSCALE_UDP=1 provision --steg brandvagg --bekrafta-tailscale-ssh --ingen-bekraftelse
  if (( KOD == 0 )) && nft list table inet vibesandbox | grep -q 'udp dport 41641 accept'; then godkand "tomma portlistor + OPEN_TAILSCALE_UDP=1 ger giltiga regler"; else underkand "tomma portlistor gav fel regler"; visa_vid_fel; fi

  test_rubrik "gVisor registreras bara med flaggan"
  INSTALL_GVISOR=1 GVISOR_RELEASE=20260101 provision --steg docker --dry-run
  INSTALL_GVISOR=1 provision --steg brandvagg --steg docker --bekrafta-tailscale-ssh --ingen-bekraftelse
  if jq -e '.runtimes.runsc.path=="/usr/local/bin/runsc"' /etc/docker/daemon.json >/dev/null; then godkand "INSTALL_GVISOR=1 lägger runsc i daemon.json (giltig JSON)"; else underkand "runsc saknas i daemon.json"; visa_vid_fel; fi
}

# Fler scenarier ligger i egna filer under scenarier/ (en funktion scenario_<namn> per fil).
for f in /infra/test/scenarier/*.sh; do
  # shellcheck source=/dev/null
  [[ -e "$f" ]] && source "$f"
done

if [[ "$SCENARIO" =~ ^[a-z0-9]+$ ]] && declare -F "scenario_${SCENARIO}" >/dev/null; then
  "scenario_${SCENARIO}"
else
  echo "okänt scenario: ${SCENARIO}" >&2; exit 2
fi

printf '\n   %s: %d godkända, %d underkända\n' "$SCENARIO" "$GODKANDA" "$UNDERKANDA"
(( UNDERKANDA == 0 ))
