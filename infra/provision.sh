#!/usr/bin/env bash
# provision.sh — gör en ny Linux-VPS till driftvärd för vibesandbox.
#
# Idempotent: varje steg läser av läget först och ändrar bara det som avviker.
# Ordningen är ett säkerhetskrav (se infra/README.md):
#   - man får aldrig låsa ute sig  ⇒ Tailscale före brandvägg, brandvägg före SSH-härdning,
#     och båda de riskabla stegen har en "död mans grepp"-bekräftelse som ångrar sig själv —
#     även om det här skriptet dör (se "Ångra-mekanismen" nedan och angra.sh);
#   - Docker får aldrig vara uppe utan brandvägg ⇒ Docker-steget vägrar utan laddad tabell.
#
# Inga hemligheter, adresser eller nycklar hör hemma i den här filen. Icke-hemliga val kommer
# från miljön eller från infra/provision.env (gitignorerad). Tailscale-nyckeln läses ALDRIG
# ur miljön eller från kommandoraden — bara ur en rootägd 600-fil eller dold inmatning.

set -euo pipefail

SKRIPTKATALOG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SKRIPTKATALOG

# ── Konstanter ─────────────────────────────────────────────────────────────────────────────

readonly NFT_TABELL="vibesandbox"
readonly NFT_FIL="/etc/nftables.conf"
readonly TILLSTANDSKATALOG="/etc/vibesandbox"
readonly TILLSTANDSFIL="${TILLSTANDSKATALOG}/provision.state"
readonly NFT_SUMMAFIL="${TILLSTANDSKATALOG}/nft.sha256"
# Filnamnen är valda för att vinna OAVSETT vad en leverantörs avbild redan har lagt dit —
# skriptet letar aldrig efter någon annans filer vid namn:
#   sshd tar FÖRSTA förekomsten av ett direktiv  ⇒ vår dropin ska sorteras först ('0-0-' kommer
#     före både '00-…' och '0-a…' i byteordning);
#   cloud-init och sysctl låter SISTA värdet vinna ⇒ våra filer ska sorteras sist ('zz…').
# Att det verkligen blev så kontrolleras mot det faktiska läget (sshd -T, cloud-inits
# sammanslagning, sysctl -n), och verify.sh larmar om någon annan fil tar platsen.
readonly SSHD_CONFIG="/etc/ssh/sshd_config"
readonly SSH_DROPIN_KATALOG="/etc/ssh/sshd_config.d"
readonly SSH_DROPIN="${SSH_DROPIN_KATALOG}/0-0-vibesandbox.conf"
# Skrivs redan i fas 1 och stänger lösenordsinloggning för driftanvändaren ENBART (ett
# Match-block; det första som träffar vinner ⇒ filen ska sorteras före alla andras, även vår).
readonly SSH_OPS_DROPIN="${SSH_DROPIN_KATALOG}/0-0-0-vibesandbox-ops.conf"
readonly SSH_INCLUDE="Include ${SSH_DROPIN_KATALOG}/*.conf"
# sshd lyssnar på 22 och nås bara via tailnetet. Porten är INTE en inställning: en tidigare
# SSH_PORT skrevs aldrig till sshd, och gick att lista bland de publika portarna.
readonly SSHD_PORT=22

# Ångra-mekanismen (A1–A3). Underlag och markörer ligger i en rootägd 700-katalog; se angra.sh.
#   <katalog>/<steg>/obekraftad   ändringen är gjord men ägaren har inte svarat JA
#   ssh.bekraftad, brandvagg.bekraftad   sha256 över filerna SÅ SOM ÄGAREN BEKRÄFTADE DEM
readonly ANGRA_SKRIPT="/usr/local/sbin/vibesandbox-angra"
readonly ANGRA_ENHET="vibesandbox-angra-uppstart.service"
readonly ANGRA_KATALOG="${TILLSTANDSKATALOG}/angra"
readonly SSH_BEKRAFTAD="${TILLSTANDSKATALOG}/ssh.bekraftad"
# Finns den här filen skrevs ssh.bekraftad med --ingen-bekraftelse: ingen människa har svarat JA.
# Då låses root inte, och nästa körning UTAN flaggan ställer frågan på nytt (B-2).
readonly SSH_OBEVAKAD="${TILLSTANDSKATALOG}/ssh.obevakad"
readonly NFT_BEKRAFTAD="${TILLSTANDSKATALOG}/brandvagg.bekraftad"
# Tidsgränsen för JA-frågan. Går att ändra (BEKRAFTELSE_SEKUNDER, 5–600) — testerna kortar den
# för att pröva tidsgränsen på riktigt. Valideras i las_konfiguration.
BEKRAFTELSE_SEKUNDER="${BEKRAFTELSE_SEKUNDER:-180}"
# Backstoppets timer löper ut en stund EFTER skriptets egen tidsgräns, så att de två inte
# tävlar i normalfallet. (Tävlar de ändå serialiseras de av ett lås, och markören avgör.)
readonly BACKSTOPP_MARGINAL=60
readonly SYSCTL_FIL="/etc/sysctl.d/zz-vibesandbox.conf"
readonly CLOUDINIT_FIL="/etc/cloud/cloud.cfg.d/zzz-vibesandbox.cfg"
readonly LOGGFIL="/var/log/vibesandbox-provision.log"

# Fingeravtryck för paketförrådens signeringsnycklar. En nyckel som inte stämmer ⇒ avbrott.
# Kontrollera mot leverantörens dokumentation vid granskning; går att åsidosätta via miljön
# om en leverantör byter nyckel (det ska då vara ett medvetet, granskat beslut).
DOCKER_NYCKEL_FPR="${DOCKER_NYCKEL_FPR:-9DC858229FC7DD38854AE2D88D81803C0EBFCD88}"
TAILSCALE_NYCKEL_FPR="${TAILSCALE_NYCKEL_FPR:-2596A99EAAB33821893C0A79458CA832957F5868}"

# Stegen i den ordning de körs. De tre första är "fas 1"; resten kräver att ägaren har
# bekräftat att SSH över tailnet fungerar.
readonly STEG_ORDNING=(uppdatering anvandare tailscale brandvagg ssh leverantor dockerdisk gvisor docker system kataloger overvakning)
readonly FAS1=(uppdatering anvandare tailscale)

# ── Flaggor ────────────────────────────────────────────────────────────────────────────────

DRY_RUN=0
BEKRAFTAD_TAILSCALE=0
INGEN_BEKRAFTELSE=0
HOPPA_OVER_SESSIONSKONTROLL=0
VALDA_STEG=()

FIL_ANDRAD=0      # sätts av skriv_fil
ANGRA_STEG=""     # steget som just nu har en OBEKRÄFTAD ändring ⇒ varje väg ut ur skriptet ångrar den
NYCKELFIL=""      # tillfällig fil med Tailscale-nyckeln i /run ⇒ varje väg ut ur skriptet raderar den
TEE_PID=""

anvandning() {
  cat <<'EOF'
Användning: provision.sh [flaggor]

  --dry-run                       Säg vad som skulle göras, ändra ingenting.
  --steg <namn>                   Kör bara ett steg (kan anges flera gånger).
  --lista-steg                    Skriv ut stegen i körordning.
  --bekrafta-tailscale-ssh        Intyga att du har loggat in med SSH över tailnet.
                                  Krävs för brandvägg, SSH-härdning och allt därefter.
  --ingen-bekraftelse             Hoppa över "död mans grepp" (JA-frågan) efter brandvägg
                                  och SSH — då finns heller inget backstopp, och roots
                                  lösenord låses ALDRIG. Bara för testmiljöer: använd den
                                  aldrig mot en riktig server.
  --hoppa-over-sessionskontroll   Kräv varken en pågående SSH-session från tailnet eller
                                  journalens bevis på nyckelinloggning (t.ex. vid körning
                                  från leverantörens webbkonsol). JA-frågan ställs ändå.
  --hjalp                         Den här texten.

Konfiguration läses från miljön och från infra/provision.env (se provision.env.example).
Tailscale-nyckeln läses ur TAILSCALE_AUTHKEY_FILE (rootägd, läge 600) eller med dold inmatning.
Körordning, nödväg och flytt till ny värd: se infra/README.md.
EOF
}

# ── Utskrift ───────────────────────────────────────────────────────────────────────────────

rubrik() { printf '\n==> %s\n' "$*"; }
klart()  { printf '  ✓ %s\n' "$*"; }
gor()    { printf '  → %s\n' "$*"; }
varna()  { printf '  ! %s\n' "$*" >&2; }
avbryt() { printf '\n✗ AVBRUTET: %s\n' "$*" >&2; exit 1; }

