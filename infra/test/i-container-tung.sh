#!/usr/bin/env bash
# Tungt test, körs INUTI en privilegierad engångscontainer (startas av tung-docker.sh).
#
# Här är apt-get, Docker och nftables RIKTIGA: Docker installeras från Dockers förråd av
# provision.sh, startas med vår daemon.json och får samsas med vår brandvägg. En extra
# nätverksnamnrymd spelar "internet" och en spelar "tailnetet", så att paketen verkligen
# går genom reglerna. Fortfarande stubbat: systemd, tailscale-klienten, sysctl, swap.
#
# Det enda som avviker från skarp drift: cgroup-drivrutinen. 'systemd' kräver ett systemd
# att prata med, så dockerd startas här med en KOPIA av daemon.json där den är 'cgroupfs'.

# Inte pipefail — se i-container.sh.
set -u

# shellcheck source=/dev/null
source <(sed -n '/^INFRA=/,/^# ── Scenarier/p' /infra/test/i-container.sh)

vanta_pa() { local n=0; until "$@" >/dev/null 2>&1; do n=$(( n + 1 )); (( n > 60 )) && return 1; sleep 1; done; }

test_rubrik "Förberedelser: riktig apt, riktig Docker"
forbered_vard
# Byt tillbaka de stubbar som ska vara riktiga i det här testet.
for k in apt-get dpkg-query docker dockerd fallocate; do unlink "${STUBBAR}/${k}"; done
lat_tailnet_session_finnas
apt-get update -q >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends netcat-openbsd iputils-ping >/dev/null
# Containerns policy-rc.d hindrar paketens postinst från att starta tjänster; bra, vi startar dockerd själva.

# cgroup v2 i en nästlad container: flytta processerna till en undergrupp (samma som docker:dind gör).
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 </sys/fs/cgroup/cgroup.procs >/sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  sed -e 's/ / +/g' -e 's/^/+/' </sys/fs/cgroup/cgroup.controllers >/sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
fi

# Som på den riktiga värden: leverantören har slagit på routning INNAN Docker kommer dit.
# (Docker sätter bara FORWARD-policyn till DROP när den själv slår på ip_forward.)
echo 1 >/proc/sys/net/ipv4/ip_forward

kor_fas1
provision --bekrafta-tailscale-ssh --ingen-bekraftelse
if (( KOD == 0 )); then godkand "provision.sh fas 1 + fas 2 med riktig apt (Docker installerat från Dockers förråd)"; else underkand "provision gav kod ${KOD}"; visa_vid_fel; fi
pastar "docker-ce är installerat på riktigt" dpkg -s docker-ce
printf '      | %s\n' "$(dockerd --version)"

test_rubrik "daemon.json mot riktig dockerd"
pastar "dockerd --validate godkänner daemon.json" dockerd --validate --config-file /etc/docker/daemon.json
sed 's/native.cgroupdriver=systemd/native.cgroupdriver=cgroupfs/' /etc/docker/daemon.json >/tmp/daemon-test.json
dockerd --config-file /tmp/daemon-test.json >/var/log/dockerd.log 2>&1 &
if vanta_pa docker info; then godkand "dockerd startar med userns-remap + overlay2 + våra val"; else underkand "dockerd startar inte:"; tail -n 20 /var/log/dockerd.log | sed 's/^/      | /'; fi

test_rubrik "verify.sh mot riktig 'docker info'"
# verify.sh provar en inloggning mot den KÖRANDE sshd ⇒ den måste vara igång redan här.
if starta_sshd -o ListenAddress=0.0.0.0 -o 'ListenAddress=[::]'; then godkand "riktig sshd lyssnar (IPv4 och IPv6)"; else underkand "sshd startade inte"; fi
verifiera --hoppa-over system
ovantade="$(grep '^  ✗' <<<"$UT" | grep -vE "cgroup-drivrutin|SAKNAS i docker info: apparmor|AppArmor" || true)"
if [[ -z "$ovantade" ]]; then
  godkand "inga avvikelser utöver testmiljöns (cgroupfs i stället för systemd; testkärnan saknar AppArmor)"
