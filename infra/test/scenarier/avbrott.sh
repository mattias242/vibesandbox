# shellcheck shell=bash
# Scenario 'avbrott' — AVBROTT och MELLANLÄGEN i de två steg som kan låsa ute ägaren.
#
# De äldre scenarierna prövar bara färdiga körningar och det ångrande som utlöses av att
# terminalen saknas. Här dödas skriptet VID frågan (Ctrl-C, SIGTERM, kill -9), steget körs om
# efter ett avbrott, och det som timern/uppstartsenheten skulle ha kört körs på riktigt — med
# tom miljö och utan att provision.sh finns kvar.
#
# Source:as av i-container.sh; använder dess hjälpfunktioner (provision, provision_pty, pastar …).

ANGRA=/usr/local/sbin/vibesandbox-angra
ANGRAKATALOG=/etc/vibesandbox/angra
FRAGA="Skriv JA inom"

# Senast armerade backstopp: filen med kommandot som den transienta timern skulle ha kört
# (ett argument per rad; skrivs av stubben för systemd-run).
senaste_backstopp() {
  local f nyast=""
  for f in "${STUBBKATALOG}/tillstand/backstopp/"*.kommando; do
    [[ -e "$f" ]] || continue
    if [[ -z "$nyast" || "$f" -nt "$nyast" ]]; then nyast="$f"; fi
  done
  printf '%s' "$nyast"
}

# Kör det timern skulle ha kört, så som systemd kör det: TOM miljö, ingen terminal.
kor_backstopp() {
  local fil kmd
  fil="$(senaste_backstopp)"
  [[ -n "$fil" ]] || { UT="inget backstopp har armerats"; KOD=99; return 0; }
  mapfile -t kmd <"$fil"
  UT="$(env -i "${kmd[@]}" </dev/null 2>&1)"; KOD=$?
}

brandvagg_ar_angrad() { # <etikett>
  pastar_inte "$1: tabellen finns inte kvar i kärnan" nft list table inet vibesandbox
  pastar "$1: /etc/nftables.conf är byte-identisk med originalet" cmp -s /tmp/nft.orig /etc/nftables.conf
  pastar_inte "$1: ingen obekräftad-markör ligger kvar" test -e "${ANGRAKATALOG}/brandvagg/obekraftad"
  pastar_inte "$1: ingen bekräftelsemarkör har skrivits" test -e /etc/vibesandbox/brandvagg.bekraftad
}

ssh_ar_angrad() { # <etikett>
  pastar_inte "$1: vår dropin är borta" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  pastar "$1: sshd_config är byte-identisk med läget före" cmp -s /tmp/sshd_config.fore /etc/ssh/sshd_config
  pastar "$1: sshd-konfigurationen är giltig" sshd -t
  pastar_inte "$1: ingen obekräftad-markör ligger kvar" test -e "${ANGRAKATALOG}/ssh/obekraftad"
  pastar_inte "$1: ingen bekräftelsemarkör har skrivits" test -e /etc/vibesandbox/ssh.bekraftad
  if [[ "$(passwd -S root | awk '{print $2}')" == "L" ]]; then underkand "$1: root LÅSTES trots att inget bekräftades"; else godkand "$1: roots lösenord är inte låst"; fi
}

# Ställdes JA-frågan? pty-kor.py:s egna meddelanden ('[[pty-kor: mönstret … dök aldrig upp]]')
# citerar mönstret och får därför inte räknas — annars kan testet aldrig bli rött.
fraga_i_utdata() { grep -v '^\[\[pty-kor' <<<"$UT" | grep -q -- "$FRAGA"; }
antal_fragor() { grep -v '^\[\[pty-kor' <<<"$UT" | grep -c -- "$FRAGA"; }

fragan_stalldes() { # <etikett>
  if fraga_i_utdata; then godkand "$1: frågan ställdes (avbrottet skedde alltså VID frågan)"; else underkand "$1: frågan ställdes aldrig (kod ${KOD})"; visa_vid_fel 0; fi
}

