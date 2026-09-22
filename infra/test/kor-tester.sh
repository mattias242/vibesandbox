#!/usr/bin/env bash
# Kör infra-testerna i lokala engångscontainrar. Rör ingen server och ingenting på din dator
# utöver en Docker-avbild (vibesandbox-infra-test:*).
#
#   infra/test/kor-tester.sh                 alla scenarier på Debian 13
#   infra/test/kor-tester.sh fas2 angra      bara de scenarierna
#   BAS=debian:12 infra/test/kor-tester.sh   annan bas (debian:12, ubuntu:24.04)
#
# Varje scenario får en egen container (--rm) ⇒ en orörd "värd" varje gång.
# NET_ADMIN behövs för att ladda nftables-regler — i containerns EGEN nätverksnamnrymd.

set -euo pipefail

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BAS="${BAS:-debian:13}"
AVBILD="vibesandbox-infra-test:${BAS//[:.]/}"
ALLA=(statisk vagran dryrun fas1 angra fas2 flaggor avbrott fas2ja inloggning filer verify besked angrafel backup backupinstall)

command -v docker >/dev/null || { echo "docker saknas" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker-demonen svarar inte — starta Docker först" >&2; exit 2; }

echo "==> Bygger testavbild ${AVBILD} (bas: ${BAS})"
docker build -q --build-arg "BAS=${BAS}" -t "$AVBILD" "${INFRA}/test" >/dev/null

if (( $# > 0 )); then SCENARIER=("$@"); else SCENARIER=("${ALLA[@]}"); fi

MISSLYCKADE=()
for s in "${SCENARIER[@]}"; do
  echo
  echo "════ Scenario: ${s} (${BAS}) ════"
  if docker run --rm --cap-add NET_ADMIN -e LC_ALL=C.UTF-8 -v "${INFRA}:/infra:ro" \
    "$AVBILD" bash /infra/test/i-container.sh "$s"; then
    :
  else
    MISSLYCKADE+=("$s")
  fi
done

echo
if (( ${#MISSLYCKADE[@]} > 0 )); then
  echo "✗ Underkända scenarier: ${MISSLYCKADE[*]}"
  exit 1
fi
echo "✓ Alla scenarier godkända (${SCENARIER[*]}) på ${BAS}"
