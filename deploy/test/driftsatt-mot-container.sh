#!/usr/bin/env bash
# Kör deploy/driftsatt.sh mot en engångscontainer med riktig sshd och riktig sudo MED lösenord
# (som på en provisionerad värd: ops är sudoer, inte i docker-gruppen, och Debians sudo knyter
# lösenordscachen till terminalen). docker är en stubbe som loggar sina anrop.
#
#   deploy/test/driftsatt-mot-container.sh
#
# Kräver docker och expect. Rör ingen server och läser inte den riktiga .env.
set -euo pipefail
cd "$(dirname "$0")/../.."

T="$(mktemp -d)"
NAMN="vibesandbox-driftsatt-test-$$"
AVBILD="vibesandbox-driftsatt-test"
LOSEN="bara-ett-testlosenord"
stada() { docker rm -f "$NAMN" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap stada EXIT

GODKANDA=0; UNDERKANDA=0
godkand() { printf '  ✓ %s\n' "$*"; GODKANDA=$((GODKANDA + 1)); }
underkand() { printf '  ✗ %s\n' "$*"; UNDERKANDA=$((UNDERKANDA + 1)); }
i_vard() { docker exec "$NAMN" sh -c "$1"; }

echo "── Förbereder testvärden"
docker build -q -t "$AVBILD" -f - deploy/test >/dev/null <<'EOF'
FROM debian:13
RUN apt-get update -q && apt-get install -y -q --no-install-recommends openssh-server sudo \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash -G sudo ops \
 && mkdir -p /run/sshd /srv/vibesandbox/compose && chmod 750 /srv/vibesandbox/compose
COPY docker-stubbe /usr/local/bin/docker
CMD ["/usr/sbin/sshd", "-D", "-e"]
EOF
docker run -d --name "$NAMN" -p 127.0.0.1::22 "$AVBILD" >/dev/null
PORT="$(docker port "$NAMN" 22 | head -n 1 | sed 's/.*://')"

ssh-keygen -q -t ed25519 -N '' -C driftsatt-test -f "$T/nyckel"
docker exec -i "$NAMN" sh -c 'mkdir -p /home/ops/.ssh && cat >/home/ops/.ssh/authorized_keys \
  && chown -R ops:ops /home/ops/.ssh && chmod 700 /home/ops/.ssh && chmod 600 /home/ops/.ssh/authorized_keys' <"$T/nyckel.pub"
printf 'ops:%s\n' "$LOSEN" | docker exec -i "$NAMN" chpasswd

cat >"$T/ssh_config" <<EOF
Host testvard
  HostName 127.0.0.1
  Port ${PORT}
  User ops
  IdentityFile ${T}/nyckel
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF
mkdir -p "$T/bin"
cat >"$T/bin/ssh" <<EOF
#!/bin/sh
SSH_AUTH_SOCK= exec /usr/bin/ssh -F "${T}/ssh_config" "\$@"
EOF
chmod +x "$T/bin/ssh"
for _ in 1 2 3 4 5 6 7 8 9 10; do "$T/bin/ssh" -o BatchMode=yes testvard true 2>/dev/null && break; sleep 0.5; done

# Påhittade värden — inga riktiga hemligheter i testet.
cat >"$T/env" <<'EOF'
CLOUDFLARE_API_TOKEN=test-cloudflare-HEMLIG
BERGET_API_KEY=test-berget-HEMLIG
MAILGUN_API_KEY=test-mailgun-HEMLIG
ACME_MAIL=drift@example.org
IDENTITY_SECRET=test-identitet-HEMLIG-minst-trettiotva-tecken
EOF

echo "── driftsatt.sh mot testvärden (sudo frågar efter lösenord)"
set +e
# shellcheck disable=SC2016  # $env(LOSEN) och $fragor är Tcl-variabler i expect, inte skalets
UT="$(DRIFTSATT_ENV="$T/env" DRIFTSATT_ROKTEST=0 PATH="$T/bin:$PATH" LOSEN="$LOSEN" expect -c '
  set timeout 180
  log_user 1
  set fragor 0
  spawn deploy/driftsatt.sh testvard --forsta-byggare anna@example.org
  expect {
    -re {\[sudo\] password for ops: ?} { incr fragor; send -- "$env(LOSEN)\r"; exp_continue }
    eof
  }
  lassign [wait] pid id oserr kod
  puts "LOSENORDSFRAGOR=$fragor"
  exit $kod
' 2>&1)"
KOD=$?
set -e

visa() { printf '%s\n' "$UT" | tail -n 25 | sed 's/^/      | /'; }
if (( KOD == 0 )); then godkand "driftsatt.sh avslutas med 0"; else underkand "driftsatt.sh gav kod ${KOD}"; visa; fi
fragor="$(sed -n 's/^LOSENORDSFRAGOR=\([0-9]*\).*/\1/p' <<<"$UT" | tail -n 1)"
if [[ "$fragor" == "1" ]]; then godkand "sudo frågar efter lösenordet exakt en gång"; else underkand "sudo frågade ${fragor:-?} gånger"; fi
if grep -q 'HEMLIG' <<<"$UT"; then underkand "en hemlighet syns i utdata"; else godkand "inga hemligheter i utdata"; fi

K=/srv/vibesandbox/compose
if i_vard "test -f ${K}/app/deploy/compose.yml && [ \"\$(stat -c %u ${K}/app/deploy/compose.yml)\" = 0 ]"; then
  godkand "den committade versionen ligger i ${K}/app, ägd av root"; else underkand "appen saknas eller ägs inte av root"; fi
if [[ "$(i_vard "cat ${K}/app/VERSION" 2>/dev/null)" == "$(git rev-parse --short HEAD)" ]]; then
  godkand "VERSION är HEAD"; else underkand "VERSION stämmer inte med HEAD"; fi
if i_vard "test ! -e ${K}/app/.env && test ! -e ${K}/app/referens && test ! -e ${K}/app/vault"; then
  godkand "inget lokalt (.env, referens/, vault/) följde med"; else underkand "lokala filer följde med"; fi
if [[ "$(i_vard "stat -c '%a %U:%G' ${K}/.env" 2>/dev/null)" == "600 root:root" ]]; then
  godkand "serverns .env har läge 600 och ägs av root"; else underkand "serverns .env har fel läge/ägare"; fi
if i_vard "grep -qx 'BERGET_API_KEY=test-berget-HEMLIG' ${K}/.env && ! grep -q '^LEVERANTOR' ${K}/.env"; then
  godkand "serverns .env har tillåtelselistans nycklar"; else underkand "serverns .env har fel innehåll"; fi
if i_vard "test ! -e /home/ops/.driftsatt"; then
  godkand "inget ligger kvar i ops hemkatalog"; else underkand "mellanlagringen ligger kvar hos ops"; fi

LOGG="$(i_vard 'cat /var/log/docker-stubbe.log' 2>/dev/null || true)"
if grep -q "compose .*--env-file ${K}/.env up -d --build --remove-orphans --wait" <<<"$LOGG"; then
  godkand "docker compose up körs som root med serverns .env"; else underkand "compose up kördes inte"; fi
if grep -q 'exec -T -e DATA_DIR=/data platform node packages/identity/src/cli.ts lagg-till anna@example.org builder' <<<"$LOGG"; then
  godkand "första byggaren läggs in"; else underkand "första byggaren lades inte in"; fi
if grep -q 'HEMLIG' <<<"$LOGG"; then underkand "en hemlighet syns i dockers argument"; else godkand "inga hemligheter i dockers argument"; fi

echo
echo "   driftsatt: ${GODKANDA} godkända, ${UNDERKANDA} underkända"
(( UNDERKANDA == 0 ))