scenario_avbrott() {
  forbered_vard
  lat_tailnet_session_finnas
  kor_fas1
  cp /etc/nftables.conf /tmp/nft.orig

  # ── A3 ───────────────────────────────────────────────────────────────────────────────────
  test_rubrik "A3: ångrad brandvägg ⇒ filen på disk är tillbaka, inte bara tabellen i kärnan"
  pastar "förutsättning: paketets standardfil ligger på plats (den med 'flush ruleset')" grep -q 'flush ruleset' /tmp/nft.orig
  provision --steg brandvagg --bekrafta-tailscale-ssh
  if (( KOD != 0 )); then godkand "utan terminal: steget avslutas med fel"; else underkand "utan terminal: steget lyckades utan JA"; fi
  brandvagg_ar_angrad "utan terminal"
  pastar "ångrandet är loggat" grep -q 'ÅNGRAR brandvägg' /var/log/vibesandbox-provision.log

  # ── A1: brandväggen ──────────────────────────────────────────────────────────────────────
  test_rubrik "A1: Ctrl-C vid frågan ⇒ ångrat"
  provision_pty "${FRAGA}=>ctrlc" -- --steg brandvagg --bekrafta-tailscale-ssh
  fragan_stalldes "Ctrl-C"
  # 130 och inte 124 (pty-kor:s tidsgräns): skriptet ska AVSLUTAS, inte ångra och sedan hänga.
  if (( KOD == 130 )); then godkand "Ctrl-C: skriptet avslutas direkt med kod 130"; else underkand "Ctrl-C: slutkod ${KOD} (124 = hängde tills tidsgränsen)"; fi
  brandvagg_ar_angrad "Ctrl-C"

  test_rubrik "A1: SIGTERM vid frågan ⇒ ångrat"
  provision_pty "${FRAGA}=>signal:TERM" -- --steg brandvagg --bekrafta-tailscale-ssh
  fragan_stalldes "SIGTERM"
  if (( KOD == 143 )); then godkand "SIGTERM: skriptet avslutas direkt med kod 143"; else underkand "SIGTERM: slutkod ${KOD} (124 = hängde tills tidsgränsen)"; fi
  brandvagg_ar_angrad "SIGTERM"

  test_rubrik "A1: kill -9 vid frågan ⇒ skriptet hinner ingenting — backstoppet ångrar"
  : >"$ANROP"
  provision_pty "${FRAGA}=>signal:KILL" -- --steg brandvagg --bekrafta-tailscale-ssh
  fragan_stalldes "kill -9"
  if (( KOD == 137 )); then godkand "kill -9: skriptet dog av SIGKILL"; else underkand "kill -9: oväntad slutkod ${KOD}"; fi
  pastar "kill -9: läget ÄR obekräftat — tabellen ligger laddad (det är det här fönstret som är farligt)" nft list table inet vibesandbox
  pastar "kill -9: markören 'obekraftad' finns" test -e "${ANGRAKATALOG}/brandvagg/obekraftad"
  if [[ "$(stat -c '%a %U:%G' "$ANGRAKATALOG" 2>/dev/null)" == "700 root:root" && "$(stat -c '%a %U:%G' "${ANGRAKATALOG}/brandvagg" 2>/dev/null)" == "700 root:root" ]]; then
    godkand "kill -9: ångra-underlaget ligger i kataloger med 700 root:root"; else underkand "kill -9: fel rättigheter på ångra-underlaget ($(stat -c '%a %U:%G' "$ANGRAKATALOG" 2>&1))"; fi
  pastar "kill -9: backstoppet armerades FÖRE ändringen (tabellen var inte laddad då)" grep -Eq '^backstopp-armerat enhet=vibesandbox-angra-brandvagg-[0-9]+ tabell=0 ' "$ANROP"
  pastar "kill -9: armerat som en transient timer (systemd-run --on-active)" grep -Eq '^systemd-run .*--on-active=[0-9]+s?\b' "$ANROP"
  if [[ "$(tr '\n' ' ' <"$(senaste_backstopp)" 2>/dev/null)" == "${ANGRA} brandvagg " ]]; then godkand "kill -9: timern kör det fristående ångra-skriptet och inget annat"; else underkand "kill -9: timerns kommando är '$(tr '\n' ' ' <"$(senaste_backstopp)" 2>/dev/null)'"; fi
  pastar "kill -9: ångra-skriptet är installerat, körbart och ägt av root" test "$(stat -c '%a %U' "$ANGRA" 2>/dev/null)" = "755 root"
  pastar "kill -9: uppstartsenheten var aktiverad innan ändringen gjordes" test -e "${STUBBKATALOG}/tillstand/aktiverad/vibesandbox-angra-uppstart.service"
  # Oberoendet: provision.sh och hela infra-katalogen är BORTA när timern löper ut.
  mv "$INFRA" "${INFRA}-borta"
  kor_backstopp
  if (( KOD == 0 )); then godkand "backstoppet: körs med tom miljö och utan provision.sh, slutkod 0"; else underkand "backstoppet gav kod ${KOD}"; visa_vid_fel 0; fi
  brandvagg_ar_angrad "backstoppet"
  kor_backstopp
  if (( KOD == 0 )); then godkand "backstoppet en gång till: idempotent, slutkod 0"; else underkand "andra körningen gav kod ${KOD}"; visa_vid_fel 0; fi
  brandvagg_ar_angrad "backstoppet, andra körningen"
  mv "${INFRA}-borta" "$INFRA"

  test_rubrik "A1: omstart i fönstret (transienta timrar försvinner) ⇒ uppstartsenheten ångrar"
  provision_pty "${FRAGA}=>signal:KILL" -- --steg brandvagg --bekrafta-tailscale-ssh
  pastar "förutsättning: obekräftat läge igen" test -e "${ANGRAKATALOG}/brandvagg/obekraftad"
  pastar "uppstartsenheten finns och pekar på ångra-skriptet" grep -q "^ExecStart=${ANGRA} --alla --uppstart\$" /etc/systemd/system/vibesandbox-angra-uppstart.service
  pastar "…körs bara när en obekräftad-markör finns" grep -q "^ConditionPathExistsGlob=${ANGRAKATALOG}/\*/obekraftad\$" /etc/systemd/system/vibesandbox-angra-uppstart.service
  pastar "…och före brandvägg, sshd och nätverk" grep -Eq '^Before=.*nftables\.service.*ssh\.service' /etc/systemd/system/vibesandbox-angra-uppstart.service
  UT="$(env -i "$ANGRA" --alla --uppstart </dev/null 2>&1)"; KOD=$?
  if (( KOD == 0 )); then godkand "uppstartsläget: slutkod 0"; else underkand "uppstartsläget gav kod ${KOD}"; visa_vid_fel 0; fi
  brandvagg_ar_angrad "efter omstart"

  test_rubrik "A1: ett underlag som andra kan skriva i används inte"
  provision_pty "${FRAGA}=>signal:KILL" -- --steg brandvagg --bekrafta-tailscale-ssh
  chmod 777 "$ANGRAKATALOG"
  kor_backstopp
  if (( KOD != 0 )); then godkand "ångra-skriptet vägrar (kod ${KOD}) när katalogen har läge 777"; else underkand "ångra-skriptet litade på en katalog med läge 777"; fi
  pastar "…och vägran är loggad" grep -q 'VÄGRAR' /var/log/vibesandbox-provision.log
  chmod 700 "$ANGRAKATALOG"
  kor_backstopp
  brandvagg_ar_angrad "med rättade rättigheter"

  test_rubrik "A1: går backstoppet inte att armera görs ingen ändring alls"
  touch "${STUBBKATALOG}/systemd-run-misslyckas"
  provision_pty -- --steg brandvagg --bekrafta-tailscale-ssh
  if (( KOD != 0 )) && innehaller "$UT" "backstoppet gick inte att armera"; then godkand "steget avbryts med besked om backstoppet"; else underkand "steget fortsatte utan backstopp (kod ${KOD})"; fi
  if fraga_i_utdata; then underkand "frågan ställdes fast inget backstopp fanns"; else godkand "…innan någon fråga ställdes"; fi
  brandvagg_ar_angrad "utan backstopp"
  mv "${STUBBKATALOG}/systemd-run-misslyckas" /tmp/

  test_rubrik "A1: JA ⇒ ändringen behålls, backstoppet avbryts, markören är borta"
  provision_pty "${FRAGA}=>skicka:JA" -- --steg brandvagg --bekrafta-tailscale-ssh
  if (( KOD == 0 )); then godkand "JA: steget avslutas med 0"; else underkand "JA: kod ${KOD}"; visa_vid_fel 0; fi
  pastar "JA: tabellen är laddad" nft list table inet vibesandbox
  pastar_inte "JA: markören 'obekraftad' är borta" test -e "${ANGRAKATALOG}/brandvagg/obekraftad"
  pastar "JA: bekräftelsemarkören stämmer med filen på disk" sha256sum -c --status /etc/vibesandbox/brandvagg.bekraftad
  local enhet
  enhet="$(basename "$(senaste_backstopp)" .kommando)"
  pastar "JA: just den armerade timern (${enhet}) stoppades" test -e "${STUBBKATALOG}/tillstand/backstopp/${enhet}.stoppad"
  cp /etc/nftables.conf /tmp/nft.bekraftad
  kor_backstopp
  pastar "JA: löper en kvarglömd timer ändå ut händer ingenting — tabellen ligger kvar" nft list table inet vibesandbox
  pastar "JA: …och filen är orörd" cmp -s /tmp/nft.bekraftad /etc/nftables.conf

  test_rubrik "En GAMMAL ögonblicksbild återställs aldrig: ångrad ändring ⇒ det senast BEKRÄFTADE läget"
  PUBLIC_TCP_PORTS="80 443" provision --steg brandvagg --bekrafta-tailscale-ssh
  if (( KOD != 0 )); then godkand "ändrad portlista utan JA: avslutas med fel"; else underkand "ändrad portlista utan JA: lyckades"; fi
  pastar "filen är den bekräftade versionen (inte paketets standardfil, inte den nya)" cmp -s /tmp/nft.bekraftad /etc/nftables.conf
  pastar "den bekräftade tabellen är laddad igen" nft list table inet vibesandbox
  if nft list table inet vibesandbox 2>/dev/null | grep -q 'tcp dport { 80, 443 }'; then underkand "port 80 ligger kvar i den laddade tabellen"; else godkand "port 80 finns inte i den laddade tabellen"; fi
  pastar "bekräftelsemarkören gäller fortfarande" sha256sum -c --status /etc/vibesandbox/brandvagg.bekraftad

  test_rubrik "A3: fanns ingen fil före tas den nya bort"
  nft delete table inet vibesandbox
  find /etc/nftables.conf /etc/vibesandbox/brandvagg.bekraftad /etc/vibesandbox/nft.sha256 -delete 2>/dev/null
  provision --steg brandvagg --bekrafta-tailscale-ssh
  pastar_inte "ingen /etc/nftables.conf ligger kvar efter ångrandet" test -e /etc/nftables.conf
  pastar_inte "tabellen finns inte i kärnan" nft list table inet vibesandbox
  cp /tmp/nft.orig /etc/nftables.conf

  # ── A1 + A2: SSH ─────────────────────────────────────────────────────────────────────────
  # Ett direktiv FÖRE Include-raden ⇒ steget måste ändra även sshd_config, och ångrandet ska
  # återställa den byte för byte.
  { echo "LoginGraceTime 61"; cat /etc/ssh/sshd_config; } >/tmp/sshd_config.fore
  cp /tmp/sshd_config.fore /etc/ssh/sshd_config

  test_rubrik "A1: Ctrl-C vid SSH-frågan ⇒ dropin borta, sshd_config tillbaka, sshd omladdad, root olåst"
  : >"$ANROP"
  provision_pty "${FRAGA}=>ctrlc" -- --steg ssh --bekrafta-tailscale-ssh
  fragan_stalldes "SSH, Ctrl-C"
  if (( KOD == 130 )); then godkand "SSH, Ctrl-C: skriptet avslutas direkt med kod 130"; else underkand "SSH, Ctrl-C: slutkod ${KOD} (124 = hängde tills tidsgränsen)"; fi
  ssh_ar_angrad "SSH, Ctrl-C"
  if (( $(grep -c '^systemctl reload ssh' "$ANROP") >= 2 )); then godkand "SSH, Ctrl-C: sshd laddades om igen EFTER återställningen"; else underkand "SSH, Ctrl-C: sshd kör kvar med den obekräftade konfigurationen"; fi

  test_rubrik "A1: kill -9 vid SSH-frågan ⇒ backstoppet ångrar"
  : >"$ANROP"
  provision_pty "${FRAGA}=>signal:KILL" -- --steg ssh --bekrafta-tailscale-ssh
  fragan_stalldes "SSH, kill -9"
  pastar "SSH, kill -9: läget ÄR obekräftat — dropinen ligger på plats" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  pastar "SSH, kill -9: backstoppet armerades FÖRE ändringen" grep -Eq '^backstopp-armerat enhet=vibesandbox-angra-ssh-[0-9]+ .*dropin=0$' "$ANROP"
  : >"$ANROP"
  kor_backstopp
  if (( KOD == 0 )); then godkand "SSH, backstoppet: slutkod 0"; else underkand "SSH, backstoppet gav kod ${KOD}"; visa_vid_fel 0; fi
  ssh_ar_angrad "SSH, backstoppet"
  pastar "SSH, backstoppet: sshd laddades om med den återställda konfigurationen" grep -q '^systemctl reload ssh' "$ANROP"

  test_rubrik "A2: avbrott efter filskrivning men före JA, sedan '--steg ssh' igen"
  provision_pty "${FRAGA}=>signal:KILL" -- --steg ssh --bekrafta-tailscale-ssh
  pastar "förutsättning: filerna är skrivna men ingenting är bekräftat" test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf
  provision_pty "${FRAGA}=>kor:passwd -S root" "=>skicka:JA" -- --steg ssh --bekrafta-tailscale-ssh
  if fraga_i_utdata; then godkand "omkörningen ställer frågan IGEN"; else underkand "omkörningen hoppade över bekräftelsen (kod ${KOD})"; visa_vid_fel 0; fi
  if grep -A1 '^\[\[kor: passwd -S root\]\]' <<<"$UT" | grep -Eq '^root (P|NP) '; then godkand "root är INTE låst medan frågan står obesvarad"; else underkand "root var redan låst innan ägaren hade svarat"; fi
  if (( KOD == 0 )); then godkand "efter JA: steget avslutas med 0"; else underkand "efter JA: kod ${KOD}"; visa_vid_fel 0; fi
  if [[ "$(passwd -S root | awk '{print $2}')" == "L" ]]; then godkand "efter JA: root är låst"; else underkand "efter JA: root låstes inte"; fi
  pastar "efter JA: bekräftelsemarkören täcker dropin och sshd_config" sha256sum -c --status /etc/vibesandbox/ssh.bekraftad
  if [[ "$(grep -c . /etc/vibesandbox/ssh.bekraftad 2>/dev/null)" == 2 ]]; then godkand "…båda filerna står i markören"; else underkand "markören täcker inte två filer"; fi
  pastar_inte "efter JA: markören 'obekraftad' är borta" test -e "${ANGRAKATALOG}/ssh/obekraftad"

  test_rubrik "A2: filerna på plats men markören saknas (underlaget borta) ⇒ bekräftelsen görs om"
  usermod -p "$(openssl passwd -6 -salt rotsalt 'leverantorens-rotlosenord')" root
  find /etc/vibesandbox/ssh.bekraftad -delete
  cp /etc/ssh/sshd_config /tmp/sshd_config.fore; cp /etc/ssh/sshd_config.d/0-0-vibesandbox.conf /tmp/dropin.fore
  provision_pty "${FRAGA}=>ctrlc" -- --steg ssh --bekrafta-tailscale-ssh
  if fraga_i_utdata && (( KOD != 0 )); then godkand "utan markör: frågan ställs igen, och utan JA avslutas steget med fel"; else underkand "utan markör: steget godtog filerna som bekräftade (kod ${KOD})"; fi
  if [[ "$(passwd -S root | awk '{print $2}')" == "L" ]]; then underkand "root låstes fast ingenting har bekräftats"; else godkand "root låses inte utan markör"; fi
  # Ångrat = EXAKT läget före steget. Filerna låg redan där, alltså ligger de kvar orörda.
  if cmp -s /tmp/dropin.fore /etc/ssh/sshd_config.d/0-0-vibesandbox.conf && cmp -s /tmp/sshd_config.fore /etc/ssh/sshd_config; then
    godkand "ångrat betyder exakt läget före steget: båda filerna är byte-identiska"; else underkand "filerna ändrades av ett steg som aldrig bekräftades"; fi
  pastar_inte "…och ingen markör skrevs" test -e /etc/vibesandbox/ssh.bekraftad

  test_rubrik "A2: en fil som ändrats efter bekräftelsen ⇒ bekräftelsen görs om"
  provision_pty "${FRAGA}=>skicka:JA" -- --steg ssh --bekrafta-tailscale-ssh
  pastar "förutsättning: bekräftat läge" sha256sum -c --status /etc/vibesandbox/ssh.bekraftad
  echo "# en kontrollpanel har skrivit här" >>/etc/ssh/sshd_config
  provision_pty "${FRAGA}=>skicka:JA" -- --steg ssh --bekrafta-tailscale-ssh
  if fraga_i_utdata && (( KOD == 0 )); then godkand "hashen stämmer inte ⇒ sshd -t, omladdning och fråga på nytt"; else underkand "en ändrad sshd_config godtogs utan ny bekräftelse (kod ${KOD})"; fi
  pastar "…och markören är uppdaterad" sha256sum -c --status /etc/vibesandbox/ssh.bekraftad

  test_rubrik "Oförändrat och bekräftat läge ⇒ ingen fråga, inget backstopp, ingen omladdning"
  : >"$ANROP"
  provision --steg ssh --bekrafta-tailscale-ssh
  if (( KOD == 0 )); then godkand "slutkod 0 utan terminal (ingen fråga behövdes)"; else underkand "kod ${KOD}"; visa_vid_fel 0; fi
  pastar_inte "inget backstopp armerades" grep -q '^systemd-run' "$ANROP"
  pastar_inte "sshd laddades inte om" grep -q '^systemctl reload' "$ANROP"
}

