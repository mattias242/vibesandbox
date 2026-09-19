# shellcheck shell=bash
# Scenario 'besked' — det ägaren SER efter JA-frågan, och vad --ingen-bekraftelse får göra.
#
#   B-1  Att stänga terminalens fd får inte tysta resten av körningen: "ÅNGRAD"-beskedet och
#        senare varningar/avbrott ska synas efter en tidsgräns, efter fel svar, utan terminal
#        och efter ett första JA.
#   B-2  --ingen-bekraftelse tar bort både frågan och backstoppet. Då får roots lösenord aldrig
#        låsas — inte heller av en senare körning som litar på den "bekräftelsen".
#
# Source:as av i-container.sh; använder dess hjälpfunktioner och FRAGA ur avbrott.sh.

visa_utdata() { printf '%s\n' "$UT" | grep -v '^\[\[pty-kor' | tail -n 15 | sed 's/^/      | /'; }

# godkant_om <beskrivning> <villkor…> — villkoret är ett kommando; vid fel visas utdata.
godkant_om() { local b="$1"; shift; if "$@"; then godkand "$b"; else underkand "$b (kod ${KOD})"; visa_utdata; fi; }

root_last() { [[ "$(passwd -S root | awk '{print $2}')" == "L" ]]; }

scenario_besked() {
  forbered_vard
  lat_tailnet_session_finnas
  kor_fas1

  # ── B-1 ──────────────────────────────────────────────────────────────────────────────────
  test_rubrik "B-1: utan terminal ⇒ ångrat, OCH beskedet om det syns"
  provision --steg brandvagg --bekrafta-tailscale-ssh
  godkant_om "utan terminal: 'ÅNGRAD' står i utdata" innehaller "$UT" 'steget "brandvagg" är ÅNGRAD'
  pastar "utan terminal: …och i loggfilen" grep -q 'steget "brandvagg" är ÅNGRAD' /var/log/vibesandbox-provision.log

  test_rubrik "B-1: tidsgränsen löper ut ⇒ beskedet syns"
  BEKRAFTELSE_SEKUNDER=5 provision_pty -- --steg brandvagg --bekrafta-tailscale-ssh
  godkant_om "tidsgräns: frågan anger den kortade tidsgränsen (5 s)" innehaller "$UT" 'Skriv JA inom 5 sekunder'
  godkant_om "tidsgräns: slutkod 1 (inte pty-kor:s 124)" test "$KOD" = 1
  godkant_om "tidsgräns: 'ÅNGRAD' står i utdata" innehaller "$UT" 'steget "brandvagg" är ÅNGRAD'
  pastar_inte "tidsgräns: tabellen är borta" nft list table inet vibesandbox

  test_rubrik "B-1: fel svar ⇒ beskedet syns"
  provision_pty "${FRAGA}=>skicka:NEJ" -- --steg brandvagg --bekrafta-tailscale-ssh
  godkant_om "fel svar: 'ÅNGRAD' står i utdata" innehaller "$UT" 'steget "brandvagg" är ÅNGRAD'

  test_rubrik "B-1: efter ett första JA syns senare varningar och avbrott"
  echo "PermitRootLogin yes" >/etc/ssh/sshd_config.d/0-0-aaa.conf
  provision_pty "${FRAGA}=>skicka:JA" -- --steg brandvagg --steg ssh --bekrafta-tailscale-ssh
  pastar "förutsättning: brandväggen bekräftades" sha256sum -c --status /etc/vibesandbox/brandvagg.bekraftad
  godkant_om "efter JA: varningen om dropinen som sorteras före vår syns" innehaller "$UT" 'dropins som sorteras FÖRE vår'
  godkant_om "efter JA: avbrottet syns och pekar ut filen" innehaller "$UT" 'AVBRUTET: .*0-0-aaa\.conf'
  mv /etc/ssh/sshd_config.d/0-0-aaa.conf /tmp/

  find /etc/vibesandbox/brandvagg.bekraftad -delete
  provision_pty "${FRAGA}=>skicka:JA" "${FRAGA}=>skicka:NEJ" -- --steg brandvagg --steg ssh --bekrafta-tailscale-ssh
  godkant_om "JA, sedan NEJ: två frågor ställdes" test "$(antal_fragor)" = 2
  godkant_om "JA, sedan NEJ: 'ÅNGRAD' för SSH-steget står i utdata" innehaller "$UT" 'steget "ssh" är ÅNGRAD'
  pastar_inte "JA, sedan NEJ: SSH-dropinen är borta" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf

  # ── B-2 ──────────────────────────────────────────────────────────────────────────────────
  test_rubrik "B-2: --ingen-bekraftelse låser aldrig root"
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  godkant_om "slutkod 0 (härdningen i sig är gjord)" test "$KOD" = 0
  if root_last; then underkand "root LÅSTES med --ingen-bekraftelse"; else godkand "roots lösenord är inte låst"; fi
  godkant_om "…och skriptet säger varför" innehaller "$UT" 'roots lösenord låses INTE.*--ingen-bekraftelse'
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  if root_last; then underkand "andra körningen med flaggan låste root"; else godkand "andra körningen med flaggan låser inte heller"; fi

  test_rubrik "B-2: en senare körning UTAN flaggan litar inte på den 'bekräftelsen'"
  provision --steg ssh --bekrafta-tailscale-ssh
  godkant_om "utan terminal: frågan ställs igen och steget avslutas med fel" test "$KOD" != 0
  if root_last; then underkand "root låstes utan att en människa svarat JA"; else godkand "root är fortfarande inte låst"; fi
  provision_pty "${FRAGA}=>skicka:JA" -- --steg ssh --bekrafta-tailscale-ssh
  godkant_om "med ett riktigt JA: slutkod 0" test "$KOD" = 0
  if root_last; then godkand "…och först då låses root"; else underkand "root låstes inte efter JA"; fi
  provision --steg ssh --bekrafta-tailscale-ssh --ingen-bekraftelse
  godkant_om "flaggan efter ett riktigt JA: inget att fråga, slutkod 0" test "$KOD" = 0
  if root_last; then godkand "…och root förblir låst"; else underkand "root låstes upp"; fi
  pastar "hjälptexten säger att flaggan aldrig låser root" bash -c "/infra/provision.sh --hjalp | grep -A3 -- '--ingen-bekraftelse' | grep -qi 'root'"
  pastar "README: flaggan får aldrig användas mot en riktig server, och den låser inte root" \
    bash -c "grep -i -- '--ingen-bekraftelse' /infra/README.md | grep -qi 'låser .*root\|root.*låses'"
}