else
  underkand "oväntade avvikelser:"; printf '%s\n' "$ovantade" | sed 's/^/      | /'
fi
grep -E '(✓|✗).*(userns|no-new-privileges|seccomp|lagringsdrivrutin|live-restore|rotkatalog|icc)' <<<"$UT" | sed 's/^/      | /'

test_rubrik "Nätverk: en namnrymd spelar internet, en spelar tailnetet"
ip netns add internet
ip link add vsb-ut type veth peer name eth0 netns internet
ip addr add 198.51.100.1/24 dev vsb-ut && ip link set vsb-ut up
ip -n internet addr add 198.51.100.2/24 dev eth0 && ip -n internet link set eth0 up && ip -n internet link set lo up
ip netns add tailnet
ip link add tailscale0 type veth peer name eth0 netns tailnet
ip addr add 100.64.0.1/24 dev tailscale0 && ip link set tailscale0 up
ip -n tailnet addr add 100.64.0.2/24 dev eth0 && ip -n tailnet link set eth0 up && ip -n tailnet link set lo up
ip -n tailnet route add default via 100.64.0.1
ip -n internet route add default via 198.51.100.1
# IPv6: dokumentationsnätet som "internet", Tailscales ULA-prefix som "tailnetet".
ip addr add 2001:db8:1::1/64 dev vsb-ut nodad && ip -n internet addr add 2001:db8:1::2/64 dev eth0 nodad
ip addr add fd7a:115c:a1e0::1/64 dev tailscale0 nodad && ip -n tailnet addr add fd7a:115c:a1e0::2/64 dev eth0 nodad
ip -n internet -6 route add default via 2001:db8:1::1 && ip -n tailnet -6 route add default via fd7a:115c:a1e0::1
# Moln-metadata: 169.254.169.254 "hos leverantören", nåbar från värden som på en riktig VPS.
ip -n internet addr add 169.254.169.254/32 dev eth0
ip route add 169.254.169.254/32 via 198.51.100.2
ip netns exec internet nc -lk 169.254.169.254 80 >/dev/null 2>&1 &
# Lyssnare på VÄRDEN utöver sshd: en v6-port som inte är öppnad, och UDP 443 / UDP 8443.
nc -6 -lk 2001:db8:1::1 8022 >/dev/null 2>&1 &
# Lyssnare ute på "internet" och "tailnetet" som containrar kan försöka nå.
ip netns exec internet nc -lk 198.51.100.2 8443 >/dev/null 2>&1 &
ip netns exec internet nc -lk 198.51.100.2 587 >/dev/null 2>&1 &
ip netns exec tailnet nc -lk 100.64.0.2 8443 >/dev/null 2>&1 &

docker pull -q busybox >/dev/null 2>&1 || underkand "kunde inte hämta busybox (inget nät?)"
docker run -d --name webb443 -p 443:80 busybox httpd -f -p 80 >/dev/null 2>&1
docker run -d --name webb8080 -p 8080:80 busybox httpd -f -p 80 >/dev/null 2>&1
BRYGGA_GW="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
sleep 1

fran_internet() { ip netns exec internet nc -z -w 3 "$@"; }
fran_tailnet()  { ip netns exec tailnet nc -z -w 3 "$@"; }
i_container()   { docker run --rm busybox "$@"; }

test_rubrik "Inkommande: bara 443 från internet, SSH bara från tailnetet"
pastar      "internet → :443 (publicerad OCH tillåten port) når containern" fran_internet 198.51.100.1 443
pastar_inte "internet → :8080 (publicerad men INTE tillåten port) stoppas"   fran_internet 198.51.100.1 8080
pastar_inte "internet → :22 stoppas"                                          fran_internet 198.51.100.1 22
pastar      "tailnet → :22 släpps in (gränssnittet heter tailscale0)"         fran_tailnet 100.64.0.1 22
pastar_inte "tailnet → :8080 stoppas (tailnetet är ingen bakdörr till fler portar)" fran_tailnet 100.64.0.1 8080
pastar_inte "internet → tailnetet routas inte genom värden (FORWARD drop)"    fran_internet 100.64.0.2 8443

