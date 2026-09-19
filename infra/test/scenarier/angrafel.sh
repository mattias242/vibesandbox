# shellcheck shell=bash
# Scenario 'angrafel' — när ÅNGRANDET självt går fel, och det som ska hindra att det händer.
#
#   B-3  Ögonblicksbilden synkas till disk innan markören skrivs; en tom eller saknad '.fore'
#        används aldrig (ett strömavbrott kan lämna 0 byte — den får inte kopieras över målet).
#   B-4  Ett misslyckat ångrande loggas som KRITISKT (journalen + wall), en ny timer armeras,
#        och loggen påstår inte att "nästa utlösare försöker igen" när ingen gör det.
#        Uppstartsläget kör 'sshd -t' (efter att ha skapat /run/sshd) och låter ett underkänt
#        resultat synas.
#   C-1  angra_nu släpper låset (fd 8) innan ångra-skriptet körs.
#   C-3  Uppstartsenheten har en tidsgräns.
#
# Source:as av i-container.sh; använder ANGRA, ANGRAKATALOG, FRAGA och kor_backstopp ur avbrott.sh.

KRITLOGG_FIL() { printf '%s' "${STUBBKATALOG}/journal-krit"; }
WALL_FIL() { printf '%s' "${STUBBKATALOG}/wall"; }
nollstall_larm() { : >"$(KRITLOGG_FIL)"; : >"$(WALL_FIL)"; : >"$ANROP"; }

# larmades_kritiskt <etikett> <mönster> — både journalen (prioritet crit) och wall.
larmades_kritiskt() {
  if grep -q -- '-p crit' "$(KRITLOGG_FIL)" 2>/dev/null && grep -q -- "$2" "$(KRITLOGG_FIL)"; then
    godkand "$1: loggat med prioritet crit i journalen"
  else
    underkand "$1: inget crit i journalen"; sed 's/^/      | /' "$(KRITLOGG_FIL)" 2>/dev/null | head -n 5
  fi
  if grep -q -- "$2" "$(WALL_FIL)" 2>/dev/null; then godkand "$1: skickat med wall till alla terminaler"; else underkand "$1: inget wall-meddelande"; fi
}

ny_timer_armerad() { # <etikett> <steg>
  if grep -Eq "^backstopp-armerat enhet=vibesandbox-angra-$2-[0-9]+ " "$ANROP"; then
    godkand "$1: en NY timer är armerad"
  else
    underkand "$1: ingen ny timer armerades"; grep -E '^(systemd-run|backstopp)' "$ANROP" | head -n 3 | sed 's/^/      | /'
  fi
}

