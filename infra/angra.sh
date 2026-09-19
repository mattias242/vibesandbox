#!/bin/bash -p
# angra.sh — installeras som /usr/local/sbin/vibesandbox-angra av provision.sh.
#
# Ångrar en OBEKRÄFTAD ändring av brandväggen eller sshd. Det här är backstoppet bakom
# provision.sh:s "död mans grepp": ångrandet får inte hänga på att provision.sh lever.
# Skriptet körs därför av tre av varandra oberoende utlösare:
#
#   1. provision.sh självt   — tidsgräns, fel svar, Ctrl-C, SIGTERM, avbrott av vilket skäl som helst;
#   2. en transient timer    — 'systemd-run --on-active=…', armerad FÖRE ändringen: täcker kill -9,
#                              OOM-dödaren och en tappad anslutning;
#   3. en enhet vid uppstart — transienta timrar överlever inte en omstart; markören gör det.
#
# Auktoriteten är MARKÖREN  /etc/vibesandbox/angra/<steg>/obekraftad , inte utlösarna:
#   finns den  ⇒ ändringen är gjord men ägaren har inte svarat JA  ⇒ ångra;
#   saknas den ⇒ gör ingenting. En kvarglömd timer som löper ut efter ett JA är alltså ofarlig.
# provision.sh tar bort markören (under samma lås som används här) i samma ögonblick som ägaren
# svarar JA, och skriver den INNAN ändringen görs.
#
# Fristående med flit: läser ingen konfiguration, ingen miljö och ingenting ur infra-katalogen.
# Målsökvägarna är hårdkodade — underlaget kan bara säga "så här såg FILEN ut före", aldrig
# "skriv den här filen DIT". Underlaget används bara om det ligger i rootägda kataloger med 700.
#
#   vibesandbox-angra [--uppstart] (--alla | brandvagg | ssh)…
#
# Slutkod: 0 = ångrat eller ingenting att ångra, 1 = något gick inte att återställa (markören
# ligger då kvar, så att nästa utlösare försöker igen), 2 = vägrar (fel anrop, inte root eller
# ett underlag som inte går att lita på).

# Inte -e: varje delsteg ska försökas även om ett annat misslyckas. -p (första raden): bash
# läser varken BASH_ENV eller funktioner ur miljön.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
IFS=$' \t\n'
umask 077

readonly BAS=/etc/vibesandbox/angra
readonly LOGG=/var/log/vibesandbox-provision.log
readonly NFT_TABELL=vibesandbox
readonly NFT_FIL=/etc/nftables.conf
readonly SSHD_CONFIG=/etc/ssh/sshd_config
readonly SSH_DROPIN=/etc/ssh/sshd_config.d/0-0-vibesandbox.conf
readonly GILTIGA_STEG=(brandvagg ssh)

UPPSTART=0

logg() {
  local rad
  rad="$(date -Is 2>/dev/null) vibesandbox-angra[$$]: $*"
  printf '%s\n' "$rad"                                  # journalen, när systemd kör oss
  printf '%s\n' "$rad" >>"$LOGG" 2>/dev/null || true    # samma logg som provision.sh
}

# En katalog vi litar på: riktig katalog (ingen länk), ägd av root, läge exakt 700.
palitlig_katalog() {
  [[ -d "$1" && ! -L "$1" ]] || return 1
  [[ "$(stat -c '%u %a' -- "$1" 2>/dev/null)" == "0 700" ]]
}

# En ögonblicksbild vi litar på: vanlig fil (ingen länk), ägd av root. (Läget är originalets —
# filen kopierades med 'cp -p' — och katalogen ovanför är den som stänger andra ute.)
palitlig_fil() {
  [[ -f "$1" && ! -L "$1" ]] || return 1
  [[ "$(stat -c '%u' -- "$1" 2>/dev/null)" == "0" ]]
}