# Kör ett kommando som ändrar systemet — eller säg bara vad som skulle ha körts.
kor() {
  if (( DRY_RUN )); then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

har_kommando() { command -v "$1" >/dev/null 2>&1; }

# matchar <grep-flaggor> <mönster> -- <kommando…>
# Som 'kommando | grep -q', men utan kapplöpningen som 'set -o pipefail' annars ger: grep -q
# avslutar vid första träffen, kommandot får SIGPIPE, och pipelinen räknas som misslyckad.
matchar() {
  local flaggor="$1" monster="$2" ut
  shift 3
  ut="$("$@" 2>/dev/null)" || true
  grep "-q${flaggor#-}" -- "$monster" <<<"$ut"
}

i_grupp() { [[ " $(id -nG "$1" 2>/dev/null) " == *" $2 "* ]]; }

tailnet_adress() {
  local a
  a="$(tailscale ip -4 2>/dev/null)" || return 1
  printf '%s' "${a%%$'\n'*}"
}

# ── Hjälpfunktioner ────────────────────────────────────────────────────────────────────────

# skriv_fil <sökväg> <läge> [ägare:grupp] [validerare] — innehållet kommer på stdin.
# Skriver bara om innehållet skiljer sig. Sätter FIL_ANDRAD=1 om filen (skulle ha) ändrats.
#
# ATOMISKT: innehållet skrivs till en dold tempfil i SAMMA katalog och byts in med 'mv'. Ett
# strömavbrott mitt i kan då aldrig lämna en tom eller halv sshd_config, nftables.conf eller
# daemon.json — antingen gäller den gamla filen eller den nya. (Dold ⇒ varken sshd, apt,
# systemd eller cloud-init läser tempfilen; de tar bara *.conf, *.cfg o.s.v.)
# Valideraren, om en anges, får kandidatens sökväg och körs FÖRE bytet: en underkänd kandidat
# ersätter aldrig den fil som gäller.
skriv_fil() {
  local mal="$1" lage="$2" agare="${3:-root:root}" validera="${4:-}" tmp ny nuvarande
  tmp="$(mktemp)"
  cat >"$tmp"
  FIL_ANDRAD=0
  if [[ -f "$mal" ]] && cmp -s "$tmp" "$mal"; then
    rm -f "$tmp"
    nuvarande="$(stat -c '%a %U:%G' "$mal")"
    if [[ "$nuvarande" != "${lage#0} ${agare}" ]]; then
      gor "rättar rättigheter på ${mal} (${nuvarande} → ${lage#0} ${agare})"
      kor chown "$agare" "$mal"
      kor chmod "$lage" "$mal"
    else
      klart "${mal} är redan rätt"
    fi
    return 0
  fi
  FIL_ANDRAD=1
  if (( DRY_RUN )); then
    if [[ -f "$mal" ]]; then
      printf '  [dry-run] skulle skriva om %s\n' "$mal"
    else
      printf '  [dry-run] skulle skapa %s\n' "$mal"
    fi
    rm -f "$tmp"
    return 0
  fi
  if [[ -n "$validera" ]] && ! "$validera" "$tmp"; then
    rm -f "$tmp"
    avbryt "kandidaten till ${mal} underkändes av kontrollen (${validera}) — filen som gäller är ORÖRD."
  fi
  gor "skriver ${mal}"
  ny="$(dirname "$mal")/.$(basename "$mal").vsb-ny"
  install -D -m "$lage" -o "${agare%%:*}" -g "${agare##*:}" "$tmp" "$ny"
  rm -f "$tmp"
  mv -f -- "$ny" "$mal"
}

# lagg_till_rad <fil> <rad> [validerare] — lägger en rad SIST i en fil som andra också äger
# (fstab, subuid, subgid). Tre saker som ett naket 'printf >>' inte gör:
#   - saknar filen avslutande radbrytning läggs en till först, annars smälter vår rad ihop med
#     den sista (i fstab ⇒ nödläge vid nästa omstart; i subuid ⇒ fel ägare till all data);
#   - läget före sparas som <fil>.vibesandbox-fore;
#   - kandidaten byggs vid sidan av, valideras, och byts in atomiskt.
# validera_fstab <kandidat> <nuvarande fil> — en fstab som inte går att tolka ger nödläge vid
# nästa omstart (och då finns bara webbkonsolen). Varningar ([W], t.ex. en källa som inte finns
# än) släpps igenom av findmnt; fel gör det inte.
validera_fstab() {
  local kandidat="$1" nuvarande="${2:-}" ut
  if ut="$(findmnt --verify --tab-file "$kandidat" 2>&1)"; then
    return 0
  fi
  varna "'findmnt --verify' underkänner fstab-kandidaten:"
  printf '%s\n' "$ut" | sed 's/^/      /' >&2
  if [[ -f "$nuvarande" ]] && ! findmnt --verify --tab-file "$nuvarande" >/dev/null 2>&1; then
    varna "…och /etc/fstab underkänns REDAN FÖRE vår ändring. Rätta den först: en fstab med fel ger nödläge vid nästa omstart."
  fi
  return 1
}

lagg_till_rad() {
  local fil="$1" rad="$2" validera="${3:-}" ny
  gor "lägger till i ${fil}: ${rad}"
  (( DRY_RUN )) && return 0
  ny="$(dirname "$fil")/.$(basename "$fil").vsb-ny"
  if [[ -e "$fil" ]]; then
    cp -p -- "$fil" "${fil}.vibesandbox-fore"
    cp -p -- "$fil" "$ny"
    # Kommandosubstitution skalar bort radbrytningar i slutet ⇒ ett x som vaktpost.
    if [[ -s "$ny" && "$(tail -c1 -- "$ny"; printf x)" != $'\nx' ]]; then
      varna "${fil} saknar avslutande radbrytning — lägger till en före vår rad"
      printf '\n' >>"$ny"
    fi
  else
    install -m 0644 -o root -g root /dev/null "$ny"
  fi
  printf '%s\n' "$rad" >>"$ny"
  if [[ -n "$validera" ]] && ! "$validera" "$ny" "$fil"; then
    rm -f -- "$ny"
    avbryt "${fil} är ORÖRD — se ovan."
  fi
  mv -f -- "$ny" "$fil"
}

paket_installerat() {
  [[ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null || true)" == "installed" ]]
}

installera_paket() {
  local saknas=() p
  for p in "$@"; do
    paket_installerat "$p" || saknas+=("$p")
  done
  if (( ${#saknas[@]} == 0 )); then
    klart "paket finns redan: $*"
    return 0
  fi
  gor "installerar paket: ${saknas[*]}"
  kor env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${saknas[@]}"
}

# hamta_nyckel <url> <målfil> <förväntade fingeravtryck, blankstegsseparerade>
# Hämtar en signeringsnyckel och vägrar installera den om primärnycklarnas fingeravtryck
# inte är exakt de förväntade. TLS skyddar transporten; fingeravtrycket skyddar mot att
# förrådets webbplats har tagits över.
hamta_nyckel() {
  local url="$1" mal="$2" forvantat="$3" tmp gnupghome faktiskt
  if [[ -s "$mal" ]]; then
    gnupghome="$(mktemp -d)"
    faktiskt="$(primarnycklar "$mal" "$gnupghome")"
    rm -rf "$gnupghome"
    if [[ "$faktiskt" == "$(sortera_ord "$forvantat")" ]]; then
      klart "nyckeln ${mal} finns och har rätt fingeravtryck"
      return 0
    fi
    varna "nyckeln ${mal} har fel fingeravtryck (${faktiskt}) — hämtar om"
  fi
  if (( DRY_RUN )); then
    printf '  [dry-run] skulle hämta %s och kontrollera fingeravtryck %s\n' "$url" "$forvantat"
    return 0
  fi
  tmp="$(mktemp)"
  gnupghome="$(mktemp -d)"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 "$url" -o "$tmp" \
    || { rm -rf "$tmp" "$gnupghome"; avbryt "kunde inte hämta ${url}"; }
  faktiskt="$(primarnycklar "$tmp" "$gnupghome")"
  rm -rf "$gnupghome"
  if [[ "$faktiskt" != "$(sortera_ord "$forvantat")" ]]; then
    rm -f "$tmp"
    avbryt "nyckeln från ${url} har fingeravtryck '${faktiskt}', förväntade '${forvantat}'. Installerar den INTE."
  fi
  gor "installerar nyckel ${mal} (fingeravtryck kontrollerat)"
  install -D -m 0644 "$tmp" "$mal"
  rm -f "$tmp"
}

sortera_ord() { tr ' ' '\n' <<<"$1" | sed '/^$/d' | sort | tr '\n' ' ' | sed 's/ $//'; }

# Skriver ut fingeravtrycken för alla PRIMÄRnycklar i en nyckelfil, sorterade.
primarnycklar() {
  local fil="$1" hem="$2"
  GNUPGHOME="$hem" gpg --batch --quiet --show-keys --with-colons --with-fingerprint "$fil" 2>/dev/null \
    | awk -F: '$1=="pub"{vanta=1; next} $1=="fpr" && vanta{print $10; vanta=0}' \
    | sort | tr '\n' ' ' | sed 's/ $//'
}

enhet_maskad() { [[ "$(systemctl is-enabled "$1" 2>/dev/null || true)" == masked* ]]; }

# Vissa leverantörers avbilder MASKAR enheter (symlänk till /dev/null): tjänsten ser påslagen
# ut i sin konfiguration men kan aldrig starta, och 'enable' på en maskad enhet misslyckas.
# Varje enhet skriptet är beroende av går därför genom den här kontrollen före 'enable'.
sakerstall_omaskad() {
  local enhet
  for enhet in "$@"; do
    if enhet_maskad "$enhet"; then
      gor "avmaskar ${enhet}"
      kor systemctl unmask "$enhet"
    fi
  done
}

# Allt som är maskat på värden, utan antaganden om namn. Enheter vi inte behöver lämnas
# orörda men redovisas, så att ägaren ser vad avbilden har stängt av.
maskade_enheter() {
  systemctl list-unit-files --state=masked --no-legend --no-pager 2>/dev/null | awk '{print $1}' | tr '\n' ' '
}

# ── Förkontroller och konfiguration ────────────────────────────────────────────────────────

kontrollera_root() {
  (( EUID == 0 )) || avbryt "måste köras som root (sudo ./provision.sh …)."
}

kontrollera_os() {
  # OS_RELEASE_FILE är en testsöm; i drift är det alltid /etc/os-release.
  local fil="${OS_RELEASE_FILE:-/etc/os-release}"
  [[ -r "$fil" ]] || avbryt "hittar inte ${fil} — okänt operativsystem."
  # Läs i ett underskal så att os-release inte skräpar ner skriptets variabler.
  # shellcheck disable=SC1090
  OS_ID="$( (. "$fil"; printf '%s' "${ID:-}") )"
  # shellcheck disable=SC1090
  OS_VERSION="$( (. "$fil"; printf '%s' "${VERSION_ID:-}") )"
  # shellcheck disable=SC1090
  OS_KODNAMN="$( (. "$fil"; printf '%s' "${VERSION_CODENAME:-}") )"
  case "${OS_ID}:${OS_VERSION}" in
    debian:12 | debian:13 | ubuntu:24.04) ;;
    *) avbryt "stöder bara Debian 12/13 och Ubuntu 24.04 — det här är '${OS_ID} ${OS_VERSION}'." ;;
  esac
  [[ -n "$OS_KODNAMN" ]] || avbryt "VERSION_CODENAME saknas i ${fil}."
}

# Tailscale-nyckeln får inte komma via miljön: 'sudo VAR=… ./provision.sh' lägger den i sudos
# argv (synlig i 'ps' och i sudo-loggen), en rad i skalet hamnar i .bash_history, och en
# miljövariabel ärvs av varje barnprocess. Att vägra i efterhand tar inte tillbaka läckan —
# men det hindrar att arbetssättet fastnar, och nyckeln förs aldrig vidare härifrån.
avvisa_nyckel_i_miljon() {
  [[ -n "${TAILSCALE_AUTHKEY:-}" ]] || return 0
  unset TAILSCALE_AUTHKEY
  avbryt "TAILSCALE_AUTHKEY får inte ges via miljön eller provision.env (hamnar i historik, 'ps' och alla barnprocesser).
Betrakta nyckeln som röjd: återkalla den i Tailscales adminkonsol och skapa en ny. Ge den nya på ett av två sätt:
  - svara på frågan när skriptet ber om nyckeln (dold inmatning), eller
  - TAILSCALE_AUTHKEY_FILE=/root/ts.nyckel  (rootägd, läge 600; raderas efter lyckad anslutning)."
}

# En hash som inte är en HEL hash ger en ops utan fungerande lösenord: sudo fungerar inte, och
# när root sedan låses finns ingen root kvar. Formatet kontrolleras därför tecken för tecken.
#   SHA-512:  $6$[rounds=N$]<salt 1–16>$<86 tecken>        yescrypt:  $y$<param>$<salt>$<43 tecken>
kontrollera_losenordshash() {
  [[ -n "$OPS_PASSWORD_HASH" ]] || return 0
  # Mönstren ska stå ORDAGRANT ($ är ett tecken i hashen, inte en variabel).
  # shellcheck disable=SC2016
  local sha512='^\$6\$(rounds=[0-9]{4,9}\$)?[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$'
  # shellcheck disable=SC2016
  local yescrypt='^\$y\$[./0-9A-Za-z]{1,8}\$[./0-9A-Za-z]{1,86}\$[./0-9A-Za-z]{43}$'
  if [[ "$OPS_PASSWORD_HASH" == *EXEMPEL* ]]; then
    avbryt "OPS_PASSWORD_HASH är EXEMPEL-värdet ur provision.env.example. Skapa en riktig hash på din egen dator: openssl passwd -6"
  fi
  if [[ ! "$OPS_PASSWORD_HASH" =~ $sha512 && ! "$OPS_PASSWORD_HASH" =~ $yescrypt ]]; then
    avbryt "OPS_PASSWORD_HASH är ingen hel SHA-512- eller yescrypt-hash (\$6\$<salt>\$<86 tecken> eller \$y\$…\$<43 tecken>).
Avklippt vid kopiering? Dubbla citattecken i stället för enkla (då äter skalet \$-tecknen)? Skapa en ny: openssl passwd -6"
  fi
}

las_konfiguration() {
  local envfil="${PROVISION_ENV:-${SKRIPTKATALOG}/provision.env}"
  avvisa_nyckel_i_miljon
  if [[ -f "$envfil" ]]; then
    # Filen körs som root ⇒ den får varken ägas av eller gå att skriva för någon annan.
    # (Den som äger filen kan ändra dess rättigheter, så skrivbitarna ensamma bevisar inget.)
    local rattigheter agare
    rattigheter="$(stat -c '%a' "$envfil")"
    agare="$(stat -c '%u' "$envfil")"
    if [[ "$agare" != 0 ]]; then
      avbryt "${envfil} ägs inte av root (uid ${agare}) men läses in som kod av root. Kör: chown root:root ${envfil}"
    fi
    if [[ "$rattigheter" =~ [2367]$ || "$rattigheter" =~ [2367].$ ]]; then
      avbryt "${envfil} går att skriva för grupp/andra (${rattigheter}). Kör: chmod 600 ${envfil}"
    fi
    # INTE 'set -a': då exporterades varje rad — även lösenordshashen — till alla barnprocesser.
    # shellcheck disable=SC1090
    . "$envfil"
    avvisa_nyckel_i_miljon
  fi
  # Kom hashen in via miljön är den redan exporterad; ta tillbaka det.
  export -n OPS_PASSWORD_HASH 2>/dev/null || true

  OPS_USER="${OPS_USER:-ops}"
  OPS_SSH_PUBKEY="${OPS_SSH_PUBKEY:-}"
  OPS_SSH_PUBKEY_FILE="${OPS_SSH_PUBKEY_FILE:-}"
  OPS_PASSWORD_HASH="${OPS_PASSWORD_HASH:-}"
  TAILSCALE_AUTHKEY_FILE="${TAILSCALE_AUTHKEY_FILE:-}"
  TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-vibesandbox}"
  TAILSCALE_TAGS="${TAILSCALE_TAGS:-tag:vibesandbox}"
  # '-' och inte ':-': en uttryckligen TOM lista ska betyda "inga portar", inte standardvärdet.
  PUBLIC_TCP_PORTS="${PUBLIC_TCP_PORTS-443}"
  PUBLIC_UDP_PORTS="${PUBLIC_UDP_PORTS-443}"
  OPEN_TAILSCALE_UDP="${OPEN_TAILSCALE_UDP:-0}"
  AUTO_REBOOT="${AUTO_REBOOT:-1}"
  AUTO_REBOOT_TIME="${AUTO_REBOOT_TIME:-04:00}"
  AUTO_UPGRADE_DOCKER="${AUTO_UPGRADE_DOCKER:-1}"
  LOCK_ROOT_PASSWORD="${LOCK_ROOT_PASSWORD:-1}"
  HARDEN_GUEST_AGENT="${HARDEN_GUEST_AGENT:-0}"
  INSTALL_GVISOR="${INSTALL_GVISOR:-0}"
  GVISOR_RELEASE="${GVISOR_RELEASE:-}"
  GVISOR_SHA512="${GVISOR_SHA512:-}"
  DOCKER_XFS_LOOP="${DOCKER_XFS_LOOP:-0}"
  DOCKER_XFS_SIZE_GB="${DOCKER_XFS_SIZE_GB:-20}"
  DOCKER_XFS_IMAGE="${DOCKER_XFS_IMAGE:-/var/lib/vibesandbox-docker.xfs}"
  SWAPFILE_SIZE_GB="${SWAPFILE_SIZE_GB:-2}"
  VM_SWAPPINESS="${VM_SWAPPINESS:-20}"
  PLATFORM_ROOT="${PLATFORM_ROOT:-/srv/vibesandbox}"
  DATA_USER="${DATA_USER:-vibesandbox}"
  DOCKREMAP_SUBID_BASE="${DOCKREMAP_SUBID_BASE:-100000}"
  PLATFORM_CONTAINER_UID="${PLATFORM_CONTAINER_UID:-10001}"

  # SSH_PORT fanns som inställning men nådde aldrig sshd (ingen Port-rad skrevs): brandväggen
  # öppnade då en port som sshd inte lyssnade på. Hellre ingen inställning än en halv.
  if [[ -n "${SSH_PORT:-}" && "${SSH_PORT}" != "$SSHD_PORT" ]]; then
    avbryt "SSH_PORT='${SSH_PORT}' stöds inte längre. sshd lyssnar på ${SSHD_PORT} och nås bara via tailnetet — ta bort raden."
  fi

  local v p
  for v in DOCKER_XFS_SIZE_GB SWAPFILE_SIZE_GB VM_SWAPPINESS DOCKREMAP_SUBID_BASE PLATFORM_CONTAINER_UID BEKRAFTELSE_SEKUNDER; do
    [[ "${!v}" =~ ^[0-9]+$ ]] || avbryt "${v} måste vara ett heltal (är '${!v}')."
  done
  (( 10#$BEKRAFTELSE_SEKUNDER >= 5 && 10#$BEKRAFTELSE_SEKUNDER <= 600 )) \
    || avbryt "BEKRAFTELSE_SEKUNDER måste vara 5–600 (är '${BEKRAFTELSE_SEKUNDER}')."
  BEKRAFTELSE_SEKUNDER=$(( 10#$BEKRAFTELSE_SEKUNDER ))
  readonly BEKRAFTELSE_SEKUNDER
  for v in OPEN_TAILSCALE_UDP AUTO_REBOOT AUTO_UPGRADE_DOCKER LOCK_ROOT_PASSWORD HARDEN_GUEST_AGENT INSTALL_GVISOR DOCKER_XFS_LOOP; do
    [[ "${!v}" =~ ^[01]$ ]] || avbryt "${v} måste vara 0 eller 1 (är '${!v}')."
  done
  for v in PUBLIC_TCP_PORTS PUBLIC_UDP_PORTS; do
    [[ "${!v}" =~ ^([0-9]+( +[0-9]+)*)?$ ]] || avbryt "${v} ska vara portnummer åtskilda av blanksteg (är '${!v}')."
    for p in ${!v}; do
      (( 10#$p >= 1 && 10#$p <= 65535 )) || avbryt "${v}: '${p}' är inget portnummer (1–65535)."
    done
  done
  for p in $PUBLIC_TCP_PORTS; do
    (( 10#$p != SSHD_PORT )) || avbryt "PUBLIC_TCP_PORTS innehåller ${SSHD_PORT}: det öppnar SSH mot hela internet. SSH släpps bara in på tailscale0."
  done
  [[ "$OPS_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || avbryt "OPS_USER '${OPS_USER}' är inget giltigt användarnamn."
  [[ "$OPS_USER" != "root" ]] || avbryt "OPS_USER får inte vara root."
  [[ "$DATA_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || avbryt "DATA_USER '${DATA_USER}' är inget giltigt användarnamn."
  [[ "$AUTO_REBOOT_TIME" =~ ^[0-2][0-9]:[0-5][0-9]$ ]] || avbryt "AUTO_REBOOT_TIME ska vara TT:MM."
  # Sökvägarna hamnar i state-filen (som verify.sh läser in som root varje timme) och i fstab.
  # Bara tråkiga tecken, ingen '..', inte roten.
  for v in PLATFORM_ROOT DOCKER_XFS_IMAGE; do
    [[ "${!v}" =~ ^/[A-Za-z0-9._/-]+$ && "${!v}" != "/" && "/${!v}/" != *"/../"* && "/${!v}/" != *"/./"* ]] \
      || avbryt "${v} måste vara en absolut sökväg med bara A–Z, a–z, 0–9, '.', '_', '-' och '/', utan '..' och inte '/' (är '${!v}')."
  done
  kontrollera_losenordshash
  (( PLATFORM_CONTAINER_UID > 0 && PLATFORM_CONTAINER_UID < 65536 )) \
    || avbryt "PLATFORM_CONTAINER_UID måste ligga i 1–65535 (uid 0 i containern ska inte äga data)."

  # Värdens uid för plattformens data = dockremaps första underordnade uid + uid i containern.
  DATA_UID=$(( DOCKREMAP_SUBID_BASE + PLATFORM_CONTAINER_UID ))
}

# Icke-hemliga val sparas så att verify.sh vet vad som är FÖRVÄNTAT läge (t.ex. om
# gästagenten ska vara härdad). Inga nycklar, hashar eller adresser hamnar här.
#
# Filen läses in som KOD av verify.sh, som root, varje timme. Varje värde är redan validerat
# ovan och skrivs dessutom med %q, så att inget värde kan bli något annat än en tilldelning.
skriv_tillstand() {
  local v innehall
  innehall="$(
    printf '# Skriven av provision.sh — läses av verify.sh. Innehåller inga hemligheter.\n'
    for v in OPS_USER PUBLIC_TCP_PORTS PUBLIC_UDP_PORTS OPEN_TAILSCALE_UDP LOCK_ROOT_PASSWORD \
      HARDEN_GUEST_AGENT INSTALL_GVISOR DOCKER_XFS_LOOP SWAPFILE_SIZE_GB VM_SWAPPINESS \
      PLATFORM_ROOT DATA_USER DATA_UID DOCKREMAP_SUBID_BASE; do
      printf '%s=%q\n' "$v" "${!v}"
    done
  )"
  skriv_fil "$TILLSTANDSFIL" 0644 <<<"$innehall"
}

# ── Spärrar mot utelåsning ─────────────────────────────────────────────────────────────────

tailscale_uppe() {
  har_kommando tailscale && tailscale ip -4 >/dev/null 2>&1
}

# Etablerade SSH-sessioner vars motpart ligger i tailnetet, en per rad: "<adress> <port>".
# Det är ett starkare bevis än en flagga: någon har faktiskt loggat in den vägen.
tailnet_sessioner() {
  local rad peer adress port
  while read -r rad; do
    peer="$(awk '{print $NF}' <<<"$rad")"
    port="${peer##*:}"
    adress="${peer%:*}"; adress="${adress#[}"; adress="${adress%]}"; adress="${adress#::ffff:}"
    if [[ "$adress" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. || "$adress" == fd7a:115c:a1e0:* ]]; then
      printf '%s %s\n' "$adress" "$port"
    fi
  done < <(ss -Htn state established "( sport = :${SSHD_PORT} )" 2>/dev/null || true)
}

# Att en session FINNS visar inte HUR den loggade in. Så länge lösenordsinloggning inte är
# avstängd globalt (det sker först i SSH-steget) kan sessionen vara en lösenordsinloggning — och
# då är nyckeln obevisad när lösenorden stängs av. Beviset är därför raden i sshd:s journal för
# JUST den pågående sessionen: samma användare, samma adress och samma port.
# '_UID=0': raden skrivs av sshd:s privilegierade del; en vanlig användares 'logger -t sshd' räknas inte.
nyckelinloggning_bevisad() {
  local sessioner="$1" journal adress port
  journal="$(journalctl --no-pager -o cat -b -t sshd -t sshd-session _UID=0 2>/dev/null)" || return 2
  while read -r adress port; do
    [[ -n "$adress" ]] || continue
    if grep -qF -- "Accepted publickey for ${OPS_USER} from ${adress} port ${port} " <<<"$journal"; then
      return 0
    fi
  done <<<"$sessioner"
  return 1
}

krav_tailscale_bekraftad() {
  local for_steg="$1"
  if (( DRY_RUN )); then
    (( BEKRAFTAD_TAILSCALE )) || varna "[dry-run] steget '${for_steg}' kräver --bekrafta-tailscale-ssh vid skarp körning"
    return 0
  fi
  (( BEKRAFTAD_TAILSCALE )) || avbryt "steget '${for_steg}' kan låsa ute dig. Logga först in med
  ssh ${OPS_USER}@<serverns tailnet-namn>   (och kontrollera 'sudo -v')
och kör sedan om med --bekrafta-tailscale-ssh."
  tailscale_uppe || avbryt "Tailscale är inte anslutet ('tailscale ip -4' misslyckas). Kör steget 'tailscale' först."
  if (( ! HOPPA_OVER_SESSIONSKONTROLL )); then
    local sessioner kod=0
    sessioner="$(tailnet_sessioner)"
    [[ -n "$sessioner" ]] || avbryt "hittar ingen pågående SSH-session från tailnetet (100.64.0.0/10).
Kör det här steget FRÅN en session över tailnet — då vet vi att vägen in fungerar.
(Från leverantörens webbkonsol: lägg till --hoppa-over-sessionskontroll.)"
    klart "pågående SSH-session från tailnetet hittad"
    nyckelinloggning_bevisad "$sessioner" || kod=$?
    case "$kod" in
      0) klart "sshd:s journal visar en nyckelinloggning som ${OPS_USER} för just den sessionen" ;;
      2) avbryt "kan inte läsa sshd:s journal (journalctl misslyckades). Utan raden 'Accepted publickey for ${OPS_USER} from 100.…'
går det inte att visa att sessionen är en NYCKELinloggning — och det är nyckeln som måste fungera när lösenorden stängs av.
(Från leverantörens webbkonsol: lägg till --hoppa-over-sessionskontroll.)" ;;
      *) avbryt "den pågående tailnet-sessionen är inte en bevisad nyckelinloggning som ${OPS_USER}.
Journalen saknar raden 'Accepted publickey for ${OPS_USER} from <sessionens adress> port <sessionens port>'.
Loggade du in med lösenord, eller som en annan användare? Logga ut, logga in med  ssh ${OPS_USER}@<tailnet-namn>  (nyckel) och kör om.
(Från leverantörens webbkonsol: lägg till --hoppa-over-sessionskontroll.)" ;;
    esac
  fi
}

# ── Ångra-mekanismen: "död mans grepp" som överlever att skriptet dör ───────────────────────
#
# Efter en ändring som kan låsa ute ägaren måste hen svara JA inom en tidsgräns. Varje annan
# utgång ångrar ändringen. Ordningen är hela poängen — allt nedan sker FÖRE ändringen:
#
#   angra_installera   ångra-skriptet + uppstartsenheten på plats och AKTIVERAD
#   angra_kvarglomt    en obekräftad ändring från en avbruten körning ångras först
#   angra_forbered     ögonblicksbild av filerna som ska röras (700-katalog)
#   angra_armera       markören 'obekraftad' skrivs, fällorna gäller, den transienta timern går
#   … ändringen …
#   bekrafta_eller_angra   JA ⇒ angra_bekrafta (markören bort under lås, timern stoppas).
#                          Allt annat ⇒ skriptet avslutas, och vid_avslut kör ångra-skriptet.
#
# Dör skriptet utan att hinna någonting (kill -9, OOM, tappad anslutning) ångrar timern; startar
# värden om ångrar uppstartsenheten. Alla tre vägarna kör SAMMA fristående skript (angra.sh),
# så det finns bara en implementation av själva återställningen att granska.

installera_dokumentation() {
  # Nödvägen ska gå att läsa PÅ servern, från webbkonsolen, när man väl är utelåst.
  [[ -f "${SKRIPTKATALOG}/README.md" ]] || return 0
  skriv_fil /usr/local/share/doc/vibesandbox/README.md 0644 <"${SKRIPTKATALOG}/README.md"
}

angra_installera() {
  [[ -f "${SKRIPTKATALOG}/angra.sh" && -f "${SKRIPTKATALOG}/${ANGRA_ENHET}" ]] \
    || avbryt "hittar inte ${SKRIPTKATALOG}/angra.sh och ${ANGRA_ENHET} — utan dem finns inget backstopp, och då görs ingen ändring."
  skriv_fil "$ANGRA_SKRIPT" 0755 <"${SKRIPTKATALOG}/angra.sh"
  skriv_fil "/etc/systemd/system/${ANGRA_ENHET}" 0644 <"${SKRIPTKATALOG}/${ANGRA_ENHET}"
  if (( FIL_ANDRAD )); then systemctl daemon-reload; fi
  installera_dokumentation
  if [[ "$(systemctl is-enabled "$ANGRA_ENHET" 2>/dev/null || true)" == "enabled" ]]; then
    klart "${ANGRA_ENHET} är aktiverad (ångrar en obekräftad ändring vid omstart)"
  else
    sakerstall_omaskad "$ANGRA_ENHET"
    gor "aktiverar ${ANGRA_ENHET}"
    systemctl enable "$ANGRA_ENHET"
    [[ "$(systemctl is-enabled "$ANGRA_ENHET" 2>/dev/null || true)" == "enabled" ]] \
      || avbryt "${ANGRA_ENHET} gick inte att aktivera — utan den ångras ingenting vid en omstart, och då görs ingen ändring."
  fi
  sakerstall_katalog "$TILLSTANDSKATALOG" 0755 "0:0"
  sakerstall_katalog "$ANGRA_KATALOG" 0700 "0:0"
}

# Kör ångra-skriptet för det armerade steget. Utdata går till loggen (skriptet loggar själv), inte
# till terminalen: den kan vara död, och en utskrift dit får inte vara det som stoppar ångrandet.
angra_nu() {
  local steg="$ANGRA_STEG"
  [[ -n "$steg" ]] || return 0
  ANGRA_STEG=""
  # Kom en signal medan angra_bekrafta höll låset på fd 8, är fd 8 fortfarande öppen och låst.
  # Ärvs den av ångra-skriptet väntar det på sitt eget lås i 300 s (C-1). Klamrar: se stang_terminal.
  { exec 8>&-; } 2>/dev/null || true
  "$ANGRA_SKRIPT" "$steg" >/dev/null 2>&1
}

angra_kvarglomt() {
  local steg="$1" k="${ANGRA_KATALOG}/$1"
  if [[ -e "${k}/obekraftad" ]]; then
    varna "hittar en OBEKRÄFTAD ändring i steget '${steg}' från en avbruten körning — ångrar den först"
    "$ANGRA_SKRIPT" "$steg" >/dev/null 2>&1 \
      || avbryt "den obekräftade ändringen gick inte att ångra — se ${LOGGFIL}. Ingenting nytt har ändrats."
    klart "läget före den avbrutna körningen är återställt"
  fi
  # Ett underlag UTAN markör är förbrukat (bekräftat eller redan ångrat) och får aldrig användas igen.
  rm -rf -- "${ANGRA_KATALOG:?}/${steg}"
}

angra_forbered() {
  install -d -m 0700 -o root -g root "${ANGRA_KATALOG}/$1"
}

# angra_bild <steg> <namn> <fil> — hur såg filen ut FÖRE? Finns den: en kopia. Finns den inte:
# en anteckning om det, så att ångrandet tar bort den nya. (Varken eller ⇒ "rördes aldrig".)
#
# Bilden synkas till disk INNAN markören skrivs (angra_armera kommer efter). Annars kan ett
# strömavbrott lämna markören men en bild på 0 byte (ext4 skjuter upp allokeringen), och då
# kopierade uppstartsenheten en tom fil över nftables.conf eller sshd_config (B-3). angra.sh
# vägrar dessutom en tom eller saknad bild — därför får originalet inte vara tomt.
angra_bild() {
  local k="${ANGRA_KATALOG}/$1" namn="$2" fil="$3"
  if [[ -f "$fil" ]]; then
    [[ -s "$fil" ]] || avbryt "${fil} är TOM. En tom ögonblicksbild går inte att skilja från en som förlorats vid ett strömavbrott, och ångra-skriptet vägrar den. Lägg innehåll i filen (eller ta bort den) och kör om. Ingenting har ändrats."
    cp -p -- "$fil" "${k}/${namn}.fore"
  else
    : >"${k}/${namn}.saknades"
  fi
  sync -- "${k}/${namn}".* "$k" \
    || avbryt "ögonblicksbilden i ${k} gick inte att skriva till disk (sync) — utan den finns inget att ångra till. Ingenting har ändrats."
}

angra_armera() {
  local steg="$1" k="${ANGRA_KATALOG}/$1" enhet
  : >"${k}/obekraftad"
  sync -- "${k}/obekraftad" "$k" 2>/dev/null || true
  ANGRA_STEG="$steg"
  if (( INGEN_BEKRAFTELSE )); then
    varna "--ingen-bekraftelse: inget backstopp armeras och ingen fråga ställs"
    return 0
  fi
  enhet="vibesandbox-angra-${steg}-$(date +%s)"
  printf '%s\n' "$enhet" >"${k}/timer-enhet"
  gor "armerar backstoppet: ${enhet}.timer ångrar om $(( BEKRAFTELSE_SEKUNDER + BACKSTOPP_MARGINAL )) s, vad som än händer med det här skriptet"
  systemd-run --quiet --collect --unit="$enhet" \
    --description="vibesandbox: ångra obekräftad ändring (${steg})" \
    --on-active="$(( BEKRAFTELSE_SEKUNDER + BACKSTOPP_MARGINAL ))s" --timer-property=AccuracySec=1s \
    "$ANGRA_SKRIPT" "$steg" \
    || avbryt "backstoppet gick inte att armera (systemd-run misslyckades). Ingenting har ändrats — utan backstopp görs ingen ändring."
}

# Ägaren har svarat JA. Markören tas bort under SAMMA lås som ångra-skriptet håller, så att
# "bekräftat" och "ångrat" aldrig kan ske samtidigt: hann backstoppet före är markören borta,
# och då gäller ångrandet — inte svaret.
angra_bekrafta() {
  local steg="$1" k="${ANGRA_KATALOG}/$1" enhet=""
  exec 8>>"${ANGRA_KATALOG}/.las"
  flock -w 120 8 || avbryt "fick inte låset ${ANGRA_KATALOG}/.las — ett ångrande pågår. Ändringen ångras."
  if [[ ! -e "${k}/obekraftad" ]]; then
    exec 8>&-
    ANGRA_STEG=""
    avbryt "backstoppet hann före: ändringen i steget '${steg}' var redan ÅNGRAD när svaret kom. Kör steget igen."
  fi
  rm -f -- "${k}/obekraftad"
  exec 8>&-
  ANGRA_STEG=""
  if [[ -f "${k}/timer-enhet" ]]; then
    enhet="$(head -n1 "${k}/timer-enhet")"
    systemctl stop "${enhet}.timer" >/dev/null 2>&1 || true
    if systemctl is-active --quiet "${enhet}.timer" 2>/dev/null; then
      varna "timern ${enhet}.timer gick inte att stoppa. Den är ofarlig (markören är borta ⇒ ångra-skriptet gör ingenting), men kontrollera med: systemctl list-timers"
    fi
  fi
  rm -rf -- "${ANGRA_KATALOG:?}/${steg}"
}

# Öppnar styrterminalen på fd 7. Lyckas bara om det FINNS en terminal (annars ENXIO).
#
# Varför en egen fd och inte 'read … </dev/tty 2>/dev/null': en omdirigering på ett inbyggt
# kommando får bash att spara undan fd 0 och 2 (som fd 10 och 11) medan kommandot kör. Kommer
# Ctrl-C eller SIGTERM MITT I 'read' körs fällan med de sparade kopiorna fortfarande öppna — och
# fd 11 är skrivänden på röret till loggens 'tee'. Då får tee aldrig EOF, avslutet väntar på tee
# för evigt, och skriptet hänger (efter att ha ångrat) medan ett nytt Ctrl-C ignoreras.
oppna_terminal() {
  { exec 7<>/dev/tty; } 2>/dev/null
}
# OBS klamrarna: 'exec 7>&- 2>/dev/null' UTAN klamrar är ett exec utan kommando, och då blir
# ALLA dess omdirigeringar permanenta — fd 2 pekade på /dev/null resten av körningen, och
# "ÅNGRAD"-beskedet och varje senare varning och avbrott försvann (B-1). Här gäller 2>/dev/null
# bara gruppen.
stang_terminal() { { exec 7>&-; } 2>/dev/null || true; }

bekrafta_eller_angra() {
  local steg="$1" fraga="$2" svar=""
  if (( INGEN_BEKRAFTELSE )); then
    angra_bekrafta "$steg"
    return 0
  fi
  trap '' HUP PIPE
  printf '\n  ?? %s\n  ?? Skriv JA inom %s sekunder för att behålla ändringen: ' "$fraga" "$BEKRAFTELSE_SEKUNDER" || true
  if oppna_terminal && read -r -t "$BEKRAFTELSE_SEKUNDER" -u 7 svar && [[ "$svar" == "JA" ]]; then
    stang_terminal
    angra_bekrafta "$steg"
    klart "bekräftat — backstoppet är avbrutet"
    return 0
  fi
  stang_terminal
  # Tidsgräns, annat svar eller ingen/död terminal. ANGRA_STEG är satt ⇒ vid_avslut ångrar.
  exit 1
}

# Varje väg ut ur skriptet går hit (EXIT-fällan; INT/TERM/QUIT avslutar och hamnar därmed här).
# Ångrandet sker FÖRE all utskrift: en utskrift till en död terminal får aldrig komma emellan.
vid_avslut() {
  local kod=$? steg="$ANGRA_STEG"
  trap '' INT TERM QUIT HUP PIPE
  if [[ -n "$steg" ]]; then
    if angra_nu; then
      printf '\n✗ Ingen bekräftelse — ändringen i steget "%s" är ÅNGRAD. Se %s\n' "$steg" "$LOGGFIL" >&2 || true
    else
      printf '\n✗ KRITISKT: ändringen i steget "%s" gick INTE att ångra fullständigt. Ångra-skriptet har larmat\n  (journalen, wall) och armerat en ny timer som försöker igen — men beror felet på något som\n  inte går över av sig självt hjälper bara du. Se %s,\n  "journalctl -p crit -t vibesandbox-angra" och nödvägen i README.\n' "$steg" "$LOGGFIL" >&2 || true
    fi
    (( kod == 0 )) && kod=1
  fi
  if [[ -n "$NYCKELFIL" ]]; then rm -f -- "$NYCKELFIL"; fi
  avsluta_logg
  exit "$kod"
}

# ── Steg 1: uppdatering och automatiska säkerhetsuppdateringar ─────────────────────────────

steg_uppdatering() {
  rubrik "Steg 1 — uppdatera systemet och slå på automatiska säkerhetsuppdateringar"

  gor "apt-get update + full-upgrade"
  kor env DEBIAN_FRONTEND=noninteractive apt-get update -q
  kor env DEBIAN_FRONTEND=noninteractive apt-get -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade

  # tmux: körordningen kräver att fas 2 körs i tmux, så att en tappad anslutning inte dödar
  # skriptet mitt i ett steg med död mans grepp. En ren avbild saknar det.
  installera_paket ca-certificates curl gnupg sudo openssh-server unattended-upgrades \
    apparmor nftables uidmap iproute2 systemd-timesyncd tmux

  # Är de här maskade ser automatiska uppdateringar påslagna ut men kör aldrig.
  local enhet
  sakerstall_omaskad apt-daily.service apt-daily.timer apt-daily-upgrade.service \
    apt-daily-upgrade.timer unattended-upgrades.service ssh.service systemd-timesyncd.service
  local ovriga
  ovriga="$(maskade_enheter)"
  if [[ -z "${ovriga// /}" ]]; then
    klart "inga maskade enheter"
  elif (( DRY_RUN )); then
    klart "maskade enheter på värden just nu: ${ovriga}"
  else
    klart "övriga maskade enheter (behövs inte, lämnas orörda): ${ovriga}"
  fi

  skriv_fil /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

  # Eget filnamn som sorteras efter paketets 50unattended-upgrades: listor i apt-konfig
  # ADDERAS, så paketets fil lämnas orörd och överlever paketuppgraderingar.
  local ursprung omstart="false"
  # ${distro_codename} ska stå ORDAGRANT i apt-filen (apt expanderar den) ⇒ enkla citattecken.
  # shellcheck disable=SC2016
  if [[ "$OS_ID" == "ubuntu" ]]; then
    ursprung='  "origin=Ubuntu,archive=${distro_codename}-security";
  "origin=Ubuntu,archive=${distro_codename}-updates";
  "origin=UbuntuESMApps,archive=${distro_codename}-apps-security";
  "origin=UbuntuESM,archive=${distro_codename}-infra-security";'
  else
    ursprung='  "origin=Debian,codename=${distro_codename},label=Debian";
  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
  "origin=Debian,codename=${distro_codename}-updates";'
  fi
  # Tailscale ska alltid hållas aktuellt. Docker likaså (runc-sårbarheter väger tyngst på en
  # värd som kör opålitlig kod) — men det går att stänga av om en större version måste testas först.
  ursprung+=$'\n  "site=pkgs.tailscale.com";'
  (( AUTO_UPGRADE_DOCKER )) && ursprung+=$'\n  "site=download.docker.com";'
  (( AUTO_REBOOT )) && omstart="true"
  skriv_fil /etc/apt/apt.conf.d/52unattended-upgrades-vibesandbox 0644 <<EOF
// Skriven av vibesandbox provision.sh — ändra i infra/provision.sh, inte här.
Unattended-Upgrade::Origins-Pattern {
${ursprung}
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "${omstart}";
Unattended-Upgrade::Automatic-Reboot-Time "${AUTO_REBOOT_TIME}";
EOF

  for enhet in apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service; do
    if [[ "$(systemctl is-enabled "$enhet" 2>/dev/null || true)" == "enabled" ]] \
      && systemctl is-active --quiet "$enhet" 2>/dev/null; then
      klart "${enhet} är aktiverad och igång"
    else
      gor "aktiverar ${enhet}"
      kor systemctl enable --now "$enhet"
    fi
  done

  # Bevis, inte konfiguration: timrarna ska ha en nästa körning.
  if (( ! DRY_RUN )); then
    systemctl list-timers --all --no-pager apt-daily.timer apt-daily-upgrade.timer 2>/dev/null | sed 's/^/    /' || true
  fi
  if [[ -e /var/run/reboot-required ]]; then
    varna "en omstart krävs för att uppdateringarna ska gälla (t.ex. ny kärna). Starta om innan fas 2."
  fi
}

# ── Steg 2: driftanvändare ─────────────────────────────────────────────────────────────────

ops_nycklar() {
  if [[ -n "$OPS_SSH_PUBKEY_FILE" ]]; then
    [[ -r "$OPS_SSH_PUBKEY_FILE" ]] || avbryt "kan inte läsa OPS_SSH_PUBKEY_FILE (${OPS_SSH_PUBKEY_FILE})."
    grep -Ev '^\s*(#|$)' "$OPS_SSH_PUBKEY_FILE" || true
  elif [[ -n "$OPS_SSH_PUBKEY" ]]; then
    printf '%s\n' "$OPS_SSH_PUBKEY" | grep -Ev '^\s*(#|$)' || true
  fi
}

ops_har_losenord() { [[ "$(passwd -S "$OPS_USER" 2>/dev/null | awk '{print $2}')" == "P" ]]; }

# Är lösenordsinloggning AVSTÄNGD för driftanvändaren i sshd:s effektiva läge?
losenord_stangt_for_ops() {
  local utdata
  utdata="$(sshd -T -C "user=${OPS_USER},host=localhost,addr=203.0.113.10" 2>/dev/null)" || return 1
  grep -qix 'passwordauthentication no' <<<"$utdata" && grep -qix 'kbdinteractiveauthentication no' <<<"$utdata"
}

validera_sshd_fil() { sshd -t -f "$1"; }

# B2: mellan fas 1 och fas 2 står port 22 öppen mot internet med lösenordsinloggning på (det
# stängs globalt först i SSH-steget, bakom JA-frågan). Ett nytt sudo-konto MED lösenord vore då
# ett lösenordsangripbart root-konto, i timmar. Därför: stäng lösenord för just den användaren
# FÖRST — och sätt lösenordet först när 'sshd -T' visar att det verkar.
#
# Ett Match-block gäller till filens slut men inte längre (prövat i testerna med 'sshd -T -C'),
# värden ur ett Match-block går före globala direktiv var de än står, och bland flera Match-block
# vinner det FÖRSTA som träffar ⇒ filen sorteras före alla andra. Den rör ingen annan användare:
# roots väg in är orörd, så det här behöver ingen JA-fråga.
stang_losenord_for_ops() {
  local andrad
  skriv_fil "$SSH_OPS_DROPIN" 0600 root:root validera_sshd_fil <<EOF
# Skriven av vibesandbox provision.sh (steget 'anvandare') — ändra i infra/provision.sh, inte här.
# Stänger lösenordsinloggning över SSH för driftanvändaren redan i fas 1. Lösenordet finns för
# sudo och för leverantörens webbkonsol, aldrig för SSH.
Match User ${OPS_USER}
	PasswordAuthentication no
	KbdInteractiveAuthentication no
EOF
  andrad=$FIL_ANDRAD
  (( DRY_RUN )) && return 0
  if (( andrad )); then
    if ! sshd -t; then
      rm -f -- "$SSH_OPS_DROPIN"
      avbryt "'sshd -t' underkände konfigurationen med ${SSH_OPS_DROPIN} — filen är borttagen, sshd är orörd. Inget lösenord har satts."
    fi
    gor "stänger lösenordsinloggning för ${OPS_USER}: laddar om sshd (befintliga sessioner påverkas inte)"
    ladda_om_sshd
  fi
  if losenord_stangt_for_ops; then
    klart "sshd -T (user=${OPS_USER}): lösenordsinloggning är avstängd"
  else
    rm -f -- "$SSH_OPS_DROPIN"
    ladda_om_sshd || true
    avbryt "lösenordsinloggning för ${OPS_USER} blev INTE avstängd i sshd:s effektiva läge ('sshd -T -C user=${OPS_USER}').
Troligast: ${SSHD_CONFIG} saknar raden '${SSH_INCLUDE}', eller har ett Match-block före den. Lägg Include-raden
FÖRST i filen, kontrollera med 'sshd -t' och kör om. Filen är borttagen igen och INGET lösenord har satts för ${OPS_USER}."
  fi
}

# B5: 'useradd' delar ut underordnade id:n till nya användare — på en färsk Debian 13 får den
# första användaren 100000:65536, alltså exakt dockremaps intervall. Då delar containrarnas
# "root" uid-rymd med en riktig användares namnrymder. Hellre avbrott än en gissning om vems
# rad som ska bort: den som ändras byter ägare på data.
kontrollera_subid_overlapp() {
  local f namn start antal bas="$DOCKREMAP_SUBID_BASE" slut=$(( DOCKREMAP_SUBID_BASE + 65536 ))
  for f in /etc/subuid /etc/subgid; do
    [[ -r "$f" ]] || continue
    while IFS=: read -r namn start antal _ || [[ -n "$namn" ]]; do
      [[ -n "$namn" && "$namn" != \#* && "$namn" != "dockremap" ]] || continue
      [[ "$start" =~ ^[0-9]+$ && "$antal" =~ ^[0-9]+$ ]] || continue
      if (( start < slut && start + antal > bas )); then
        avbryt "${f}: posten '${namn}:${start}:${antal}' överlappar dockremap-intervallet ${bas}–$(( slut - 1 )).
Containrarnas uid:n får inte delas med någon annan. Behöver ${namn} inga underordnade id:n (gäller t.ex. ${OPS_USER}), ta bort dem:
    usermod --del-subuids ${start}-$(( start + antal - 1 )) --del-subgids ${start}-$(( start + antal - 1 )) ${namn}
Annars: flytta ${namn}:s intervall. Ändra INTE DOCKREMAP_SUBID_BASE på en värd som redan har data."
      fi
    done <"$f"
  done
  return 0
}

steg_anvandare() {
  rubrik "Steg 2 — driftanvändaren '${OPS_USER}' (sudo, men INTE docker-gruppen)"

  # Nycklarna kontrolleras INNAN något skapas: ett konto utan fungerande nyckel är just det
  # som låser ute ägaren i fas 2.
  local nycklar hem
  nycklar="$(ops_nycklar)"
  if [[ -n "$nycklar" ]]; then
    local tmp rad
    if grep -q 'EXEMPEL' <<<"$nycklar"; then
      avbryt "den publika nyckeln är EXEMPEL-värdet ur provision.env.example — ingen kan logga in med den. Lägg in din egen (cat ~/.ssh/id_ed25519.pub)."
    fi
    tmp="$(mktemp)"
    while IFS= read -r rad; do
      printf '%s\n' "$rad" >"$tmp"
      ssh-keygen -l -f "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; avbryt "ogiltig publik SSH-nyckel i konfigurationen: ${rad:0:40}…"; }
    done <<<"$nycklar"
    rm -f "$tmp"
  fi

  installera_paket sudo

  if id "$OPS_USER" >/dev/null 2>&1; then
    klart "användaren ${OPS_USER} finns"
  else
    gor "skapar användaren ${OPS_USER} (utan underordnade uid/gid — se kontrollera_subid_overlapp)"
    kor useradd --create-home --shell /bin/bash -K SUB_UID_COUNT=0 -K SUB_GID_COUNT=0 "$OPS_USER"
  fi

  if i_grupp "$OPS_USER" sudo; then
    klart "${OPS_USER} är med i sudo"
  else
    gor "lägger ${OPS_USER} i gruppen sudo"
    kor usermod -aG sudo "$OPS_USER"
  fi

  # Medlemskap i docker-gruppen är detsamma som root utan lösenord och utan spår i sudo-loggen.
  if i_grupp "$OPS_USER" docker; then
    gor "tar bort ${OPS_USER} ur docker-gruppen (docker-gruppen = root)"
    kor gpasswd -d "$OPS_USER" docker
  else
    klart "${OPS_USER} är inte med i docker-gruppen"
  fi

  # Nycklar: konfigurationen är facit. Finns ingen nyckel i konfigurationen rörs filen inte.
  hem="$(getent passwd "$OPS_USER" | cut -d: -f6 || true)"
  hem="${hem:-/home/${OPS_USER}}"
  if [[ -n "$nycklar" ]]; then
    if (( ! DRY_RUN )) || [[ -d "$hem" ]]; then
      kor install -d -m 0700 -o "$OPS_USER" -g "$OPS_USER" "${hem}/.ssh"
    fi
    if (( DRY_RUN )) && ! id "$OPS_USER" >/dev/null 2>&1; then
      printf '  [dry-run] skulle skriva %s/.ssh/authorized_keys\n' "$hem"
    else
      skriv_fil "${hem}/.ssh/authorized_keys" 0600 "${OPS_USER}:${OPS_USER}" <<<"$nycklar"
    fi
  elif [[ -s "${hem}/.ssh/authorized_keys" ]]; then
    klart "ingen nyckel i konfigurationen — behåller befintlig authorized_keys"
  else
    avbryt "ingen publik nyckel för ${OPS_USER}: sätt OPS_SSH_PUBKEY eller OPS_SSH_PUBKEY_FILE."
  fi

  # FÖRE lösenordet: ingen lösenordsinloggning över SSH för den här användaren (B2).
  stang_losenord_for_ops

  # Lösenordet behövs för sudo OCH som nödväg via leverantörens webbkonsol. Formatet är redan
  # kontrollerat i las_konfiguration (kontrollera_losenordshash).
  if [[ -n "$OPS_PASSWORD_HASH" ]]; then
    if [[ "$(getent shadow "$OPS_USER" 2>/dev/null | cut -d: -f2)" == "$OPS_PASSWORD_HASH" ]]; then
      klart "lösenordet för ${OPS_USER} är redan satt"
    else
      gor "sätter lösenord för ${OPS_USER} (från hash)"
      # 'chpasswd -e' tar en färdig hash på STDIN: klartexten finns aldrig på servern, och hashen
      # står aldrig i något argv ('usermod -p <hash>' syns i 'ps'). printf är inbyggt i skalet.
      if (( DRY_RUN )); then
        printf '  [dry-run] chpasswd -e  (hashen på stdin)\n'
      else
        printf '%s:%s\n' "$OPS_USER" "$OPS_PASSWORD_HASH" | chpasswd -e
        if [[ "$(getent shadow "$OPS_USER" | cut -d: -f2)" != "$OPS_PASSWORD_HASH" ]] || ! ops_har_losenord; then
          avbryt "lösenordet för ${OPS_USER} blev inte satt som väntat (kontrollera 'passwd -S ${OPS_USER}')."
        fi
      fi
    fi
  elif ops_har_losenord; then
    klart "${OPS_USER} har ett lösenord"
  else
    varna "${OPS_USER} saknar lösenord ⇒ sudo fungerar inte. Sätt OPS_PASSWORD_HASH eller kör 'passwd ${OPS_USER}'."
    varna "SSH-steget vägrar stänga root-inloggningen tills det är gjort."
  fi

  # Redan nu, i fas 1 — inte först i Docker-steget, mitt i fas 2.
  kontrollera_subid_overlapp
}

# ── Steg 3: Tailscale ──────────────────────────────────────────────────────────────────────

# Varifrån kommer auth-nyckeln? Aldrig från kommandoraden eller miljön (se avvisa_nyckel_i_miljon).
# Skriver sökvägen till en fil som 'tailscale up --auth-key=file:' kan läsa, i variabeln NYCKELKALLA.
NYCKELKALLA=""
hamta_tailscale_nyckel() {
  local f="$TAILSCALE_AUTHKEY_FILE" nyckel=""
  if [[ -n "$f" ]]; then
    # Filen läses av root ⇒ samma krav som på provision.env, och lite till: ingen länk (den som
    # kan byta länkens mål väljer vilken fil root läser), ägd av root, inga rättigheter för andra.
    [[ -f "$f" && ! -L "$f" ]] || avbryt "TAILSCALE_AUTHKEY_FILE (${f}) finns inte eller är ingen vanlig fil (symboliska länkar godtas inte)."
    [[ "$(stat -c '%u' -- "$f")" == 0 ]] || avbryt "TAILSCALE_AUTHKEY_FILE (${f}) ägs inte av root. Kör: chown root:root ${f}"
    [[ "$(stat -c '%a' -- "$f")" =~ ^[46]00$ ]] || avbryt "TAILSCALE_AUTHKEY_FILE (${f}) har läge $(stat -c '%a' -- "$f") — ska vara 600. Kör: chmod 600 ${f}"
    [[ -s "$f" ]] || avbryt "TAILSCALE_AUTHKEY_FILE (${f}) är tom."
    NYCKELKALLA="$f"
    return 0
  fi
  # Dold inmatning från terminalen. 'read' och 'printf' är inbyggda i skalet ⇒ nyckeln står aldrig
  # i någon process argument, och variabeln exporteras inte.
  # Terminalen på en egen fd — se oppna_terminal.
  oppna_terminal || avbryt "inte ansluten till tailnetet, och ingen terminal att fråga efter auth-nyckeln i. Lägg nyckeln i en rootägd 600-fil och sätt TAILSCALE_AUTHKEY_FILE."
  printf '\n  ?? Klistra in Tailscales auth-nyckel (engångsnyckel; visas inte) och tryck Enter: ' >&7
  IFS= read -rs -u 7 nyckel || { stang_terminal; avbryt "fick ingen auth-nyckel."; }
  printf '\n' >&7
  stang_terminal
  [[ "$nyckel" =~ ^tskey-[A-Za-z0-9_-]+$ ]] || { nyckel=""; avbryt "det inmatade ser inte ut som en Tailscale-nyckel (tskey-…)."; }
  # I /run (tmpfs, aldrig på disk), 0600, och NYCKELFIL sätts FÖRE skrivningen så att
  # avslutsfällan raderar filen vad som än händer — även vid Ctrl-C eller SIGTERM mitt i 'tailscale up'.
  NYCKELFIL="$(umask 077; mktemp /run/vibesandbox-ts.XXXXXX)"
  printf '%s' "$nyckel" >"$NYCKELFIL"
  nyckel=""
  NYCKELKALLA="$NYCKELFIL"
}

steg_tailscale() {
  rubrik "Steg 3 — Tailscale (måste fungera INNAN port ${SSHD_PORT} stängs mot internet)"

  installera_paket ca-certificates curl gnupg
  hamta_nyckel "https://pkgs.tailscale.com/stable/${OS_ID}/${OS_KODNAMN}.noarmor.gpg" \
    /usr/share/keyrings/tailscale-archive-keyring.gpg "$TAILSCALE_NYCKEL_FPR"
  skriv_fil /etc/apt/sources.list.d/tailscale.sources 0644 <<EOF
Types: deb
URIs: https://pkgs.tailscale.com/stable/${OS_ID}
Suites: ${OS_KODNAMN}
Components: main
Signed-By: /usr/share/keyrings/tailscale-archive-keyring.gpg
EOF
  if (( FIL_ANDRAD )) || ! paket_installerat tailscale; then
    kor env DEBIAN_FRONTEND=noninteractive apt-get update -q
  fi
  installera_paket tailscale

  if systemctl is-active --quiet tailscaled 2>/dev/null; then
    klart "tailscaled är igång"
  else
    sakerstall_omaskad tailscaled.service
    gor "aktiverar tailscaled"
    kor systemctl enable --now tailscaled
  fi

  if tailscale_uppe; then
    klart "ansluten till tailnetet som $(tailnet_adress)"
  else
    if (( DRY_RUN )); then
      printf '  [dry-run] skulle fråga efter auth-nyckeln (dold inmatning) eller läsa TAILSCALE_AUTHKEY_FILE, och sedan köra:\n'
      printf '  [dry-run] tailscale up --auth-key=file:<fil> --hostname=%s --advertise-tags=%s --ssh=false --accept-routes=false --accept-dns=false\n' \
        "$TAILSCALE_HOSTNAME" "$TAILSCALE_TAGS"
    else
      hamta_tailscale_nyckel
      gor "ansluter till tailnetet som ${TAILSCALE_HOSTNAME} (${TAILSCALE_TAGS})"
      # Nyckeln ges till tailscale som en FIL (file:…): ett kommandoradsargument syns i 'ps'.
      # --ssh=false: vanlig sshd används, inte Tailscale SSH. --accept-routes/dns=false:
      # servern ska inte ta emot vägar eller namnuppslag från tailnetet — den kör opålitlig kod
      # och ska bara vara NÅBAR därifrån. (Tailnetets ACL är det som faktiskt hindrar utgående.)
      tailscale up --auth-key="file:${NYCKELKALLA}" --hostname="$TAILSCALE_HOSTNAME" \
        --advertise-tags="$TAILSCALE_TAGS" --ssh=false --accept-routes=false --accept-dns=false \
        || avbryt "'tailscale up' misslyckades. (Nyckelfilen i /run raderas nu; en fil du själv angav ligger kvar.)"
      if [[ -n "$NYCKELFIL" ]]; then rm -f -- "$NYCKELFIL"; NYCKELFIL=""; fi
      if [[ -n "$TAILSCALE_AUTHKEY_FILE" ]]; then
        # En engångsnyckel är förbrukad efter lyckad anslutning; filen har inget mer att göra på disk.
        rm -f -- "$TAILSCALE_AUTHKEY_FILE"
        klart "nyckelfilen ${TAILSCALE_AUTHKEY_FILE} är raderad (engångsnyckeln är förbrukad)"
      fi
      klart "ansluten som $(tailnet_adress)"
    fi
  fi
}

skriv_fas1_stopp() {
  local adress="<serverns tailnet-adress>"
  tailscale_uppe && adress="$(tailnet_adress)"
  cat <<EOF

════════════════════════════════════════════════════════════════════════════════
 FAS 1 KLAR — skriptet STANNAR här med flit.

 Innan brandväggen stänger port ${SSHD_PORT} mot internet måste DU visa att vägen in via
 tailnetet fungerar — och att NÖDVÄGEN gör det. Tre bevis, alla tre:

   1. Från din egen dator:  ssh ${OPS_USER}@${adress}     (eller MagicDNS-namnet)
      Med NYCKEL. Lösenord över SSH är redan avstängt för ${OPS_USER}; fas 2 kräver att
      sshd:s journal visar 'Accepted publickey for ${OPS_USER}' för just den sessionen.
   2. I den sessionen:      sudo -v                      (lösenordet ska fungera)
   3. I leverantörens WEBBKONSOL: logga in som ${OPS_USER} med lösenordet. Det är den
      vägen du har kvar om allt annat går fel — pröva den NU, inte då.
   4. Kontrollera tailnetets ACL enligt infra/README.md (servern får inte kunna
      initiera trafik mot resten av tailnetet).
   5. Kör fas 2 FRÅN TAILNET-SESSIONEN, i tmux (så att en tappad anslutning inte
      lämnar dig utan terminal att svara JA i):

        tmux new -s fas2
        sudo ./provision.sh --bekrafta-tailscale-ssh

 Behåll den här root-sessionen öppen tills fas 2 är klar. Svara JA först när en NY
 terminal har loggat in. Tryck inte Ctrl-C vid frågan för att "prova igen" — det ångrar
 (med flit), och du får börja om steget.
════════════════════════════════════════════════════════════════════════════════
EOF
}

# ── Steg 4: brandvägg (nftables) + spärrar för containrars utgående trafik ─────────────────

portmangd() { tr -s ' ' <<<"$1" | sed 's/^ //; s/ $//; s/ /, /g'; }

# Hela regelverket. Skrivs till /etc/nftables.conf och laddas atomiskt.
generera_nft() {
  local tcp udp
  tcp="$(portmangd "$PUBLIC_TCP_PORTS")"
  udp="$(portmangd "$PUBLIC_UDP_PORTS")"
  cat <<EOF
#!/usr/sbin/nft -f
# Skriven av vibesandbox provision.sh — ändra i infra/provision.sh, inte här.
#
# VIKTIGT: ingen 'flush ruleset'. Docker och Tailscale lägger sina regler i EGNA tabeller
# (via iptables-nft). En flush här skulle radera dem vid varje omladdning. Vi äger bara
# tabellen 'inet ${NFT_TABELL}' och byter ut den atomiskt (skapa-om-saknas, radera, skapa).
#
# Så samverkar det: i nftables måste ett paket släppas igenom av VARJE baskedja på en krok,
# och ett 'drop' i någon av dem är slutgiltigt. Våra kedjor är därför ett yttre skal:
# 'accept' här betyder bara "gå vidare till Dockers/Tailscales kedjor", 'drop' betyder stopp.

table inet ${NFT_TABELL}
delete table inet ${NFT_TABELL}

table inet ${NFT_TABELL} {
	# Dit containrar aldrig får nå: tailnetet, länklokalt (inkl. moln-metadata 169.254.169.254),
	# privata nät och loopback.
	set sparrade_v4 {
		type ipv4_addr
		flags interval
		elements = { 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
		             172.16.0.0/12, 192.168.0.0/16 }
	}
	set sparrade_v6 {
		type ipv6_addr
		flags interval
		elements = { ::1/128, fc00::/7, fe80::/10 }
	}

	chain input {
		type filter hook input priority filter; policy drop;

		iif "lo" accept
		ct state established,related accept
		ct state invalid drop

		# Containrar får inte nå värdens egna portar (sshd, tailscaled, Docker m.m.).
		# Publicerade portar påverkas inte: de DNAT:as och går via forward-kedjan.
		iifname "docker0" counter drop
		iifname "br-*" counter drop

		icmp type { echo-request, destination-unreachable, time-exceeded, parameter-problem } limit rate 20/second accept
		icmpv6 type { echo-request, destination-unreachable, packet-too-big, time-exceeded, parameter-problem } limit rate 20/second accept
		# Grannupptäckt och routerannonsering: utan dem fungerar inte IPv6 alls.
		icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } ip6 hoplimit 255 accept
		# DHCP-svar — tappad adress = utelåsning.
		udp sport 67 udp dport 68 accept
		ip6 saddr fe80::/10 udp sport 547 udp dport 546 accept
$( [[ -n "$tcp" ]] && printf '\n\t\ttcp dport { %s } accept' "$tcp" )
$( [[ -n "$udp" ]] && printf '\t\tudp dport { %s } accept' "$udp" )

		# SSH ENDAST över tailnetet.
		iifname "tailscale0" tcp dport ${SSHD_PORT} accept
$( (( OPEN_TAILSCALE_UDP )) && printf '\t\t# Direktanslutningar till tailscaled (WireGuard). Valfritt — se README.\n\t\tudp dport 41641 accept' )

		limit rate 6/minute burst 10 packets log prefix "vsb-in-drop: " level info
	}

	chain forward {
		# Prioritet före Dockers kedjor (filter = 0). Motsvarar DOCKER-USER, men är oberoende av
		# att Docker har skapat sin kedja och överlever omstart av Docker.
		type filter hook forward priority filter - 10; policy drop;

		ct state established,related accept
		ct state invalid drop

		iifname "docker0" jump fran_container
		iifname "br-*" jump fran_container

		# Inkommande till en container: bara flöden som Docker har DNAT:at från en port vi
		# uttryckligen har öppnat. En 'ports:' i compose-filen som inte står här blir alltså
		# INTE nåbar från internet.
$( [[ -n "$tcp" ]] && printf '\t\toifname "docker0" ct status dnat meta l4proto tcp ct original proto-dst { %s } accept\n\t\toifname "br-*" ct status dnat meta l4proto tcp ct original proto-dst { %s } accept' "$tcp" "$tcp" )
$( [[ -n "$udp" ]] && printf '\t\toifname "docker0" ct status dnat meta l4proto udp ct original proto-dst { %s } accept\n\t\toifname "br-*" ct status dnat meta l4proto udp ct original proto-dst { %s } accept' "$udp" "$udp" )

		# Allt annat som vill routas genom värden stoppas. Vissa leverantörers avbilder slår på
		# ip_forward och lämnar FORWARD på ACCEPT; Docker sätter då inte DROP själv.
		limit rate 6/minute burst 10 packets log prefix "vsb-fwd-drop: " level info
	}

	chain fran_container {
		# Container till container: Dockers egna isoleringsregler (och icc=false) avgör.
		oifname "docker0" accept
		oifname "br-*" accept

		ip daddr @sparrade_v4 counter drop
		ip6 daddr @sparrade_v6 counter drop
		# Ingen e-post direkt från containrar — utskick går via plattformens e-posttjänst.
		tcp dport { 25, 465, 587 } counter drop

		accept
	}

	chain output {
		type filter hook output priority filter; policy accept;

		# Värden levererar aldrig e-post direkt (port 25). Övrig utgående trafik är öppen
		# tills egress-proxyn med domänlista finns — se TODO i infra/README.md.
		oifname != "lo" tcp dport 25 counter reject with tcp reset
	}
}
EOF
}

nft_tabell_laddad() { nft list table inet "$NFT_TABELL" >/dev/null 2>&1; }

nft_summa() { nft -s list table inet "$NFT_TABELL" 2>/dev/null | sha256sum | awk '{print $1}'; }

# Har ägaren bekräftat JUST den här filen? Markören skrivs först efter ett JA (eller med
# --ingen-bekraftelse, där ägaren har tagit på sig ansvaret) och täcker filens innehåll.
brandvagg_bekraftad() { [[ -s "$NFT_BEKRAFTAD" ]] && sha256sum -c --status "$NFT_BEKRAFTAD" 2>/dev/null; }

steg_brandvagg() {
  rubrik "Steg 4 — brandvägg (nftables): INPUT drop, FORWARD drop, SSH bara på tailscale0"
  krav_tailscale_bekraftad brandvagg

  installera_paket nftables

  # Debians nftables.service kör 'nft flush ruleset' vid stopp/omstart — det skulle radera
  # Dockers och Tailscales regler. Stopp ska inte röra något; omladdning byter bara vår tabell.
  skriv_fil /etc/systemd/system/nftables.service.d/vibesandbox.conf 0644 <<'EOF'
[Service]
ExecStop=
ExecReload=
ExecReload=/usr/sbin/nft -f /etc/nftables.conf
EOF
  (( FIL_ANDRAD )) && kor systemctl daemon-reload

  local ny
  ny="$(mktemp)"
  generera_nft >"$ny"

  if (( DRY_RUN )); then
    if [[ -f "$NFT_FIL" ]] && cmp -s "$ny" "$NFT_FIL" && nft_tabell_laddad; then
      klart "${NFT_FIL} och den laddade tabellen är redan rätt"
    else
      printf '  [dry-run] skulle skriva %s, kontrollera med "nft -c -f" och ladda tabellen inet %s\n' "$NFT_FIL" "$NFT_TABELL"
    fi
    rm -f "$ny"
    return 0
  fi

  # Kandidaten kontrolleras som TEMPFIL, före allt annat.
  nft -c -f "$ny" || { rm -f "$ny"; avbryt "det genererade regelverket går inte igenom 'nft -c' — inget har ändrats."; }

  angra_installera
  angra_kvarglomt brandvagg

  local fil_ratt=0
  if [[ -f "$NFT_FIL" ]] && cmp -s "$ny" "$NFT_FIL"; then fil_ratt=1; fi

  if (( fil_ratt )) && brandvagg_bekraftad && nft_tabell_laddad \
    && [[ "$(nft_summa)" == "$(cat "$NFT_SUMMAFIL" 2>/dev/null || true)" ]]; then
    rm -f "$ny"
    klart "${NFT_FIL} är rätt och bekräftad; tabellen inet ${NFT_TABELL} är laddad och oförändrad"
  else
    # FÖRE ändringen: ögonblicksbild, markör, fällor, backstopp. Fanns en fil före läggs den
    # tillbaka byte för byte (A3); fanns ingen tas den nya bort. Se angra.sh.
    angra_forbered brandvagg
    angra_bild brandvagg nftables.conf "$NFT_FIL"
    angra_armera brandvagg

    if (( fil_ratt )); then
      klart "${NFT_FIL} är redan rätt (men inte bekräftad, eller tabellen avviker)"
    else
      gor "skriver ${NFT_FIL}"
      install -m 0755 -o root -g root "$ny" "$(dirname "$NFT_FIL")/.$(basename "$NFT_FIL").vsb-ny"
      mv -f -- "$(dirname "$NFT_FIL")/.$(basename "$NFT_FIL").vsb-ny" "$NFT_FIL"
    fi
    rm -f "$ny"
    gor "laddar tabellen inet ${NFT_TABELL}"
    nft -f "$NFT_FIL"
    bekrafta_eller_angra brandvagg "Brandväggen är laddad. Öppna en NY terminal och kontrollera att 'ssh ${OPS_USER}@<tailnet-adress>' fungerar."
    # Först NU — efter JA — skrivs markörerna. Avbröts körningen före den här raden finns ingen
    # markör, och nästa körning bekräftar om i stället för att lita på filen.
    local summa
    summa="$(sha256sum "$NFT_FIL")"
    skriv_fil "$NFT_BEKRAFTAD" 0600 <<<"$summa"
    nft_summa >"$NFT_SUMMAFIL"
  fi

  if [[ "$(systemctl is-enabled nftables.service 2>/dev/null || true)" == "enabled" ]]; then
    klart "nftables.service är aktiverad (reglerna laddas vid start, före nätverket)"
  else
    sakerstall_omaskad nftables.service
    gor "aktiverar nftables.service"
    kor systemctl enable nftables.service
  fi
}

# ── Steg 5: SSH ────────────────────────────────────────────────────────────────────────────

# Kontrollerar det EFFEKTIVA läget. sshd tar första förekomsten av ett direktiv, och både
# avbilder och kontrollpaneler lägger egna filer — att läsa vår fil bevisar ingenting.
sshd_effektivt_ratt() {
  local anv utdata fel=0 par nyckel varde
  for anv in root "$OPS_USER"; do
    utdata="$(sshd -T -C "user=${anv},host=localhost,addr=203.0.113.10" 2>/dev/null)" || return 1
    for par in "permitrootlogin no" "passwordauthentication no" "kbdinteractiveauthentication no" \
      "pubkeyauthentication yes" "allowusers ${OPS_USER}" "authorizedkeyscommand none" "allowagentforwarding no" \
      "allowtcpforwarding no" "maxauthtries 3" "x11forwarding no" "permittunnel no"; do
      nyckel="${par%% *}"; varde="${par#* }"
      if ! grep -qix "${nyckel} ${varde}" <<<"$utdata"; then
        varna "sshd -T (user=${anv}): '${nyckel}' är '$(grep -i "^${nyckel} " <<<"$utdata" | cut -d' ' -f2- | tr '\n' ' ')' — förväntade '${varde}'"
        fel=1
      fi
    done
  done
  return "$fel"
}

# Första raden i sshd_config som varken är tom eller kommentar.
sshd_forsta_direktiv() {
  awk '!/^[[:space:]]*(#|$)/ { print; exit }' "$SSHD_CONFIG" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//'
}

# Dropins hjälper bara om Include-raden står FÖRE alla direktiv i sshd_config — annars vinner
# ett direktiv i huvudfilen över vår dropin, hur den än sorteras.
include_ar_forst() {
  local forsta
  forsta="$(sshd_forsta_direktiv)"
  [[ "${forsta,,}" == "${SSH_INCLUDE,,}" ]]
}

# ANDRAS dropins som sorteras FÖRE vår (byteordning, som sshd:s glob). Inga antaganden om deras
# namn. Vår egen fas 1-fil (Match-blocket för driftanvändaren) sorteras före med flit och räknas inte.
dropins_fore_var() {
  local f var egen
  var="$(basename "$SSH_DROPIN")"
  egen="$(basename "$SSH_OPS_DROPIN")"
  (
    LC_ALL=C
    cd "$SSH_DROPIN_KATALOG" 2>/dev/null || exit 0
    for f in *.conf; do
      [[ -e "$f" && "$f" != "$var" && "$f" != "$egen" && "$f" < "$var" ]] && printf '%s ' "$f"
    done
    true
  )
}

# A2: har ägaren bekräftat JUST de här två filerna? Markören skrivs först efter ett JA och
# täcker innehållet i både dropinen och sshd_config. Saknas den, eller har någon av filerna
# ändrats sedan dess, är läget OBEKRÄFTAT — hur rätt 'sshd -T' än ser ut. ('sshd -T' läser
# filer, inte den körande demonen, och säger ingenting om ifall ägaren kommer in.)
ssh_bekraftad() {
  [[ -s "$SSH_BEKRAFTAD" ]] || return 1
  [[ "$(grep -c . "$SSH_BEKRAFTAD")" == 2 ]] || return 1
  grep -qF -- "  ${SSH_DROPIN}" "$SSH_BEKRAFTAD" && grep -qF -- "  ${SSHD_CONFIG}" "$SSH_BEKRAFTAD" || return 1
  sha256sum -c --status "$SSH_BEKRAFTAD" 2>/dev/null
}

ladda_om_sshd() {
  systemctl reload ssh.service 2>/dev/null \
    || systemctl reload sshd.service 2>/dev/null \
    || systemctl try-reload-or-restart ssh.service
}

steg_ssh() {
  rubrik "Steg 5 — SSH: ingen root, inga lösenord, bara '${OPS_USER}'"
  krav_tailscale_bekraftad ssh

  # Stäng inte roots väg in förrän ops bevisligen kan ta över — annars finns ingen root kvar.
  if (( ! DRY_RUN )); then
    id "$OPS_USER" >/dev/null 2>&1 || avbryt "${OPS_USER} finns inte — kör steget 'anvandare' först."
    local hem
    hem="$(getent passwd "$OPS_USER" | cut -d: -f6)"
    [[ -s "${hem}/.ssh/authorized_keys" ]] || avbryt "${OPS_USER} saknar authorized_keys."
    i_grupp "$OPS_USER" sudo || avbryt "${OPS_USER} är inte med i sudo."
    ops_har_losenord || avbryt "${OPS_USER} saknar lösenord ⇒ sudo fungerar inte och ingen kan bli root. Sätt OPS_PASSWORD_HASH eller kör 'passwd ${OPS_USER}'."
  fi

  local innehall
  innehall="$(cat <<EOF
# Skriven av vibesandbox provision.sh — ändra i infra/provision.sh, inte här.
# sshd använder FÖRSTA förekomsten av varje direktiv; därför måste den här filen sorteras
# först i katalogen. Lyssnaradressen begränsas inte här (sshd skulle då vägra starta om
# tailscale0 inte är uppe vid start) — det är brandväggen som stänger port ${SSHD_PORT} mot internet.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
# Ett kommando som avgör vilka nycklar som gäller kan släppa in vem som helst, förbi authorized_keys.
AuthorizedKeysCommand none
AllowUsers ${OPS_USER}
AllowAgentForwarding no
AllowTcpForwarding no
AllowStreamLocalForwarding no
PermitTunnel no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
)"

  local fore
  fore="$(dropins_fore_var)"
  if [[ -n "$fore" ]]; then
    varna "dropins som sorteras FÖRE vår och därför kan vinna över den: ${fore}"
    varna "de lämnas orörda — 'sshd -T' nedan avgör om de faktiskt ändrar något. verify.sh larmar om dem."
  fi

  if (( DRY_RUN )); then
    include_ar_forst || printf '  [dry-run] skulle lägga "%s" först i %s\n' "$SSH_INCLUDE" "$SSHD_CONFIG"
    skriv_fil "$SSH_DROPIN" 0600 <<<"$innehall"
    printf '  [dry-run] skulle validera med "sshd -t", kontrollera "sshd -T" och ladda om sshd\n'
    return 0
  fi

  [[ -f "$SSHD_CONFIG" ]] || avbryt "${SSHD_CONFIG} saknas — det här är ingen sshd-installation skriptet känner igen."
  sakerstall_omaskad ssh.service
  angra_installera
  angra_kvarglomt ssh

  # Tre skäl att göra (om) hela kedjan 'sshd -t' → omladdning → JA-fråga. Det tredje är A2: efter
  # ett avbrott ligger filerna rätt på disk — och det bevisar INGENTING om ifall ägaren kommer in.
  local behov=0 dropin_ratt=0
  include_ar_forst || behov=1
  if [[ -f "$SSH_DROPIN" ]] && [[ "$(cat "$SSH_DROPIN")" == "$innehall" ]]; then dropin_ratt=1; else behov=1; fi
  if ! ssh_bekraftad; then
    if (( ! behov )); then varna "filerna är rätt men har ALDRIG bekräftats av ägaren (avbruten körning, eller ändrade efteråt) — bekräftelsen görs om"; fi
    behov=1
  elif (( ! INGEN_BEKRAFTELSE )) && [[ -e "$SSH_OBEVAKAD" ]]; then
    # B-2: "bekräftelsen" gjordes med --ingen-bekraftelse. Den räknas inte när en människa finns.
    if (( ! behov )); then varna "SSH-läget bekräftades senast med --ingen-bekraftelse — ingen har svarat JA. Frågan ställs nu."; fi
    behov=1
  fi

  if (( ! behov )); then
    klart "${SSHD_CONFIG}: Include-raden står före alla direktiv"
    klart "${SSH_DROPIN} är rätt och bekräftad"
    sshd_effektivt_ratt || avbryt "våra filer är oförändrade men det EFFEKTIVA läget ('sshd -T') är fel. Dropins som sorteras före vår: '${fore:-inga}'. Root-låsningen görs inte förrän detta är rättat."
  else
    # FÖRE ändringen: ögonblicksbild av båda filerna, markör, fällor, backstopp (se angra.sh).
    # Bilderna ligger i 700-katalogen — inte bredvid målen — och förbrukas av ett JA eller ett
    # ångrande; en gammal bild kan alltså aldrig återställas av en senare körning.
    angra_forbered ssh
    angra_bild ssh dropin "$SSH_DROPIN"
    angra_bild ssh sshd_config "$SSHD_CONFIG"
    angra_armera ssh

    if include_ar_forst; then
      klart "${SSHD_CONFIG}: Include-raden står före alla direktiv"
    else
      gor "lägger Include-raden FÖRST i ${SSHD_CONFIG} (första direktivet var: '$(sshd_forsta_direktiv)')"
      local ny_config
      # En Include-rad längre ner kommenteras ut: annars läses varje dropin två gånger, och
      # direktiv som ackumuleras (AllowUsers, AcceptEnv …) dubbleras. Övriga rader rörs inte.
      ny_config="$(
        echo "# vibesandbox provision.sh: Include måste stå före alla direktiv — sshd tar FÖRSTA förekomsten."
        echo "$SSH_INCLUDE"
        echo
        sed -E 's|^([[:space:]]*[Ii][Nn][Cc][Ll][Uu][Dd][Ee][[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf[[:space:]]*)$|# flyttad överst av vibesandbox provision.sh: \1|' \
          "${ANGRA_KATALOG}/ssh/sshd_config.fore"
      )"
      # Atomiskt (tempfil + mv): ett strömavbrott får aldrig lämna en tom sshd_config. Kandidaten
      # kontrolleras med 'sshd -t -f' (den läser då även dropin-katalogen) innan den byts in.
      skriv_fil "$SSHD_CONFIG" 0644 root:root validera_sshd_fil <<<"$ny_config"
    fi

    if (( dropin_ratt )); then
      klart "${SSH_DROPIN} är redan rätt (men inte bekräftad)"
    else
      # Kandidaten kontrolleras som ensam tempfil ('sshd -t -f') innan den byts in.
      skriv_fil "$SSH_DROPIN" 0600 root:root validera_sshd_fil <<<"$innehall"
    fi

    # Helheten — med alla andras dropins på plats — kontrolleras innan sshd får läsa den.
    if ! sshd -t; then
      angra_nu || varna "ångrandet blev inte fullständigt — se ${LOGGFIL}"
      avbryt "'sshd -t' underkände konfigurationen — ändringen är borttagen, sshd är orörd."
    fi
    if ! sshd_effektivt_ratt; then
      angra_nu || varna "ångrandet blev inte fullständigt — se ${LOGGFIL}"
      avbryt "det EFFEKTIVA läget ('sshd -T') blev inte det avsedda. Dropins som sorteras före vår: '${fore:-inga}'. Ändringen är borttagen; flytta eller rätta den filen och kör om."
    fi
    gor "laddar om sshd (befintliga sessioner påverkas inte)"
    # Flaggan skrivs FÖRE omladdningen: finns den vet ångra-skriptet att sshd kan ha läst den
    # nya konfigurationen och måste laddas om igen efter återställningen.
    : >"${ANGRA_KATALOG}/ssh/omladdad"
    ladda_om_sshd
    bekrafta_eller_angra ssh "sshd är omladdad. Öppna en NY terminal: 'ssh ${OPS_USER}@<tailnet-adress>' och sedan 'sudo -v'. Fungerar båda?"
    # Först NU — efter JA — skrivs markören.
    local summor
    summor="$(sha256sum "$SSH_DROPIN" "$SSHD_CONFIG")"
    skriv_fil "$SSH_BEKRAFTAD" 0600 <<<"$summor"
    if (( INGEN_BEKRAFTELSE )); then
      : >"$SSH_OBEVAKAD"
    else
      rm -f -- "$SSH_OBEVAKAD"
    fi
  fi

  klart "sshd -T bekräftar: ingen root, inga lösenord, AllowUsers ${OPS_USER}"

  if (( LOCK_ROOT_PASSWORD )); then
    # Root låses BARA i ett bekräftat läge. Hit når koden inte utan markör — men det som låser
    # den sista vägen in ska inte hänga på att flödet ovan aldrig ändras.
    ssh_bekraftad || avbryt "internt fel: SSH-läget är inte bekräftat — roots lösenord låses INTE."
    if [[ "$(passwd -S root | awk '{print $2}')" == "L" ]]; then
      klart "roots lösenord är låst"
    elif (( INGEN_BEKRAFTELSE )) || [[ -e "$SSH_OBEVAKAD" ]]; then
      # B-2: utan JA-fråga finns inget backstopp och inget bevis på att ops kommer in. Att då låsa
      # roots lösenord vore att stänga den sista vägen in på en gissning.
      varna "roots lösenord låses INTE: med --ingen-bekraftelse har ingen människa bekräftat att 'ssh ${OPS_USER}@…' och 'sudo -v' fungerar.
    Kör  ./provision.sh --steg ssh --bekrafta-tailscale-ssh  UTAN flaggan och svara JA — då låses det."
    else
      # Ett root-lösenord som avbilden eller leverantören har genererat ska ses som förbrukat.
      # Nödvägen via webbkonsolen är ops + sudo.
      gor "låser roots lösenord"
      kor passwd -l root
    fi
  fi
}

# ── Steg 6: kanaler utifrån (cloud-init, qemu-guest-agent) ───────────────────────────

cloudinit_sammanslaget() {
  har_kommando python3 || return 0
  python3 - 2>/dev/null <<'PY' || true
from cloudinit import stages
i = stages.Init()
i.read_cfg()
print(i.cfg.get("ssh_pwauth"), i.cfg.get("disable_root"))
PY
}

steg_leverantor() {
  rubrik "Steg 6 — leverantörens kanaler: cloud-init och gästagenten"

  if [[ -d /etc/cloud/cloud.cfg.d ]]; then
    # Vissa leverantörers avbilder har en cfg-fil med 'ssh_pwauth: true'. cloud-init slår ihop
    # filerna i namnordning och SISTA värdet vinner ⇒ vår fil heter så att den sorteras sist.
    # Andras filer lämnas orörda: de kan skrivas tillbaka, och då ska vår ändå vinna.
    skriv_fil "$CLOUDINIT_FIL" 0644 <<'EOF'
# Skriven av vibesandbox provision.sh.
# En ominitiering (ny instans-id, återställning från en kontrollpanel) får inte slå på
# lösenordsinloggning över SSH eller lägga tillbaka root-inloggning.
ssh_pwauth: false
disable_root: true
EOF
    # Facit är det SAMMANSLAGNA resultatet, så som cloud-init självt läser det — inte vår fil.
    if (( ! DRY_RUN )); then
      local sammanslaget
      sammanslaget="$(cloudinit_sammanslaget)"
      case "$sammanslaget" in
        "False True") klart "cloud-init, sammanslaget: ssh_pwauth=False, disable_root=True" ;;
        "") varna "kunde inte läsa cloud-inits sammanslagna konfiguration (python3/cloudinit saknas?)" ;;
        *)
          varna "cloud-init, sammanslaget: '${sammanslaget}' (ssh_pwauth disable_root) — någon fil vinner över vår:"
          varna "  filer i namnordning: $(LC_ALL=C; cd /etc/cloud/cloud.cfg.d && printf '%s ' *.cfg)"
          ;;
      esac
    fi
    # Begränsning att känna till: user-data från leverantörens seed går FÖRE filerna i cloud.cfg.d.
    # Det sista försvaret är därför alltid sshd-dropinen (sorterad först) och verify.sh.
  else
    klart "cloud-init finns inte på den här värden"
  fi

  local konf=/etc/qemu/qemu-ga.conf
  if ! paket_installerat qemu-guest-agent && ! har_kommando qemu-ga; then
    klart "qemu-guest-agent finns inte på den här värden"
    return 0
  fi
  if (( HARDEN_GUEST_AGENT )); then
    # Äldre qemu-ga (Debian 12) kallar nyckeln 'blacklist'; nyare 'block-rpcs'.
    local nyckel="block-rpcs"
    matchar -F '--block-rpcs' -- qemu-ga --help || nyckel="blacklist"
    skriv_fil "$konf" 0644 <<EOF
# Skriven av vibesandbox provision.sh (HARDEN_GUEST_AGENT=1).
# En kontrollpanel hos leverantören kan annars köra godtyckliga root-skript i gästen via guest-exec.
# Priset: panelfunktioner som lösenordsåterställning och nyckelinläggning slutar fungera.
# Avstängning/omstart och frysning för ögonblicksbilder fungerar fortfarande.
[general]
${nyckel}=guest-exec,guest-exec-status,guest-file-open,guest-file-close,guest-file-read,guest-file-write,guest-file-seek,guest-file-flush,guest-set-user-password,guest-ssh-add-authorized-keys,guest-ssh-remove-authorized-keys,guest-ssh-get-authorized-keys
EOF
    if (( FIL_ANDRAD )); then
      gor "startar om qemu-guest-agent"
      kor systemctl restart qemu-guest-agent.service
    fi
  else
    varna "gästagenten är OBEGRÄNSAD (HARDEN_GUEST_AGENT=0): leverantörskontot är i praktiken root här."
    varna "Det är ett dokumenterat val — skydda kontot med 2FA. verify.sh påminner och bevakar SSH-avdrift."
    if [[ -f "$konf" ]] && grep -q 'vibesandbox provision.sh' "$konf"; then
      gor "tar bort tidigare härdning (${konf})"
      kor rm -f "$konf"
      kor systemctl restart qemu-guest-agent.service
    fi
  fi
}

# ── Steg 7: valfri XFS-volym för Dockers data ──────────────────────────────────────────────

steg_dockerdisk() {
  rubrik "Steg 7 — Dockers data på egen XFS-volym med projektkvot (DOCKER_XFS_LOOP=${DOCKER_XFS_LOOP})"
  if (( ! DOCKER_XFS_LOOP )); then
    klart "avstängt — /var/lib/docker ligger på rotfilsystemet (se avvägningen i README)"
    return 0
  fi

  if [[ "$(findmnt -no FSTYPE /var/lib/docker 2>/dev/null || true)" == "xfs" ]]; then
    klart "/var/lib/docker är redan en XFS-montering ($(findmnt -no OPTIONS /var/lib/docker | tr ',' '\n' | grep -E 'quota' | tr '\n' ' '))"
    return 0
  fi
  if [[ -d /var/lib/docker ]] && [[ -n "$(ls -A /var/lib/docker 2>/dev/null)" ]]; then
    avbryt "/var/lib/docker innehåller redan data. Volymen måste läggas INNAN Docker installeras (eller flytta datat för hand först)."
  fi

  installera_paket xfsprogs

  # "Filen finns" betyder inte "filen är klar": ett avbrott mellan fallocate och mkfs lämnar en
  # fil med rätt namn och storlek men utan filsystem, och då misslyckas monteringen för alltid.
  # Därför byggs avbilden under ett ANNAT namn och får sitt riktiga först när mkfs är klar (mv är
  # atomiskt) — och en fil som redan bär det riktiga namnet kontrolleras ändå med blkid.
  local ofardig="${DOCKER_XFS_IMAGE}.ofardig" typ
  if [[ -e "$DOCKER_XFS_IMAGE" ]]; then
    typ="$(blkid -p -o value -s TYPE "$DOCKER_XFS_IMAGE" 2>/dev/null || true)"
    [[ "$typ" == "xfs" ]] || avbryt "${DOCKER_XFS_IMAGE} finns men är inte ett XFS-filsystem (blkid: '${typ:-inget}').
Troligen ett avbrott mitt i en tidigare körning. Kontrollera att filen inte innehåller något du vill ha kvar, ta bort den och kör om."
    klart "avbildsfilen ${DOCKER_XFS_IMAGE} finns och är ett XFS-filsystem (blkid)"
  else
    if [[ -e "$ofardig" ]]; then
      gor "tar bort en halvfärdig avbild från en avbruten körning (${ofardig})"
      kor rm -f -- "$ofardig"
    fi
    # Kräv marginal: en förallokerad fil som fyller roten vore just det fel vi vill undvika.
    local ledigt_gb
    ledigt_gb="$(df -BG --output=avail "$(dirname "$DOCKER_XFS_IMAGE")" | tail -n1 | tr -dc '0-9')"
    (( ledigt_gb >= DOCKER_XFS_SIZE_GB + 10 )) \
      || avbryt "för lite ledigt utrymme: ${ledigt_gb} GB ledigt, ${DOCKER_XFS_SIZE_GB} GB + 10 GB marginal krävs."
    gor "förallokerar ${DOCKER_XFS_IMAGE} (${DOCKER_XFS_SIZE_GB} GB) och skapar XFS"
    # fallocate reserverar blocken direkt ⇒ volymen kan aldrig 'växa' och fylla roten senare.
    kor fallocate -l "${DOCKER_XFS_SIZE_GB}G" "$ofardig"
    kor chmod 0600 "$ofardig"
    kor mkfs.xfs -q -L vsb-docker "$ofardig"
    kor mv -f -- "$ofardig" "$DOCKER_XFS_IMAGE"
  fi

  # Monteringspunkten ska finnas innan fstab-kandidaten kontrolleras.
  kor install -d -m 0711 /var/lib/docker

  # nofail: en trasig avbild ska inte stoppa uppstarten (⇒ webbkonsol). I stället vägrar
  # docker.service starta om monteringen saknas — se ExecStartPre i Docker-steget.
  local fstabrad="${DOCKER_XFS_IMAGE} /var/lib/docker xfs loop,pquota,nofail,x-systemd.before=docker.service 0 0"
  if grep -qxF "$fstabrad" /etc/fstab 2>/dev/null; then
    klart "fstab-raden finns"
  else
    lagg_till_rad /etc/fstab "$fstabrad" validera_fstab
  fi
  kor systemctl daemon-reload
  gor "monterar /var/lib/docker"
  kor mount /var/lib/docker
}

# ── Steg 9: Docker (körs EFTER gVisor-steget, se STEG_ORDNING) ─────────────────────────────────────────────────────────────────────────

generera_daemon_json() {
  local runtimes=""
  if (( INSTALL_GVISOR )); then
    runtimes=$',\n  "runtimes": {\n    "runsc": { "path": "/usr/local/bin/runsc" }\n  }'
  fi
  cat <<EOF
{
  "userns-remap": "default",
  "no-new-privileges": true,
  "icc": false,
  "live-restore": true,
  "iptables": true,
  "ip6tables": true,
  "ipv6": false,
  "exec-opts": ["native.cgroupdriver=systemd"],
  "storage-driver": "overlay2",
  "features": { "containerd-snapshotter": false },
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "default-ulimits": {
    "nofile": { "Name": "nofile", "Soft": 16384, "Hard": 32768 }
  }${runtimes}
}
EOF
}

# Med dockerd på plats: dess egen kontroll. Före den första installationen finns ingen dockerd —
# då åtminstone att filen är giltig JSON (python3 följer med cloud-init); 'dockerd --validate'
# körs i så fall på den installerade filen direkt efter paketinstallationen (se nedan).
validera_daemon_json() {
  if har_kommando dockerd; then
    dockerd --validate --config-file "$1" >/dev/null 2>&1
  elif har_kommando python3; then
    python3 -m json.tool "$1" >/dev/null 2>&1
  else
    return 0
  fi
}

steg_docker() {
  rubrik "Steg 9 — Docker från Dockers eget förråd, med userns-remap"

  # Docker publicerar portar genom att själv öppna brandväggen. Utan vårt yttre skal (FORWARD
  # drop) står containrarna öppna mot internet ⇒ ingen Docker utan laddad tabell.
  if (( ! DRY_RUN )); then
    nft_tabell_laddad || avbryt "brandväggstabellen 'inet ${NFT_TABELL}' är inte laddad. Kör steget 'brandvagg' först — Docker får aldrig vara uppe utan brandvägg."
    matchar -F 'policy drop' -- nft list chain inet "$NFT_TABELL" forward || avbryt "forward-kedjan har inte policy drop."
  elif ! { har_kommando nft && nft_tabell_laddad; }; then
    varna "[dry-run] brandväggstabellen är inte laddad — vid skarp körning vägrar det här steget"
  fi

  # B5: före allt annat i steget — och läsande, så det görs även i --dry-run.
  kontrollera_subid_overlapp

  installera_paket ca-certificates curl gnupg uidmap

  # dockremap skapas här med FASTA underordnade id:n i stället för att Docker väljer dem.
  # Då blir ägaren till plattformens data (DATA_UID) densamma på varje värd ⇒ en
  # säkerhetskopia går att återställa på en ny värd utan chown.
  if id dockremap >/dev/null 2>&1; then
    klart "användaren dockremap finns"
  else
    gor "skapar systemanvändaren dockremap"
    kor useradd --system --no-create-home --shell /usr/sbin/nologin --user-group dockremap
  fi
  local f rad="dockremap:${DOCKREMAP_SUBID_BASE}:65536"
  for f in /etc/subuid /etc/subgid; do
    if grep -qxF "$rad" "$f" 2>/dev/null; then
      klart "${f}: ${rad}"
    elif grep -q '^dockremap:' "$f" 2>/dev/null; then
      avbryt "${f} har redan en ANNAN rad för dockremap ($(grep '^dockremap:' "$f")). Ändras den byter all containerdata ägare — rätta för hand."
    else
      lagg_till_rad "$f" "$rad"
    fi
  done

  hamta_nyckel "https://download.docker.com/linux/${OS_ID}/gpg" /etc/apt/keyrings/docker.asc "$DOCKER_NYCKEL_FPR"
  skriv_fil /etc/apt/sources.list.d/docker.sources 0644 <<EOF
Types: deb
URIs: https://download.docker.com/linux/${OS_ID}
Suites: ${OS_KODNAMN}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  local forrad_andrat=$FIL_ANDRAD

  # daemon.json skrivs FÖRE installationen: paketets postinst startar demonen, och den ska
  # aldrig — inte ens i några sekunder — köra med standardinställningar. Kandidaten kontrolleras
  # som tempfil innan den byts in (validera_daemon_json), så att en underkänd fil aldrig ersätter
  # den som gäller. (Inläsning i huvudskalet, inte i en pipeline: FIL_ANDRAD måste överleva.)
  local daemon_json
  daemon_json="$(generera_daemon_json)"
  skriv_fil /etc/docker/daemon.json 0644 root:root validera_daemon_json <<<"$daemon_json"
  local daemon_andrad=$FIL_ANDRAD

  # Docker ska inte kunna starta om brandväggen inte laddades vid uppstart (t.ex. efter en
  # felaktig handredigering av nftables.conf), eller om XFS-volymen inte är monterad.
  local forkrav="ExecStartPre=/usr/sbin/nft list table inet ${NFT_TABELL}"
  (( DOCKER_XFS_LOOP )) && forkrav+=$'\nExecStartPre=/usr/bin/findmnt -t xfs /var/lib/docker'
  skriv_fil /etc/systemd/system/docker.service.d/vibesandbox.conf 0644 <<EOF
[Unit]
Wants=nftables.service
After=nftables.service

[Service]
${forkrav}
EOF
  (( FIL_ANDRAD )) && kor systemctl daemon-reload

  if (( forrad_andrat )) || ! paket_installerat docker-ce; then
    kor env DEBIAN_FRONTEND=noninteractive apt-get update -q
  fi
  installera_paket docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  if (( ! DRY_RUN )) && har_kommando dockerd; then
    dockerd --validate --config-file /etc/docker/daemon.json >/dev/null \
      || avbryt "'dockerd --validate' underkände /etc/docker/daemon.json."
    klart "dockerd --validate godkänner daemon.json"
  fi

  if (( daemon_andrad )) && systemctl is-active --quiet docker 2>/dev/null; then
    gor "startar om Docker för att läsa in daemon.json (live-restore håller containrarna igång)"
    kor systemctl restart docker
  fi
  if [[ "$(systemctl is-enabled docker 2>/dev/null || true)" == "enabled" ]] && systemctl is-active --quiet docker 2>/dev/null; then
    klart "docker.service är aktiverad och igång"
  else
    sakerstall_omaskad containerd.service docker.socket docker.service
    gor "aktiverar docker.service"
    kor systemctl enable --now docker
  fi

  # Docker-gruppen ska vara TOM: medlemskap = root.
  local medlemmar
  medlemmar="$(getent group docker | cut -d: -f4 || true)"
  if [[ -n "$medlemmar" ]]; then
    varna "docker-gruppen har medlemmar (${medlemmar}) — tar bort dem"
    local m
    for m in ${medlemmar//,/ }; do kor gpasswd -d "$m" docker; done
  else
    klart "docker-gruppen är tom"
  fi

  if (( ! DRY_RUN )); then
    if matchar -F 'name=userns' -- docker info --format '{{json .SecurityOptions}}'; then
      klart "docker info bekräftar userns-remap"
    else
      varna "docker info visar INTE userns — kontrollera 'journalctl -u docker'"
    fi
  fi
}

# ── Steg 8: gVisor (körs FÖRE Docker-steget, se STEG_ORDNING) ─────────────────────────────────────────────────────────────────────────

steg_gvisor() {
  rubrik "Steg 8 — gVisor/runsc som extra runtime (INSTALL_GVISOR=${INSTALL_GVISOR})"
  if (( ! INSTALL_GVISOR )); then
    klart "avstängt tills spiken om gVisor + userns-remap + byggprestanda är gjord"
    return 0
  fi
  [[ "$GVISOR_RELEASE" =~ ^[0-9]{8}(\.[0-9]+)?$ ]] \
    || avbryt "INSTALL_GVISOR=1 kräver en låst utgåva: GVISOR_RELEASE=ÅÅÅÅMMDD (aldrig 'latest' — körningen ska gå att upprepa)."
  # En binär som körs som root och ska hålla opålitlig kod instängd installeras inte utan en
  # kontrollsumma som ägaren själv har låst. Summan från SAMMA server skyddar mot en trasig
  # hämtning, inte mot en övertagen server — därför finns ingen sådan reserv längre.
  [[ -n "$GVISOR_SHA512" ]] \
    || avbryt "INSTALL_GVISOR=1 kräver GVISOR_SHA512 (128 hex-tecken) i provision.env. Hämta runsc för utgåvan på din egen dator, jämför med gVisors publicerade summa och lås den."
  [[ "$GVISOR_SHA512" =~ ^[0-9a-f]{128}$ ]] || avbryt "GVISOR_SHA512 ska vara 128 hex-tecken (gemener)."
  [[ "$(uname -m)" == "x86_64" ]] || avbryt "gVisor-steget stöder bara x86_64."

  local url="https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/x86_64/runsc"
  local mal=/usr/local/bin/runsc forvantad="$GVISOR_SHA512"

  if [[ -x "$mal" && "$(sha512sum "$mal" | awk '{print $1}')" == "$forvantad" ]]; then
    klart "runsc ${GVISOR_RELEASE} finns med rätt kontrollsumma"
  elif (( DRY_RUN )); then
    printf '  [dry-run] skulle hämta %s, kontrollera SHA-512 och installera %s\n' "$url" "$mal"
  else
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "${tmp}/runsc" "$url" || avbryt "kunde inte hämta ${url}"
    [[ "$(sha512sum "${tmp}/runsc" | awk '{print $1}')" == "$forvantad" ]] \
      || { rm -rf "$tmp"; avbryt "runsc har fel SHA-512 — installerar den INTE."; }
    gor "installerar ${mal} (kontrollsumma kontrollerad)"
    install -m 0755 -o root -g root "${tmp}/runsc" "$mal"
    rm -rf "$tmp"
  fi
  # Binären läggs på plats FÖRE Docker-steget, som registrerar den i daemon.json (samma
  # flagga): dockerd ska aldrig starta med en runtime vars binär saknas.
}

# ── Steg 10: sysctl, swap, LLMNR, tid ──────────────────────────────────────────────────────

# Facit är kärnans FAKTISKA värden (sysctl -n), inte vår fil. Andra filer som sätter samma
# nycklar redovisas — utan antaganden om vad de heter.
kontrollera_sysctl() {
  local rad nyckel varde faktiskt valfri fel=0 andra f
  # shellcheck disable=SC2094  # filen läses bara; grep nedan läser ANDRA filer ($f != $SYSCTL_FIL)
  while IFS= read -r rad; do
    [[ "$rad" =~ ^(-?)([a-z][a-zA-Z0-9_.]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    valfri="${BASH_REMATCH[1]}"; nyckel="${BASH_REMATCH[2]}"; varde="${BASH_REMATCH[3]}"
    faktiskt="$(sysctl -n "$nyckel" 2>/dev/null || true)"
    [[ -z "$faktiskt" && -n "$valfri" ]] && continue      # nyckeln finns inte i den här kärnan
    if [[ "$faktiskt" != "$varde" ]]; then
      varna "sysctl ${nyckel} är '${faktiskt:-saknas}', ska vara '${varde}'"
      fel=1
    fi
    andra=""
    for f in /etc/sysctl.conf /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/local/lib/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf; do
      [[ -f "$f" && "$f" != "$SYSCTL_FIL" ]] || continue
      grep -Eq "^-?${nyckel//./[.]}[[:space:]]*=" "$f" && andra+="$(basename "$f") "
    done
    [[ -n "$andra" ]] && klart "${nyckel} sätts också av: ${andra}— vår fil sorteras sist och vinner"
  done <"$SYSCTL_FIL"
  if (( fel )); then
    varna "alla kärnparametrar fick inte avsett värde — se ovan. verify.sh kommer att larma."
  else
    klart "sysctl -n bekräftar alla värden"
  fi
}

steg_system() {
  rubrik "Steg 10 — kärnparametrar, swapfil, LLMNR av, tidssynk"

  # Sista filen vinner, och 'zz-' sorteras efter alla 'NN-…' ⇒ våra värden gäller även om en
  # leverantörs avbild har egna filer (t.ex. routning påslagen eller rp_filter=0). Andras filer
  # lämnas kvar; de kan skrivas tillbaka, och då ska våra ändå gälla. Se kontrollen nedan.
  skriv_fil "$SYSCTL_FIL" 0644 <<EOF
# Skriven av vibesandbox provision.sh — ändra i infra/provision.sh, inte här.

# Dölj kärnadresser och begränsa ptrace till root: försvårar kärnexploatering från en
# process som har tagit sig ur en container.
kernel.kptr_restrict = 2
kernel.yama.ptrace_scope = 2
kernel.dmesg_restrict = 1
kernel.kexec_load_disabled = 1
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
# Oprivilegierade användarnamnrymder är en återkommande väg till kärnsårbarheter. Docker
# (userns-remap) och runsc skapar sina som root och påverkas inte. Nyckeln finns bara i
# Debians kärna; minustecknet gör att den hoppas över tyst på andra.
-kernel.unprivileged_userns_clone = 0

# Docker behöver ip_forward=1. Det som gör det säkert är brandväggens FORWARD drop.
net.ipv4.ip_forward = 1
# Ingen global IPv6 och inga IPv6-nät i Docker ⇒ ingen IPv6-routning.
net.ipv6.conf.all.forwarding = 0
net.ipv6.conf.default.forwarding = 0
# Vissa avbilder sätter rp_filter=0. 2 (löst läge) tål både Docker och Tailscale.
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.tcp_syncookies = 1

# Vissa avbilder sätter 1, vilket gör att zram-swappen aldrig används.
vm.swappiness = ${VM_SWAPPINESS}
EOF
  if (( FIL_ANDRAD )); then
    gor "läser in sysctl"
    kor sysctl --system --quiet
  fi
  (( DRY_RUN )) || kontrollera_sysctl

  # Diskswap med LÄGRE prioritet än zram (zram-generator använder 100): zram tar det dagliga,
  # disken är bara en buffert så att ett minneshungrigt bygge inte väcker OOM-dödaren direkt.
  if (( SWAPFILE_SIZE_GB > 0 )); then
    if matchar -Fx /swapfile -- swapon --show=NAME --noheadings; then
      klart "swapfilen är aktiv"
    else
      # Samma skäl som för XFS-avbilden: byggs under annat namn, får sitt riktiga först när
      # mkswap är klar, och en fil som redan heter /swapfile kontrolleras med blkid.
      local swaptyp
      if [[ -e /swapfile ]]; then
        swaptyp="$(blkid -p -o value -s TYPE /swapfile 2>/dev/null || true)"
        [[ "$swaptyp" == "swap" ]] || avbryt "/swapfile finns men har inget swap-huvud (blkid: '${swaptyp:-inget}').
Troligen ett avbrott mellan fallocate och mkswap i en tidigare körning. Ta bort filen och kör om."
      else
        if [[ -e /swapfile.ofardig ]]; then
          gor "tar bort en halvfärdig swapfil från en avbruten körning"
          kor rm -f -- /swapfile.ofardig
        fi
        gor "skapar /swapfile (${SWAPFILE_SIZE_GB} GB)"
        kor fallocate -l "${SWAPFILE_SIZE_GB}G" /swapfile.ofardig
        kor chmod 0600 /swapfile.ofardig
        kor mkswap /swapfile.ofardig
        kor mv -f -- /swapfile.ofardig /swapfile
      fi
      gor "aktiverar /swapfile med prioritet 10"
      kor swapon -p 10 /swapfile
    fi
    if grep -qE '^/swapfile\s' /etc/fstab 2>/dev/null; then
      klart "swapfilen finns i fstab"
    else
      lagg_till_rad /etc/fstab '/swapfile none swap sw,pri=10 0 0' validera_fstab
    fi
  else
    klart "ingen swapfil begärd (SWAPFILE_SIZE_GB=0)"
  fi

  # LLMNR lyssnar annars på 0.0.0.0:5355. 'zz-' så att filen vinner över andra dropins.
  skriv_fil /etc/systemd/resolved.conf.d/zz-vibesandbox.conf 0644 <<'EOF'
# Skriven av vibesandbox provision.sh.
[Resolve]
LLMNR=no
MulticastDNS=no
EOF
  if (( FIL_ANDRAD )) && systemctl is-active --quiet systemd-resolved 2>/dev/null; then
    gor "startar om systemd-resolved"
    kor systemctl restart systemd-resolved
  fi

  installera_paket systemd-timesyncd
  if systemctl is-active --quiet systemd-timesyncd 2>/dev/null; then
    klart "systemd-timesyncd är igång"
  else
    sakerstall_omaskad systemd-timesyncd.service
    gor "aktiverar tidssynk"
    kor systemctl enable --now systemd-timesyncd
  fi
}

# ── Steg 11: kataloger ─────────────────────────────────────────────────────────────────────

sakerstall_katalog() {
  local katalog="$1" lage="$2" agare="$3" nuvarande
  if [[ -d "$katalog" ]]; then
    nuvarande="$(stat -c '%a %u:%g' "$katalog")"
    if [[ "$nuvarande" == "${lage#0} ${agare}" ]]; then
      klart "${katalog} (${lage} ${agare})"
      return 0
    fi
  fi
  gor "${katalog} → ${lage} ${agare}"
  kor install -d -m "$lage" -o "${agare%%:*}" -g "${agare##*:}" "$katalog"
}

steg_kataloger() {
  rubrik "Steg 11 — katalogstruktur under ${PLATFORM_ROOT}"

  # Med userns-remap blir uid N i en container uid (bas + N) på värden. Plattformen ska köra
  # som uid ${PLATFORM_CONTAINER_UID} i sin container ('user:' i compose) ⇒ dess data ägs av
  # ${DATA_UID} på värden. Systemanvändaren finns för att ge det numret ett NAMN (ls, backup)
  # och för att inget annat ska råka få samma uid. Den har inget skal och inget lösenord.
  if id "$DATA_USER" >/dev/null 2>&1; then
    [[ "$(id -u "$DATA_USER")" == "$DATA_UID" ]] \
      || avbryt "${DATA_USER} finns men har uid $(id -u "$DATA_USER"), förväntade ${DATA_UID}."
    klart "systemanvändaren ${DATA_USER} finns (uid ${DATA_UID})"
  else
    if getent passwd "$DATA_UID" >/dev/null 2>&1; then
      avbryt "uid ${DATA_UID} är redan upptaget av $(getent passwd "$DATA_UID" | cut -d: -f1)."
    fi
    gor "skapar systemanvändaren ${DATA_USER} (uid/gid ${DATA_UID})"
    kor groupadd --gid "$DATA_UID" "$DATA_USER"
    kor useradd --uid "$DATA_UID" --gid "$DATA_UID" --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin "$DATA_USER"
  fi

  sakerstall_katalog "$PLATFORM_ROOT" 0755 "0:0"
  # compose/ rymmer .env med hemligheter; backups/ rymmer allas data ⇒ bara root.
  sakerstall_katalog "${PLATFORM_ROOT}/compose" 0750 "0:0"
  sakerstall_katalog "${PLATFORM_ROOT}/data" 0750 "${DATA_UID}:${DATA_UID}"
  sakerstall_katalog "${PLATFORM_ROOT}/backups" 0700 "0:0"
}

# ── Steg 12: avdriftskontroll ──────────────────────────────────────────────────────────────

steg_overvakning() {
  rubrik "Steg 12 — avdriftskontroll: verify.sh som timer"

  [[ -f "${SKRIPTKATALOG}/verify.sh" ]] || avbryt "hittar inte ${SKRIPTKATALOG}/verify.sh."
  skriv_fil /usr/local/sbin/vibesandbox-verify 0755 <"${SKRIPTKATALOG}/verify.sh"
  installera_dokumentation

  skriv_fil /etc/systemd/system/vibesandbox-verify.service 0644 <<'EOF'
[Unit]
Description=vibesandbox: kontrollera att värdens härdning inte har drivit
Documentation=file:/usr/local/share/doc/vibesandbox/README.md

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/vibesandbox-verify --tyst
EOF
  local enhet_andrad=$FIL_ANDRAD
  skriv_fil /etc/systemd/system/vibesandbox-verify.timer 0644 <<'EOF'
[Unit]
Description=vibesandbox: avdriftskontroll varje timme

[Timer]
OnCalendar=hourly
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  if (( enhet_andrad || FIL_ANDRAD )); then
    kor systemctl daemon-reload
  fi
  if [[ "$(systemctl is-enabled vibesandbox-verify.timer 2>/dev/null || true)" == "enabled" ]]; then
    klart "vibesandbox-verify.timer är aktiverad"
  else
    gor "aktiverar vibesandbox-verify.timer"
    kor systemctl enable --now vibesandbox-verify.timer
  fi
  klart "avvikelser syns med: systemctl status vibesandbox-verify  /  journalctl -u vibesandbox-verify"
}

# ── Huvudprogram ───────────────────────────────────────────────────────────────────────────

kor_steg() {
  case "$1" in
    uppdatering) steg_uppdatering ;;
    anvandare) steg_anvandare ;;
    tailscale) steg_tailscale ;;
    brandvagg) steg_brandvagg ;;
    ssh) steg_ssh ;;
    leverantor) steg_leverantor ;;
    dockerdisk) steg_dockerdisk ;;
    docker) steg_docker ;;
    gvisor) steg_gvisor ;;
    system) steg_system ;;
    kataloger) steg_kataloger ;;
    overvakning) steg_overvakning ;;
    *) avbryt "okänt steg '$1'. Giltiga: ${STEG_ORDNING[*]}" ;;
  esac
}