scenario_angrafel() {
  forbered_vard
  lat_tailnet_session_finnas
  kor_fas1
  cp /etc/nftables.conf /tmp/nft.orig
  local logg=/var/log/vibesandbox-provision.log

  # ── C-3 ──────────────────────────────────────────────────────────────────────────────────
  test_rubrik "C-3: uppstartsenheten har en tidsgräns"
  pastar "TimeoutStartSec=120" grep -qx 'TimeoutStartSec=120' /infra/vibesandbox-angra-uppstart.service

  # ── B-3 ──────────────────────────────────────────────────────────────────────────────────
  test_rubrik "B-3: ögonblicksbilden synkas till disk INNAN markören skrivs"
  ln -sf /infra/test/stubbar/stubb "${STUBBAR}/sync"
  : >"$ANROP"
  provision_pty "${FRAGA}=>signal:KILL" -- --steg brandvagg --bekrafta-tailscale-ssh
  pastar "förutsättning: obekräftat läge" test -e "${ANGRAKATALOG}/brandvagg/obekraftad"
  if awk '/^sync .*nftables\.conf\.fore/{b=NR} /^sync .*\/obekraftad/{m=NR} END{exit !(b && m && b<m)}' "$ANROP"; then
    godkand "sync av nftables.conf.fore (och katalogen) kommer före markören"
  else
    underkand "ögonblicksbilden synkades inte före markören:"; grep '^sync' "$ANROP" | sed 's/^/      | /'
  fi
  rm -f "${STUBBAR}/sync"

  test_rubrik "B-3: en TOM ögonblicksbild kopieras aldrig över målet"
  cp /etc/nftables.conf /tmp/nft.obekraftad
  : >"${ANGRAKATALOG}/brandvagg/nftables.conf.fore"
  nollstall_larm
  kor_backstopp
  if (( KOD == 1 )); then godkand "backstoppet: slutkod 1 (ångrandet är inte fullständigt)"; else underkand "backstoppet gav kod ${KOD}"; visa_vid_fel 1; fi
  pastar "/etc/nftables.conf är INTE tömd" test -s /etc/nftables.conf
  pastar "…utan orörd" cmp -s /tmp/nft.obekraftad /etc/nftables.conf
  pastar "vägran står i loggen och säger att filen är tom" grep -q 'VÄGRAR återställa /etc/nftables.conf: .*TOM' "$logg"
  pastar "markören ligger kvar" test -e "${ANGRAKATALOG}/brandvagg/obekraftad"
  larmades_kritiskt "tom ögonblicksbild" 'brandvagg'
  ny_timer_armerad "tom ögonblicksbild" brandvagg
  pastar_inte "loggen påstår inte att 'nästa utlösare försöker igen'" grep -q 'nästa utlösare försöker igen' "$logg"

  test_rubrik "B-3: markör men INGEN ögonblicksbild (varken .fore eller .saknades) ⇒ vägran, inte 'orörd'"
  # Bilden skrivs och synkas FÖRE markören ⇒ finns markören men inte bilden är underlaget förlorat.
  find "${ANGRAKATALOG}/brandvagg/nftables.conf.fore" -delete
  nollstall_larm
  kor_backstopp
  if (( KOD == 1 )); then godkand "saknad bild: slutkod 1"; else underkand "saknad bild: kod ${KOD}"; visa_vid_fel 1; fi
  pastar "saknad bild: filen är orörd" cmp -s /tmp/nft.obekraftad /etc/nftables.conf
  pastar "saknad bild: vägran står i loggen" grep -q 'VÄGRAR återställa /etc/nftables.conf: .*SAKNAS' "$logg"
  larmades_kritiskt "saknad bild" 'brandvagg'

  test_rubrik "B-3: uppstartsläget vägrar också en tom ögonblicksbild, och det syns"
  : >"${ANGRAKATALOG}/brandvagg/nftables.conf.fore"
  nollstall_larm
  UT="$(env -i "$ANGRA" --alla --uppstart </dev/null 2>&1)"; KOD=$?
  if (( KOD != 0 )); then godkand "uppstart: slutkod ${KOD} ≠ 0 (enheten markeras som misslyckad)"; else underkand "uppstart: slutkod 0 trots vägran"; fi
  pastar "uppstart: /etc/nftables.conf är inte tömd" cmp -s /tmp/nft.obekraftad /etc/nftables.conf
  larmades_kritiskt "uppstart, tom ögonblicksbild" 'brandvagg'

  test_rubrik "B-3/B-4: med en riktig ögonblicksbild lyckas den nya timern — och stoppas"
  cp /tmp/nft.orig "${ANGRAKATALOG}/brandvagg/nftables.conf.fore"
  : >"$ANROP"
  kor_backstopp
  if (( KOD == 0 )); then godkand "den nya timern: slutkod 0"; else underkand "den nya timern gav kod ${KOD}"; visa_vid_fel 0; fi
  pastar "/etc/nftables.conf är originalet igen" cmp -s /tmp/nft.orig /etc/nftables.conf
  pastar_inte "markören är borta" test -e "${ANGRAKATALOG}/brandvagg/obekraftad"
  if grep -Eq '^systemctl .*stop vibesandbox-angra-brandvagg-[0-9]+\.timer' "$ANROP"; then godkand "den senast armerade timern stoppades"; else underkand "ingen timer stoppades"; fi

  # ── B-4 ──────────────────────────────────────────────────────────────────────────────────
  test_rubrik "B-4: 'sshd -t' underkänner den ÅTERSTÄLLDA konfigurationen"
  cp /etc/ssh/sshd_config /tmp/sshd_config.fore
  provision_pty "${FRAGA}=>signal:KILL" -- --steg ssh --bekrafta-tailscale-ssh
  pastar "förutsättning: obekräftat SSH-läge" test -e "${ANGRAKATALOG}/ssh/obekraftad"
  echo "DettaArIngetDirektiv ja" >>"${ANGRAKATALOG}/ssh/sshd_config.fore"
  nollstall_larm
  kor_backstopp
  if (( KOD == 1 )); then godkand "backstoppet: slutkod 1"; else underkand "backstoppet gav kod ${KOD}"; visa_vid_fel 1; fi
  pastar "underkännandet står i loggen" grep -q 'sshd -t underkänner den ÅTERSTÄLLDA' "$logg"
  pastar "markören ligger kvar" test -e "${ANGRAKATALOG}/ssh/obekraftad"
  larmades_kritiskt "sshd -t underkänner" 'ssh'
  ny_timer_armerad "sshd -t underkänner" ssh
  pastar_inte "loggen påstår inte att 'nästa utlösare försöker igen'" grep -q 'nästa utlösare försöker igen' "$logg"
  pastar "loggen säger när nästa försök görs" grep -Eq 'ssh: ångrandet blev INTE fullständigt .*ny timer .*vibesandbox-angra-ssh-[0-9]+' "$logg"

  test_rubrik "B-4: uppstartsläget kör 'sshd -t' och låter ett underkännande synas"
  nollstall_larm
  rmdir /run/sshd 2>/dev/null
  UT="$(env -i "$ANGRA" --alla --uppstart </dev/null 2>&1)"; KOD=$?
  if (( KOD != 0 )); then godkand "uppstart: slutkod ${KOD} ≠ 0"; else underkand "uppstart: slutkod 0 fast den återställda sshd-konfigurationen är trasig"; fi
  pastar "uppstart: /run/sshd skapades så att 'sshd -t' går att köra" test -d /run/sshd
  pastar "uppstart: underkännandet står i loggen" grep -q 'uppstart: sshd -t underkänner' "$logg"
  larmades_kritiskt "uppstart, sshd -t underkänner" 'ssh'
  pastar "uppstart: markören ligger kvar" test -e "${ANGRAKATALOG}/ssh/obekraftad"

  test_rubrik "B-4: rättat underlag ⇒ den nya timern ångrar"
  cp /tmp/sshd_config.fore "${ANGRAKATALOG}/ssh/sshd_config.fore"
  kor_backstopp
  if (( KOD == 0 )); then godkand "slutkod 0"; else underkand "kod ${KOD}"; visa_vid_fel 0; fi
  pastar "sshd_config är läget före" cmp -s /tmp/sshd_config.fore /etc/ssh/sshd_config
  pastar "sshd -t godkänner" sshd -t
  pastar_inte "markören är borta" test -e "${ANGRAKATALOG}/ssh/obekraftad"

  test_rubrik "B-4: uppstartsläget med giltig konfiguration ⇒ 'sshd -t' godkänner, slutkod 0"
  provision_pty "${FRAGA}=>signal:KILL" -- --steg ssh --bekrafta-tailscale-ssh
  rmdir /run/sshd 2>/dev/null
  # shellcheck disable=SC2034  # UT läses av visa_vid_fel
  UT="$(env -i "$ANGRA" --alla --uppstart </dev/null 2>&1)"; KOD=$?
  if (( KOD == 0 )); then godkand "uppstart: slutkod 0"; else underkand "uppstart: kod ${KOD}"; visa_vid_fel 0; fi
  pastar "uppstart: 'sshd -t' kördes och godkände" grep -q 'uppstart: sshd -t godkänner' "$logg"
  pastar_inte "uppstart: markören är borta" test -e "${ANGRAKATALOG}/ssh/obekraftad"

  # ── C-1 ──────────────────────────────────────────────────────────────────────────────────
  test_rubrik "C-1: angra_nu släpper låset på fd 8 innan ångra-skriptet körs"
  # Funktionen körs isolerad: låset hålls på fd 8 (som i angra_bekrafta när en signal kommer
  # mellan flock och rm), och "ångra-skriptet" provar att ta samma lås utan att vänta.
  printf '#!/bin/bash\nexec flock -n /tmp/c1.las true\n' >/tmp/c1-angra
  chmod +x /tmp/c1-angra
  if bash -c "$(sed -n '/^angra_nu() {/,/^}/p' /infra/provision.sh)"'
      exec 8>>/tmp/c1.las; flock 8 || exit 3
      ANGRA_STEG=brandvagg; ANGRA_SKRIPT=/tmp/c1-angra
      angra_nu'; then
    godkand "ångra-skriptet fick låset direkt (fd 8 var stängd)"
  else
    underkand "ångra-skriptet fick inte låset — det hade väntat 300 s"
  fi
}