# Hela fas 2 med RIKTIGA svar på båda frågorna — den väg ägaren faktiskt går. De äldre
# scenarierna kör alltid med --ingen-bekraftelse och prövar därför aldrig den.
scenario_fas2ja() {
  forbered_vard
  lat_tailnet_session_finnas
  kor_fas1
  test_rubrik "Fas 2 med JA på båda frågorna"
  : >"$ANROP"
  provision_pty "${FRAGA}=>skicka:JA" "${FRAGA}=>skicka:JA" -- --bekrafta-tailscale-ssh
  if (( KOD == 0 )); then godkand "fas 2 avslutas med 0"; else underkand "fas 2 gav kod ${KOD}"; visa_vid_fel 0; fi
  if [[ "$(antal_fragor)" == 2 ]]; then godkand "två frågor ställdes (brandvägg, SSH)"; else underkand "fel antal frågor"; fi
  pastar "brandväggen är bekräftad" sha256sum -c --status /etc/vibesandbox/brandvagg.bekraftad
  pastar "SSH är bekräftat" sha256sum -c --status /etc/vibesandbox/ssh.bekraftad
  if compgen -G "${ANGRAKATALOG}/*/obekraftad" >/dev/null; then underkand "en obekräftad-markör ligger kvar"; else godkand "inga obekräftad-markörer ligger kvar"; fi
  if [[ "$(grep -c '^backstopp-armerat' "$ANROP")" == 2 && "$(find "${STUBBKATALOG}/tillstand/backstopp" -name '*.stoppad' | wc -l)" == 2 ]]; then
    godkand "två backstopp armerades och båda stoppades efter JA"; else underkand "backstoppen: $(grep -c '^backstopp-armerat' "$ANROP") armerade, $(find "${STUBBKATALOG}/tillstand/backstopp" -name '*.stoppad' 2>/dev/null | wc -l) stoppade"; fi
  if [[ "$(passwd -S root | awk '{print $2}')" == "L" ]]; then godkand "root är låst"; else underkand "root är inte låst"; fi
  if awk '/^backstopp-armerat enhet=vibesandbox-angra-ssh/{a=NR} /^systemctl reload ssh/{r=NR} END{exit !(a && r && a<r)}' "$ANROP"; then
    godkand "SSH-backstoppet armerades före omladdningen av sshd"; else underkand "ordningen backstopp → omladdning stämmer inte"; fi

  test_rubrik "…och en gång till: inget frågas, inget ändras"
  local fore efter
  fore="$(ogonblicksbild)"; : >"$ANROP"
  provision --bekrafta-tailscale-ssh
  efter="$(ogonblicksbild)"
  if (( KOD == 0 )); then godkand "andra körningen avslutas med 0 utan terminal"; else underkand "andra körningen gav kod ${KOD}"; visa_vid_fel 0; fi
  if [[ "$fore" == "$efter" ]]; then godkand "inga filer ändrades"; else underkand "andra körningen ändrade filer:"; diff <(echo "$fore") <(echo "$efter") | head -n 20; fi
  pastar_inte "inget backstopp armerades" grep -q '^systemd-run' "$ANROP"
}