# aterstall <ögonblicksbild utan ändelse> <mål>
#   <bild>.fore      ⇒ filen fanns före: lägg tillbaka den, atomiskt (tempfil i samma katalog + mv)
#   <bild>.saknades  ⇒ filen fanns INTE före: ta bort den nya
#   ingetdera        ⇒ avbrottet kom innan filen rördes: låt den vara
aterstall() {
  local bild="$1" mal="$2" ny
  if [[ -e "${bild}.fore" || -L "${bild}.fore" ]]; then
    if ! palitlig_fil "${bild}.fore"; then
      logg "VÄGRAR återställa ${mal}: ${bild}.fore är ingen vanlig rootägd fil"
      return 1
    fi
    ny="$(dirname -- "$mal")/.$(basename -- "$mal").vsb-ny"
    if cp -p -- "${bild}.fore" "$ny" && mv -f -- "$ny" "$mal"; then
      sync -- "$mal" "$(dirname -- "$mal")" 2>/dev/null || true
      logg "återställde ${mal} till läget före"
    else
      rm -f -- "$ny"
      logg "MISSLYCKADES med att återställa ${mal}"
      return 1
    fi
  elif [[ -e "${bild}.saknades" ]]; then
    if rm -f -- "$mal"; then
      logg "tog bort ${mal} (fanns inte före)"
    else
      logg "MISSLYCKADES med att ta bort ${mal}"
      return 1
    fi
  else
    logg "${mal} lämnas orörd (avbrottet kom innan den ändrades)"
  fi
  return 0
}

angra_brandvagg() {
  local k="${BAS}/brandvagg" fel=0
  logg "ÅNGRAR brandvägg"
  aterstall "${k}/nftables.conf" "$NFT_FIL" || fel=1
  # Kärnan rättas ALLTID, även om filen inte gick att återställa: det är den laddade tabellen
  # som stänger ägaren ute just nu. Avgörs av ögonblicksbilden, inte av filen på disk.
  if palitlig_fil "${k}/nftables.conf.fore" && grep -q "^table inet ${NFT_TABELL} {" "${k}/nftables.conf.fore"; then
    # Läget före var en tidigare, BEKRÄFTAD version av vårt regelverk ⇒ ladda den igen.
    if nft -f "${k}/nftables.conf.fore"; then
      logg "laddade det tidigare bekräftade regelverket"
    else
      logg "det tidigare regelverket gick inte att ladda — tar bort tabellen helt (hellre öppet än utelåst; Docker vägrar starta utan tabell)"
      nft delete table inet "$NFT_TABELL" || fel=1
    fi
  elif nft list table inet "$NFT_TABELL" >/dev/null 2>&1; then
    # Läget före var "ingen brandvägg från oss".
    if nft delete table inet "$NFT_TABELL"; then
      logg "tog bort tabellen inet ${NFT_TABELL} ur kärnan"
    else
      logg "MISSLYCKADES med att ta bort tabellen inet ${NFT_TABELL}"
      fel=1
    fi
  else
    logg "tabellen inet ${NFT_TABELL} är inte laddad"
  fi
  return "$fel"
}

ladda_om_sshd() {
  if (( UPPSTART )); then
    # Tidigt i uppstarten får vi inte vänta på ett jobb (låsning mot enheter som väntar på oss).
    # Är sshd inte startad än gör anropet ingenting — den startar då med den återställda filen.
    systemctl --no-block try-reload-or-restart ssh.service 2>/dev/null \
      || systemctl --no-block try-reload-or-restart sshd.service 2>/dev/null || true
    return 0
  fi
  systemctl reload ssh.service 2>/dev/null \
    || systemctl reload sshd.service 2>/dev/null \
    || systemctl try-reload-or-restart ssh.service
}

angra_ssh() {
  local k="${BAS}/ssh" fel=0
  logg "ÅNGRAR SSH-härdning"
  aterstall "${k}/dropin" "$SSH_DROPIN" || fel=1
  aterstall "${k}/sshd_config" "$SSHD_CONFIG" || fel=1
  # 'omladdad' skrivs av provision.sh precis FÖRE omladdningen. Saknas den har sshd aldrig läst
  # den nya konfigurationen, och då finns inget att ladda om.
  if (( UPPSTART )); then
    # Vi körs FÖRE ssh.service: ingen sshd kör än, och den startar med de återställda filerna.
    # ('sshd -t' går inte ens att köra här — /run/sshd skapas först av ssh.service. Prövat med
    # riktig systemd i tung-docker.sh.) Ångrandet är klart när filerna är tillbaka.
    logg "uppstart: sshd har inte startat än — den läser de återställda filerna när den gör det"
  elif [[ -e "${k}/omladdad" ]]; then
    if sshd -t; then
      if ladda_om_sshd; then
        logg "sshd omladdad med den återställda konfigurationen"
      else
        logg "MISSLYCKADES med att ladda om sshd"
        fel=1
      fi
    else
      logg "sshd -t underkänner den ÅTERSTÄLLDA konfigurationen — laddar inte om (sshd kör kvar med den obekräftade)"
      fel=1
    fi
  else
    logg "sshd hade inte laddats om — ingen omladdning behövs"
  fi
  return "$fel"
}