starta_logg() {
  (( DRY_RUN )) && return 0
  # Körningen loggas till fil: dör SSH-sessionen mitt i ett steg ska det gå att se var.
  # SIGHUP ignoreras av samma skäl — ett halvkört steg är värre än ett färdigkört.
  trap '' HUP
  touch "$LOGGFIL" && chmod 0600 "$LOGGFIL"
  printf '\n──── provision.sh %s %s ────\n' "$(date -Is)" "$*" >>"$LOGGFIL"
  exec > >(tee -a -i --output-error=warn "$LOGGFIL") 2>&1
  TEE_PID=$!
}

# Stäng vår ände av röret och låt tee skriva klart — men vänta aldrig obegränsat: finns en
# kopia av skrivänden kvar någonstans (se oppna_terminal) får tee aldrig EOF, och ett avslut
# som hänger är värre än en logg som saknar sista raden. Tee avslutas ändå när vi gör det.
avsluta_logg() {
  local i
  if [[ -n "$TEE_PID" ]]; then
    exec >&- 2>&- || true
    for (( i = 0; i < 50; i++ )); do
      kill -0 "$TEE_PID" 2>/dev/null || return 0
      sleep 0.1
    done
  fi
}

main() {
  local flaggor="$*"
  while (( $# > 0 )); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --steg)
        [[ $# -ge 2 ]] || avbryt "--steg kräver ett namn."
        VALDA_STEG+=("$2"); shift ;;
      --steg=*) VALDA_STEG+=("${1#--steg=}") ;;
      --lista-steg) printf '%s\n' "${STEG_ORDNING[@]}"; exit 0 ;;
      --bekrafta-tailscale-ssh) BEKRAFTAD_TAILSCALE=1 ;;
      --ingen-bekraftelse) INGEN_BEKRAFTELSE=1 ;;
      --hoppa-over-sessionskontroll) HOPPA_OVER_SESSIONSKONTROLL=1 ;;
      --hjalp | --help | -h) anvandning; exit 0 ;;
      *) anvandning >&2; avbryt "okänd flagga '$1'." ;;
    esac
    shift
  done

  # Varje väg ut går genom vid_avslut: en obekräftad ändring ångras, nyckelfilen i /run raderas.
  # INT/TERM/QUIT gör inget eget — de avslutar, och avslutet är det som städar. (SIGKILL går inte
  # att fånga; det är därför backstoppet finns. SIGHUP ignoreras av starta_logg.)
  trap vid_avslut EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 131' QUIT

  kontrollera_root
  kontrollera_os
  las_konfiguration

  local s
  for s in "${VALDA_STEG[@]}"; do
    [[ " ${STEG_ORDNING[*]} " == *" ${s} "* ]] || avbryt "okänt steg '${s}'. Giltiga: ${STEG_ORDNING[*]}"
  done

  starta_logg "$flaggor"

  if (( DRY_RUN )); then
    rubrik "DRY-RUN — ingenting ändras. ${OS_ID} ${OS_VERSION} (${OS_KODNAMN})"
  else
    rubrik "vibesandbox provision — ${OS_ID} ${OS_VERSION} (${OS_KODNAMN})"
    skriv_tillstand
  fi

  if (( ${#VALDA_STEG[@]} > 0 )); then
    for s in "${VALDA_STEG[@]}"; do kor_steg "$s"; done
    rubrik "Klart: ${VALDA_STEG[*]}"
    return 0
  fi

  for s in "${FAS1[@]}"; do kor_steg "$s"; done

  if (( ! BEKRAFTAD_TAILSCALE && ! DRY_RUN )); then
    skriv_fas1_stopp
    return 0
  fi

  for s in "${STEG_ORDNING[@]}"; do
    [[ " ${FAS1[*]} " == *" ${s} "* ]] && continue
    kor_steg "$s"
  done

  rubrik "Klart. Kontrollera läget med: sudo /usr/local/sbin/vibesandbox-verify"
}

main "$@"
