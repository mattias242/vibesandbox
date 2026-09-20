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
 && mkdir -p /run/sshd /srv/vibesandbox/compose /etc/vibesandbox && chmod 750 /srv/vibesandbox/compose
COPY docker-stubbe /usr/local/bin/docker
CMD ["/usr/sbin/sshd", "-D", "-e"]
EOF
# SYS_PTRACE: root på en värd har den, root i en container inte. Rotsteget läser /proc/<pid>/environ
# hos SSH-sessionen för att se klientens adress — utan förmågan vore testet strängare än verkligheten.
docker run -d --name "$NAMN" --cap-add SYS_PTRACE -p 127.0.0.1::22 "$AVBILD" >/dev/null
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

# Containerns docker-nät räknas som "tailnet" i testet — värdens skript läser den rootägda filen.
tailnet_i_testet() { docker exec "$NAMN" sh -c "printf '%s\n' '^172\\.' >/etc/vibesandbox/driftsatt-natverk && chmod 644 /etc/vibesandbox/driftsatt-natverk"; }
inte_tailnet() { docker exec "$NAMN" sh -c "printf '%s\n' '^100\\.64\\.' >/etc/vibesandbox/driftsatt-natverk"; }
aterstall_vard() { i_vard "rm -rf ${K}/app ${K}/app.gammal ${K}/.env /home/ops/.driftsatt; : >/var/log/docker-stubbe.log" 2>/dev/null || true; }

visa() { printf '%s\n' "$UT" | tail -n 25 | sed 's/^/      | /'; }

kor_driftsatt() {
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
}

K=/srv/vibesandbox/compose
kontrollera_utlagt() {
  if (( KOD == 0 )); then godkand "driftsatt.sh avslutas med 0"; else underkand "driftsatt.sh gav kod ${KOD}"; visa; fi
  fragor="$(sed -n 's/^LOSENORDSFRAGOR=\([0-9]*\).*/\1/p' <<<"$UT" | tail -n 1)"
  if [[ "$fragor" == "$1" ]]; then godkand "sudo frågade efter lösenordet ${1} gång(er)"; else underkand "sudo frågade ${fragor:-?} gånger, väntat ${1}"; fi
  if grep -q 'HEMLIG' <<<"$UT"; then underkand "en hemlighet syns i utdata"; else godkand "inga hemligheter i utdata"; fi

  if i_vard "test -f ${K}/app/deploy/compose.yml && [ \"\$(stat -c %u ${K}/app/deploy/compose.yml)\" = 0 ]"; then
    godkand "den committade versionen ligger i ${K}/app, ägd av root"; else underkand "appen saknas eller ägs inte av root"; fi
  # Containrarna kör som andra användare än root (Caddy, node som uid 10001) och läser byggkontextens
  # filer: allt måste vara läsbart för alla, kataloger genomsökbara, skript fortsatt körbara.
  # (Missat först — mellanlagringen hos ops har umask 077, och allt blev 600/700 på värden.)
  if [[ "$(i_vard "stat -c %a ${K}/app/deploy/Caddyfile ${K}/app/apps/platform/src ${K}/app/deploy/driftsatt.sh" 2>/dev/null | paste -sd' ' -)" == "644 755 755" ]]; then
    godkand "filer 644, kataloger 755, skript förblir körbara"; else underkand "fel lägen: $(i_vard "stat -c '%a %n' ${K}/app/deploy/Caddyfile ${K}/app/apps/platform/src ${K}/app/deploy/driftsatt.sh" 2>/dev/null | paste -sd' ' -)"; fi
  if [[ -z "$(i_vard "find ${K}/app ! -perm -o=r" 2>/dev/null)" ]]; then
    godkand "inget i appen är oläsbart för andra"; else underkand "oläsbara filer i appen: $(i_vard "find ${K}/app ! -perm -o=r | head -n 3" | paste -sd' ' -)"; fi
  if [[ "$(i_vard "cat ${K}/app/VERSION" 2>/dev/null)" == "$(git rev-parse --short HEAD)" ]]; then
    godkand "VERSION är HEAD"; else underkand "VERSION stämmer inte med HEAD"; fi
  if i_vard "test ! -e ${K}/app/.env && test ! -e ${K}/app/referens && test ! -e ${K}/app/vault"; then
    godkand "inget lokalt (.env, referens/, vault/) följde med"; else underkand "lokala filer följde med"; fi
  if [[ "$(i_vard "stat -c '%a %U:%G' ${K}/.env" 2>/dev/null)" == "600 root:root" ]]; then
    godkand "serverns .env har läge 600 och ägs av root"; else underkand "serverns .env har fel läge/ägare"; fi
  if i_vard "grep -qx 'BERGET_API_KEY=test-berget-HEMLIG' ${K}/.env && ! grep -q '^LEVERANTOR' ${K}/.env"; then
    godkand "serverns .env har tillåtelselistans nycklar"; else underkand "serverns .env har fel innehåll"; fi
  if i_vard "grep -qx 'APP_VERSION=$(git rev-parse --short HEAD)' ${K}/.env"; then
    godkand "serverns .env säger vilken version som lades ut"; else underkand "APP_VERSION saknas eller är fel i serverns .env"; fi
  if i_vard "test ! -e /home/ops/.driftsatt"; then
    godkand "inget ligger kvar i ops hemkatalog"; else underkand "mellanlagringen ligger kvar hos ops"; fi

  LOGG="$(i_vard 'cat /var/log/docker-stubbe.log' 2>/dev/null || true)"
  if grep -q "compose .*--env-file ${K}/.env up -d --build --remove-orphans --wait" <<<"$LOGG"; then
    godkand "docker compose up körs som root med serverns .env"; else underkand "compose up kördes inte"; fi
  if grep -q 'exec -T -e DATA_DIR=/data platform node packages/identity/src/cli.ts lagg-till anna@example.org builder' <<<"$LOGG"; then
    godkand "första byggaren läggs in"; else underkand "första byggaren lades inte in"; fi
  if grep -q 'HEMLIG' <<<"$LOGG"; then underkand "en hemlighet syns i dockers argument"; else godkand "inga hemligheter i dockers argument"; fi
}