# Den transienta timern behövs inte längre. Namnet kommer ur underlaget ⇒ släpp bara igenom
# exakt den form provision.sh skapar.
stoppa_timer() {
  local k="$1" enhet
  (( UPPSTART )) && return 0
  [[ -f "${k}/timer-enhet" && ! -L "${k}/timer-enhet" ]] || return 0
  enhet="$(head -n1 -- "${k}/timer-enhet" 2>/dev/null)"
  [[ "$enhet" =~ ^vibesandbox-angra-(brandvagg|ssh)-[0-9]+$ ]] || return 0
  systemctl --no-block stop "${enhet}.timer" >/dev/null 2>&1 || true
}

angra_steg() {
  local steg="$1" k="${BAS}/$1" kod=0
  [[ -e "$k" || -L "$k" ]] || return 0
  if ! palitlig_katalog "$k"; then
    logg "VÄGRAR: ${k} är inte en rootägd katalog med läge 700 — underlaget används inte"
    return 2
  fi
  if [[ ! -e "${k}/obekraftad" ]]; then
    logg "${steg}: ingen obekräftad ändring — gör ingenting"
    return 0
  fi
  case "$steg" in
    brandvagg) angra_brandvagg || kod=1 ;;
    ssh) angra_ssh || kod=1 ;;
  esac
  if (( kod != 0 )); then
    logg "${steg}: ångrandet blev INTE fullständigt — markören ligger kvar, nästa utlösare försöker igen"
    return 1
  fi
  # Markören tas bort SIST: dör vi mitt i görs allt om nästa gång (varje delsteg tål det).
  rm -f -- "${k}/obekraftad"
  stoppa_timer "$k"
  rm -rf -- "$k"
  logg "${steg}: ÅNGRAT"
  return 0
}

main() {
  local steg=() a s kod=0 r
  while (( $# > 0 )); do
    a="$1"; shift
    case "$a" in
      --uppstart) UPPSTART=1 ;;
      --alla) steg=("${GILTIGA_STEG[@]}") ;;
      brandvagg | ssh) steg+=("$a") ;;
      *) printf 'Användning: vibesandbox-angra [--uppstart] (--alla | brandvagg | ssh)…\n' >&2; exit 2 ;;
    esac
  done
  (( ${#steg[@]} > 0 )) || { printf 'Användning: vibesandbox-angra [--uppstart] (--alla | brandvagg | ssh)…\n' >&2; exit 2; }
  (( EUID == 0 )) || { printf 'vibesandbox-angra: måste köras som root\n' >&2; exit 2; }

  [[ -e "$BAS" || -L "$BAS" ]] || exit 0                 # inget underlag ⇒ ingenting är obekräftat
  if ! palitlig_katalog "$BAS"; then
    logg "VÄGRAR: ${BAS} är inte en rootägd katalog med läge 700 — underlaget används inte"
    exit 2
  fi

  # Samma lås som provision.sh håller när ett JA tar bort markören ⇒ "bekräftat" och "ångrat"
  # kan aldrig ske samtidigt. Låsfilen ligger i 700-katalogen, inte i en delad /run/lock.
  # '>>' och inte '>': filen ska inte trunkeras (och få ny ändringstid) varje gång den öppnas.
  exec 9>>"${BAS}/.las" || { logg "kan inte öppna låsfilen — fortsätter utan lås"; }
  flock -w 300 9 2>/dev/null || logg "fick inte låset inom 300 s — fortsätter ändå (att ångra är den säkra riktningen)"

  for s in "${steg[@]}"; do
    angra_steg "$s"; r=$?
    (( r > kod )) && kod=$r
  done
  exit "$kod"
}

main "$@"