test_rubrik "IPv6 (tidigare OTESTAT): samma regler som för IPv4"
fran_internet6() { ip netns exec internet nc -6 -z -w 3 "$@"; }
fran_tailnet6()  { ip netns exec tailnet nc -6 -z -w 3 "$@"; }
pastar_inte "internet v6 → :22 stoppas"                                  fran_internet6 2001:db8:1::1 22
pastar      "tailnet v6 (fd7a:115c:a1e0::/48 på tailscale0) → :22 släpps in" fran_tailnet6 fd7a:115c:a1e0::1 22
pastar_inte "internet v6 → en port på värden som inte är öppnad (8022) stoppas" fran_internet6 2001:db8:1::1 8022
echo 1 >/proc/sys/net/ipv6/conf/all/forwarding   # som om leverantören slagit på v6-routning
ip netns exec tailnet nc -6 -lk fd7a:115c:a1e0::2 8443 >/dev/null 2>&1 &
sleep 0.5
pastar_inte "internet v6 → tailnetet routas inte genom värden (forward drop, även med v6-routning på)" fran_internet6 fd7a:115c:a1e0::2 8443

test_rubrik "UDP 443 (tidigare OTESTAT): öppen port släpps in, annan UDP-port stoppas"
udp_nar_fram() { # <port> — skickar ett datagram från "internet" och ser om det kom fram till värden
  local port="$1" fil="/tmp/udp-${1}"
  : >"$fil"
  timeout 4 nc -u -l 198.51.100.1 "$port" >"$fil" 2>/dev/null &
  sleep 0.5
  printf 'prov-%s\n' "$port" | ip netns exec internet nc -u -w 1 198.51.100.1 "$port" >/dev/null 2>&1
  sleep 1
  grep -q "prov-${port}" "$fil"
}
pastar      "internet → udp/443 når värden"        udp_nar_fram 443
pastar_inte "internet → udp/8443 stoppas"          udp_nar_fram 8443

test_rubrik "Utgående från containrar"
pastar      "container → internet :8443 fungerar"                   i_container nc -z -w 3 198.51.100.2 8443
pastar_inte "container → internet :587 (SMTP) stoppas"              i_container nc -z -w 3 198.51.100.2 587
pastar_inte "container → tailnetet (100.64.0.0/10) stoppas"         i_container nc -z -w 3 100.64.0.2 8443
pastar_inte "container → värdens sshd via bryggans gateway stoppas" i_container nc -z -w 3 "$BRYGGA_GW" 22
pastar_inte "container → värdens sshd via publik adress stoppas"    i_container nc -z -w 3 198.51.100.1 22
pastar_inte "container → moln-metadata 169.254.169.254 stoppas (tidigare OTESTAT)" i_container nc -z -w 3 169.254.169.254 80
# Hairpin: en container som ansluter till värdens PUBLIKA adress på en publicerad port. Med Dockers
# userland-proxy tas anslutningen emot av docker-proxy på värden (input-kedjan), och där släpper
# vi inte in något från docker0/br-* ⇒ stoppas. Konsekvens: en app når inte plattformen via den
# publika adressen inifrån en container — den får använda det interna nätet (se README).
pastar_inte "container → värdens publika adress :443 (hairpin) stoppas (tidigare OTESTAT)" i_container nc -z -w 3 198.51.100.1 443
docker network create --internal inlast >/dev/null 2>&1
pastar_inte "container på --internal-nät når inte internet"         docker run --rm --network inlast busybox nc -z -w 3 198.51.100.2 8443

