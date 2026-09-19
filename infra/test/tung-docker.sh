#!/usr/bin/env bash
# Tunga tester i lokala engångscontainrar. Rör ingen server. Tar några minuter och kräver nät.
#
#   1. Riktig Docker + riktig brandvägg i en PRIVILEGIERAD container (i-container-tung.sh).
#      Hämtar Docker-paket (~100 MB) och busybox. Containern och dess Docker-data (anonym volym)
#      försvinner med --rm.
#   2. Ångra-mekanismen med riktig systemd som PID 1 (i-container-systemd.sh): en RIKTIG
#      transient timer som får löpa ut (~4 min) och en RIKTIG omstart av containern med två
#      obekräftade ändringar på disk.
#
#   infra/test/tung-docker.sh                 båda, Debian 13
#   infra/test/tung-docker.sh systemd         bara ångra-testet med systemd
#   BAS=debian:12 infra/test/tung-docker.sh

set -euo pipefail

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAS="${BAS:-debian:13}"
AVBILD="vibesandbox-infra-test:${BAS//[:.]/}"
DELAR=("${@:-docker systemd}")
read -r -a DELAR <<<"${DELAR[*]}"

docker info >/dev/null 2>&1 || { echo "docker-demonen svarar inte — starta Docker först" >&2; exit 2; }
echo "==> Bygger testavbild ${AVBILD} (bas: ${BAS})"
docker build -q --build-arg "BAS=${BAS}" -t "$AVBILD" "${INFRA}/test" >/dev/null

MISSLYCKADE=()

kor_docker() {
  echo; echo "════ Tungt: riktig Docker + riktig brandvägg (${BAS}) ════"
  # --privileged: nästlad dockerd behöver det. -v /var/lib/docker: overlay2 kan inte ligga på overlayfs.
  docker run --rm --privileged -e LC_ALL=C.UTF-8 -v /var/lib/docker -v "${INFRA}:/infra:ro" \
    "$AVBILD" bash /infra/test/i-container-tung.sh || MISSLYCKADE+=(docker)
}

kor_systemd() {
  echo; echo "════ Tungt: ångra-mekanismen med systemd som PID 1 (${BAS}) ════"
  local avbild="${AVBILD}-systemd" c kod=0
  printf 'FROM %s\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus && apt-get clean\nSTOPSIGNAL SIGRTMIN+3\nCMD ["/sbin/init"]\n' "$AVBILD" \
    | docker build -q -t "$avbild" - >/dev/null
  c="$(docker run -d --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
    -e LC_ALL=C.UTF-8 -v "${INFRA}:/infra:ro" "$avbild")"
  # Städas vad som än händer (containern är inte --rm: den ska överleva en omstart).
  trap 'docker rm -f "$c" >/dev/null 2>&1 || true' RETURN
  docker exec -e LC_ALL=C.UTF-8 "$c" bash /infra/test/i-container-systemd.sh fore || kod=1
  echo; echo "── Startar om \"värden\" (docker restart) med två obekräftade ändringar på disk"
  docker restart -t 20 "$c" >/dev/null
  docker exec -e LC_ALL=C.UTF-8 "$c" bash /infra/test/i-container-systemd.sh efter || kod=1
  (( kod == 0 )) || MISSLYCKADE+=(systemd)
}

for d in "${DELAR[@]}"; do
  case "$d" in
    docker) kor_docker ;;
    systemd) kor_systemd ;;
    *) echo "okänd del: ${d} (docker | systemd)" >&2; exit 2 ;;
  esac
done

echo
if (( ${#MISSLYCKADE[@]} > 0 )); then echo "✗ Underkända tunga tester: ${MISSLYCKADE[*]}"; exit 1; fi
echo "✓ Tunga tester godkända (${DELAR[*]}) på ${BAS}"