echo "── 1. Utan lösenordsfri regel: sudo frågar efter lösenordet en gång"
tailnet_i_testet
kor_driftsatt
kontrollera_utlagt 1

echo "── 2. Med regeln från provision.sh: inget lösenord, bara det kommandot"
aterstall_vard
docker exec -i "$NAMN" sh -c 'cat >/usr/local/sbin/vibesandbox-driftsatt && chown 0:0 /usr/local/sbin/vibesandbox-driftsatt && chmod 755 /usr/local/sbin/vibesandbox-driftsatt' <infra/vibesandbox-driftsatt
i_vard "echo 'ops ALL=(root) NOPASSWD: /usr/local/sbin/vibesandbox-driftsatt' >/etc/sudoers.d/vibesandbox-driftsatt && chmod 440 /etc/sudoers.d/vibesandbox-driftsatt && visudo -cq"
kor_driftsatt
kontrollera_utlagt 0
if i_vard "su ops -c 'sudo -n true'" >/dev/null 2>&1; then underkand "ops fick annan sudo utan lösenord"; else godkand "all annan sudo kräver fortfarande lösenord"; fi

echo "── 3. Från en klient utanför tailnetet: nekas, inget läggs ut"
aterstall_vard
inte_tailnet
kor_driftsatt
if (( KOD != 0 )) && grep -q 'ligger inte i tailnetet' <<<"$UT"; then godkand "driftsättningen nekas utanför tailnetet"; else underkand "driftsättning utanför tailnetet gav kod ${KOD}"; visa; fi
if i_vard "test ! -e ${K}/app && test ! -e ${K}/.env"; then godkand "inget lades ut"; else underkand "något lades ut trots nekandet"; fi
if i_vard "test ! -e /home/ops/.driftsatt"; then godkand "mellanlagringen städades bort"; else underkand "mellanlagringen ligger kvar"; fi
tailnet_i_testet

echo
echo "   driftsatt: ${GODKANDA} godkända, ${UNDERKANDA} underkända"
(( UNDERKANDA == 0 ))