test_rubrik "Kontroll: utan vår tabell ÄR samma trafik möjlig (spärrarna ovan beror alltså på den)"
nft delete table inet vibesandbox
pastar "utan tabellen: internet → :8080 når containern"   fran_internet 198.51.100.1 8080
pastar "utan tabellen: internet → :22 når sshd"           fran_internet 198.51.100.1 22
pastar "utan tabellen: container → tailnetet fungerar"    i_container nc -z -w 3 100.64.0.2 8443
pastar "utan tabellen: container → SMTP fungerar"         i_container nc -z -w 3 198.51.100.2 587
pastar "utan tabellen: container → värdens sshd fungerar" i_container nc -z -w 3 "$BRYGGA_GW" 22
pastar "utan tabellen: internet → tailnetet routas (leverantörens ip_forward=1 + FORWARD ACCEPT)" fran_internet 100.64.0.2 8443
pastar "utan tabellen: container → 169.254.169.254 fungerar"   i_container nc -z -w 3 169.254.169.254 80
pastar "utan tabellen: container → publik adress :443 (hairpin) fungerar" i_container nc -z -w 3 198.51.100.1 443
pastar "utan tabellen: internet v6 → :22 når sshd"            fran_internet6 2001:db8:1::1 22
pastar "utan tabellen: internet v6 → :8022 når värden"        fran_internet6 2001:db8:1::1 8022
pastar "utan tabellen: internet v6 → tailnetet routas"        fran_internet6 fd7a:115c:a1e0::2 8443
pastar "utan tabellen: internet → udp/8443 når värden"        udp_nar_fram 8443

test_rubrik "Omladdning av vår tabell stör inte Docker"
nft -f /etc/nftables.conf
pastar      "efter omladdning: internet → :443 fungerar fortfarande" fran_internet 198.51.100.1 443
pastar_inte "efter omladdning: internet → :8080 stoppas igen"        fran_internet 198.51.100.1 8080
pastar      "Dockers egna regler finns kvar (iptables-nft)"          bash -c "nft list ruleset | grep -q 'chain DOCKER'"
printf '      | iptables: %s\n' "$(iptables --version)"

test_rubrik "userns-remap på riktigt"
ROT_I_CONTAINER="$(docker inspect --format '{{.State.Pid}}' webb443)"
AGARE="$(stat -c '%u' "/proc/${ROT_I_CONTAINER}")"
if [[ "$AGARE" == "100000" ]]; then godkand "root i containern är uid 100000 på värden (låst subuid-bas)"; else underkand "root i containern är uid ${AGARE} på värden"; fi
install -d -m 0750 -o 110001 -g 110001 /srv/vibesandbox/data
if docker run --rm --user 10001:10001 -v /srv/vibesandbox/data:/data busybox sh -c 'echo hej >/data/prov && cat /data/prov' >/dev/null 2>&1 \
  && [[ "$(stat -c '%u:%g' /srv/vibesandbox/data/prov)" == "110001:110001" ]]; then
  godkand "uid 10001 i containern kan skriva i data/ och filen ägs av 110001 på värden"
else
  underkand "data/ går inte att skriva för uid 10001 i containern"
fi
# Root i containern har CAP_DAC_OVERRIDE över id:n som är mappade in i namnrymden (dit hör
# 110001) men INTE över värdens riktiga root (uid 0 är omappad). Det är det userns-remap ger.
pastar_inte "root i containern kan INTE skriva i en katalog som ägs av värdens root (backups/)" \
  docker run --rm -v /srv/vibesandbox/backups:/b busybox sh -c 'echo x >/b/rot'
pastar_inte "root i containern kan inte ens LÄSA compose/ (hemligheter, 750 root)" \
  docker run --rm -v /srv/vibesandbox/compose:/c busybox ls /c
pastar_inte "--privileged vägras under userns-remap" docker run --rm --privileged busybox true

docker rm -f webb443 webb8080 >/dev/null 2>&1
printf '\n   tungt test: %d godkända, %d underkända\n' "$GODKANDA" "$UNDERKANDA"
(( UNDERKANDA == 0 ))
