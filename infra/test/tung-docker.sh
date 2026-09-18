#!/usr/bin/env bash
# Tungt test: riktig Docker + riktig brandvägg i en PRIVILEGIERAD lokal engångscontainer.
# Hämtar Docker-paket (~100 MB) och busybox ⇒ kräver nät och tar några minuter.
# Rör ingen server. Containern och dess Docker-data (anonym volym) försvinner med --rm.
#
#   infra/test/tung-docker.sh            Debian 13
#   BAS=debian:12 infra/test/tung-docker.sh

set -euo pipefail

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAS="${BAS:-debian:13}"
AVBILD="vibesandbox-infra-test:${BAS//[:.]/}"

docker info >/dev/null 2>&1 || { echo "docker-demonen svarar inte — starta Docker först" >&2; exit 2; }
echo "==> Bygger testavbild ${AVBILD} (bas: ${BAS})"
docker build -q --build-arg "BAS=${BAS}" -t "$AVBILD" "${INFRA}/test" >/dev/null

# --privileged: nästlad dockerd behöver det. -v /var/lib/docker: overlay2 kan inte ligga på overlayfs.
docker run --rm --privileged -e LC_ALL=C.UTF-8 -v /var/lib/docker -v "${INFRA}:/infra:ro" \
  "$AVBILD" bash /infra/test/i-container-tung.sh
