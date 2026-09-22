#!/usr/bin/env bash
# hamta-backup.sh — hämtar driftvärdens krypterade säkerhetskopior till NAS:en.
#
# DET HÄR SKRIPTET KÖRS PÅ NAS:EN, ALDRIG PÅ DRIFTVÄRDEN. Det är inte en detalj utan hela
# konstruktionen: tailnet-ACL:en tillåter inte värden att initiera trafik in i tailnetet, så
# att en övertagen driftvärd inte ska kunna nå NAS:en och radera eller läsa historiken. Därför
# HÄMTAR NAS:en (NAS → värd). Den som gör om det här till en push från värden — rsync eller
# scp i värdens cron — river den spärren och gör NAS:en anträffbar från precis den maskin som
# säkerhetskopiorna finns till för att överleva. GÖR INTE DET.
#
#   hamta-backup.sh [--vard N] [--anvandare N] [--mal KATALOG] [--behall N] [--dry-run]
#   hamta-backup.sh --prov [--kopia NAMN] --privat-nyckel FIL
#
# Vad som händer vid en hämtning:
#
#   1. 'ssh ops@<vard> sudo -n /usr/local/sbin/vibesandbox-backup --lista' säger vilka
#      säkerhetskopior som har ett krypterat arkiv, med sha256 och storlek UR MANIFESTET.
#   2. Bara de vi inte redan har hämtas. En hämtad kopia räknas som hämtad först när filen
#      'hamtad' ligger i den — en katalog utan den är en avbruten hämtning, inte en kopia.
#   3. Varje hämtning landar i .ofullstandig och byter namn FÖRST när sha256 och storlek
#      stämmer, mot både --lista och det hämtade manifestet. Samma mönster som backup.sh
#      använder på värden, och av samma skäl: en halv kopia får aldrig se hel ut.
#   4. Egen rotation här — NAS:en får behålla fler generationer än värden har plats för.
#
# Vad NAS:en INTE kan läsa: arkivet är krypterat till en publik nyckel som värden inte har den
# privata halvan av. Inte heller NAS:en läser det av misstag — det krävs --prov och den privata
# nyckeln (Bitwarden: "vibesandbox backup"). Det är själva poängen: nyckeln ligger aldrig där
# kopian ligger.
#
# --prov är beviset på att kedjan går hela vägen. En krypterad kopia som ingen kan dekryptera
# är exakt lika mycket värd som ingen kopia alls, och det märks först den dag den behövs.
#
# SYNOLOGY-ANTAGANDEN (DSM 7, begränsat skal och delvis gamla verktyg). Skriptet använder bara
# bash 4.x, ssh, tar, awk, grep, sort, find, mktemp, sha256sum, wc och date. Det antar INTE:
#   • GNU-finesser: inget 'find -printf', inget 'stat -c', inget 'mapfile', inget 'readlink -f'
#     och inga GNU-specifika flaggor till tar — DSM:s verktyg är delvis busybox.
#   • root: skriptet behöver bara kunna skriva i målkatalogen.
#   • rsync: den finns på DSM, men duger inte här. Källan ligger i en 0700-katalog som bara
#     root på värden kan läsa, och den enda vägen dit är den sudo-rad ops har för
#     vibesandbox-backup. En sudoers-rad för rsync hade betytt läsning av hela värden som root.
#   • gpg: finns INTE på ett oförändrat DSM. Hämtningen klarar sig utan den. Bara --prov kräver
#     den, och säger det rakt ut i stället för att gå sönder (Entware: 'opkg install gnupg').
# scp:s '-O' hör till macOS→DSM. Här är DSM klienten och vi använder inte scp alls.

set -euo pipefail
# /opt/bin först: det är där Entware lägger gpg på en Synology. Resten är DSM:s vanliga vägar.
export PATH=/opt/bin:/opt/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
# Allt vi skriver är antingen ett krypterat arkiv eller — under --prov — driftens hemligheter
# i klartext. 0700/0600 från början i stället för rättat efteråt.
umask 077

# Samma namnmönster som backup.sh. Det är det enda rotationen rör, så en katalog någon har lagt
# hit för hand (eller vår egen .ofullstandig) tas aldrig bort.
readonly KATALOGMONSTER='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z(-[0-9]+)?$'
readonly ARKIV='arkiv.tar.gpg'
readonly FJARRSKRIPT='/usr/local/sbin/vibesandbox-backup'

VARD="${VIBESANDBOX_VARD:-vibesandbox}"
ANVANDARE="${VIBESANDBOX_OPS:-ops}"
MAL="${VIBESANDBOX_BACKUPMAL:-/volume1/NetBackup/vibesandbox}"
BEHALL="${BEHALL_HAMTADE:-14}"
PRIVNYCKEL="${VIBESANDBOX_BACKUP_PRIVNYCKEL:-}"
PASSFRASFIL="${VIBESANDBOX_BACKUP_PASSFRAS_FIL:-}"
DRY_RUN=0
LAGE=hamta
# Kuma-pulsen. En push-monitor som INTE får sin puls slår larm av sig själv efter sin tidsgräns —
# därför pulsar vi bara när hämtningen HELT gick igenom. Tystnad är signalen, och tystnad är det
# enda som också fungerar när värden är helt borta eller när den här maskinen inte kör.
PULS="${VIBESANDBOX_PULS:-}"
KOPIA=""

# ── Utskrift ───────────────────────────────────────────────────────────────────────────────
# Samma språk som backup.sh: ==> steg, → gör, ✓ klart, ! varning, ✗ avbrott.

rubrik() { printf '\n==> %s\n' "$*"; }
klart()  { printf '  ✓ %s\n' "$*"; }
gor()    { printf '  → %s\n' "$*"; }
varna()  { printf '  ! %s\n' "$*" >&2; }
avbryt() { printf '\n✗ AVBRUTET: %s\n' "$*" >&2; exit 1; }
vagra()  { printf '\n✗ VÄGRAR: %s\n' "$*" >&2; exit 2; }

har_kommando() { command -v "$1" >/dev/null 2>&1; }

anvandning() {
  cat <<'EOF'
Användning: hamta-backup.sh [flaggor]

  --vard <namn>        Driftvärden så som den heter i tailnetet (standard: vibesandbox).
  --anvandare <namn>   SSH-användare på värden (standard: ops).
  --mal <katalog>      Dit kopiorna hämtas (standard: /volume1/NetBackup/vibesandbox).
                       Katalogen måste finnas — skriptet skapar den inte.
  --behall <N>         Behåll de N nyaste hämtade kopiorna här (minst 1, standard 14).
  --dry-run            Säg vad som skulle hämtas och rensas. Ändrar ingenting.

  --prov               Dekryptera en hämtad kopia och kontrollera den. Hämtar ingenting och
                       rör inte driftvärden.
  --kopia <namn>       Vilken kopia --prov ska pröva (standard: den nyaste hämtade).
  --privat-nyckel <fil>  Den privata OpenPGP-nyckeln. Bara för --prov, och bara här — den
                       ska aldrig finnas på driftvärden.
                       Går också att sätta med VIBESANDBOX_BACKUP_PRIVNYCKEL.
  --passfras-fil <fil> Lösenfras till den privata nyckeln, om den har en.

  --puls <url>         Kvittera en lyckad hämtning till en push-monitor (Uptime Kuma).
                       Pulsen skickas BARA när allt gick igenom. Uteblir den larmar monitorn
                       själv när dess tidsgräns löper ut — vilket också täcker att den här
                       maskinen inte kört alls. Går också att sätta med VIBESANDBOX_PULS.

  --hjalp              Den här texten.

Körs PÅ NAS:EN. Säkerhetskopiorna skapas av backup.sh på driftvärden.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --vard) shift; VARD="${1:-}" ;;
    --anvandare) shift; ANVANDARE="${1:-}" ;;
    --mal) shift; MAL="${1:-}" ;;
    --behall) shift; BEHALL="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    --prov) LAGE=prov ;;
    --kopia) shift; KOPIA="${1:-}" ;;
    --privat-nyckel) shift; PRIVNYCKEL="${1:-}" ;;
    --passfras-fil) shift; PASSFRASFIL="${1:-}" ;;
    --puls) shift; PULS="${1:-}" ;;
    --hjalp | -h) anvandning; exit 0 ;;
    *) printf 'okänd flagga: %s\n\n' "$1" >&2; anvandning >&2; exit 2 ;;
  esac
  shift
done

[[ "$BEHALL" =~ ^[0-9]+$ ]] || vagra "--behall måste vara ett heltal (är '${BEHALL}')."
(( 10#$BEHALL >= 1 )) || vagra "--behall måste vara minst 1 — en rotation som raderar allt är inte en rotation."
BEHALL=$(( 10#$BEHALL ))
[[ -z "$KOPIA" || "$KOPIA" =~ $KATALOGMONSTER ]] || vagra "'${KOPIA}' är inget giltigt namn på en säkerhetskopia."

# ── Målkatalogen ───────────────────────────────────────────────────────────────────────────
#
# Vi skapar den INTE. En felstavad --mal ska inte tyst bli en ny, tom katalog någonstans på
# volymen som sedan ser ut att innehålla backuper. Att katalogen finns är dessutom det enda
# rimliga kvittot på att någon har bestämt VAR de här kopiorna hör hemma.
[[ -n "$MAL" ]] || vagra "--mal får inte vara tom."
[[ -d "$MAL" && ! -L "$MAL" ]] \
  || vagra "${MAL} finns inte (eller är en länk). Skapa den först — skriptet skapar den inte, för en felstavad sökväg ska inte bli en tom katalog som ser ut att innehålla säkerhetskopior."
[[ -w "$MAL" ]] || vagra "${MAL} går inte att skriva i som $(id -un)."
case "$MAL" in /*) : ;; *) vagra "--mal måste vara en absolut sökväg (är '${MAL}')." ;; esac

# ── Fjärrsidan ─────────────────────────────────────────────────────────────────────────────
#
# Allt vi frågar värden om går genom EN kommandorad: 'sudo -n <FJARRSKRIPT> <flagga>'. ops
# har en NOPASSWD-rad för just det programmet, och programmet lämnar bara ut manifestet och
# arkiv.tar.gpg. Ingen annan väg in i ${PLATFORM_ROOT}/backups finns för ops.
#
# HAMTA_FJARRKOMMANDO ersätter 'ssh … sudo -n …'-ledet. Den finns för testsviten, som kör
# värdsidan lokalt i en engångscontainer; i drift ska den aldrig vara satt.
FJARR=()
if [[ -n "${HAMTA_FJARRKOMMANDO:-}" ]]; then
  read -r -a FJARR <<<"$HAMTA_FJARRKOMMANDO"
else
  [[ -n "$VARD" ]] || vagra "--vard får inte vara tom."
  [[ -n "$ANVANDARE" ]] || vagra "--anvandare får inte vara tom."
  har_kommando ssh || vagra "ssh saknas — utan den går det inte att hämta något."
  FJARR=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=20
         -- "${ANVANDARE}@${VARD}" sudo -n "$FJARRSKRIPT")
fi
fjarr() { "${FJARR[@]}" "$@"; }

# Fjärrsidans felutskrifter hamnar här, så att de går att visa när något gick snett utan att
# blandas ihop med den binära strömmen på stdout.
FJARRFEL="$(mktemp)" || avbryt "kunde inte skapa en temporär fil."
PROVKATALOG=""
stada() {
  [[ -n "${FJARRFEL:-}" ]] && rm -f -- "$FJARRFEL"
  if [[ -n "${PROVKATALOG:-}" && -d "$PROVKATALOG" ]]; then
    [[ -n "${GPG_HEM:-}" && -d "${GPG_HEM:-}" ]] && GNUPGHOME="$GPG_HEM" gpgconf --kill all >/dev/null 2>&1
    rm -rf -- "$PROVKATALOG"
  fi
  return 0
}
trap stada EXIT

visa_fjarrfel() {
  [[ -s "$FJARRFEL" ]] || return 0
  tail -n 5 "$FJARRFEL" | sed 's/^/      | /' >&2
  : >"$FJARRFEL"
}

# ── Vad har vi redan? ──────────────────────────────────────────────────────────────────────
#
# En kopia räknas som hämtad bara om filen 'hamtad' ligger i den. En katalog utan den är en
# avbruten hämtning — den ska hämtas om, inte räknas.

lokala_kopior() {
  local sokvag namn
  find "$MAL" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while IFS= read -r sokvag; do
    namn="${sokvag##*/}"
    [[ "$namn" =~ $KATALOGMONSTER ]] || continue
    [[ -f "${sokvag}/hamtad" ]] || continue
    printf '%s\n' "$namn"
  done | LC_ALL=C sort
}

har_lokalt() {
  local namn="$1" n
  while IFS= read -r n; do [[ "$n" == "$namn" ]] && return 0; done < <(lokala_kopior)
  return 1
}

# ── Hämtningen ─────────────────────────────────────────────────────────────────────────────

# hamta_en <namn> <sha256 ur --lista> <storlek ur --lista>
# Returnerar 0 bara när kopian ligger på plats, hel och kontrollerad. Vid varje annat utfall
# är .ofullstandig borta och ingen katalog med det riktiga namnet har skapats.
hamta_en() {
  local namn="$1" sha="$2" storlek="$3"
  local arb="${MAL}/.ofullstandig"
  local arkiv="${arb}/${ARKIV}"
  local fel=""

  if [[ -e "$arb" ]]; then
    varna "en tidigare, avbruten hämtning lämnade ${arb} — den kastas."
    rm -rf -- "$arb" || { varna "${namn}: ${arb} gick inte att kasta"; return 1; }
  fi
  mkdir -p -- "$arb" || { varna "${namn}: kunde inte skapa ${arb}"; return 1; }
  chmod 700 -- "$arb"

  if ! fjarr --manifest "$namn" >"${arb}/manifest" 2>"$FJARRFEL"; then
    fel="manifestet gick inte att hämta"
  elif [[ ! -s "${arb}/manifest" ]]; then
    fel="manifestet kom tomt"
  elif ! fjarr --skicka "$namn" >"$arkiv" 2>"$FJARRFEL"; then
    fel="arkivet gick inte att hämta"
  fi

  # Kontrollen görs mot TVÅ oberoende uppgifter från värden: raden i --lista och arkiv_sha256
  # i det hämtade manifestet. Att båda ska stämma kostar ingenting och fångar det fall där bara
  # den ena överföringen blev trunkerad.
  if [[ -z "$fel" ]]; then
    local faktisk_storlek faktisk_sha manifest_sha
    faktisk_storlek="$(wc -c <"$arkiv" | tr -d ' ')"
    faktisk_sha="$(sha256sum "$arkiv" | cut -d' ' -f1)"
    manifest_sha="$(awk -F= '$1 == "arkiv_sha256" { print $2; exit }' "${arb}/manifest")"
    if [[ "$faktisk_storlek" != "$storlek" ]]; then
      fel="fel storlek: ${faktisk_storlek} byte, väntade ${storlek} — överföringen blev avbruten"
    elif [[ "$faktisk_sha" != "$sha" ]]; then
      fel="sha256 stämmer inte: ${faktisk_sha} mot ${sha} i listan — det hämtade är inte det värden säger sig ha"
    elif [[ "$manifest_sha" != "$sha" ]]; then
      fel="manifestets arkiv_sha256 (${manifest_sha:-saknas}) säger emot listan (${sha})"
    fi
  fi

  if [[ -n "$fel" ]]; then
    varna "${namn}: ${fel}"
    visa_fjarrfel
    rm -rf -- "$arb"
    return 1
  fi

  # 'hamtad' skrivs SIST och är det som gör katalogen till en hämtad kopia. Den byter namn
  # först därefter — det finns alltså inget ögonblick då en halv kopia bär det riktiga namnet.
  {
    printf 'hamtad_tidpunkt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'hamtad_fran=%s\n' "${ANVANDARE}@${VARD}"
    printf 'arkiv=%s\n' "$ARKIV"
    printf 'arkiv_sha256=%s\n' "$sha"
    printf 'arkiv_storlek=%s\n' "$storlek"
  } >"${arb}/hamtad"
  chmod 600 "${arb}/manifest" "$arkiv" "${arb}/hamtad"

  if ! mv -- "$arb" "${MAL}/${namn}"; then
    varna "${namn}: kunde inte flytta ${arb} till ${MAL}/${namn}"
    rm -rf -- "$arb"
    return 1
  fi
  return 0
}

kor_hamtning() {
  rubrik "Hämtar från ${ANVANDARE}@${VARD} till ${MAL}"

  local listan
  if ! listan="$(fjarr --lista 2>"$FJARRFEL")"; then
    visa_fjarrfel
    avbryt "kunde inte fråga ${VARD} vilka säkerhetskopior som finns. (Kommer NAS:ens nyckel in som ${ANVANDARE}, och har ops en NOPASSWD-rad för ${FJARRSKRIPT}?)"
  fi

  local -a NAMN=() SHA=() STORLEK=()
  local n s b rad
  while IFS=' ' read -r n s b; do
    [[ -n "$n" ]] || continue
    # Raden kommer från andra sidan av en SSH-anslutning: den prövas innan den rör en sökväg.
    [[ "$n" =~ $KATALOGMONSTER ]] || { varna "hoppar över en rad med ogiltigt namn: '${n}'"; continue; }
    [[ "$s" =~ ^[0-9a-f]{64}$ ]] || { varna "${n}: ogiltig sha256 i listan"; continue; }
    [[ "$b" =~ ^[0-9]+$ ]] || { varna "${n}: ogiltig storlek i listan"; continue; }
    NAMN+=("$n"); SHA+=("$s"); STORLEK+=("$b")
  done <<<"$listan"

  if (( ${#NAMN[@]} == 0 )); then
    varna "${VARD} har ingen säkerhetskopia med ett krypterat arkiv. Kör backup.sh där med --publik-nyckel."
    return 1
  fi
  klart "${#NAMN[@]} krypterade säkerhetskopior finns på ${VARD}"

  local -a ATT_HAMTA=() ATT_HAMTA_SHA=() ATT_HAMTA_STORLEK=()
  local i
  for (( i = 0; i < ${#NAMN[@]}; i++ )); do
    if har_lokalt "${NAMN[i]}"; then continue; fi
    ATT_HAMTA+=("${NAMN[i]}"); ATT_HAMTA_SHA+=("${SHA[i]}"); ATT_HAMTA_STORLEK+=("${STORLEK[i]}")
  done

  if (( ${#ATT_HAMTA[@]} == 0 )); then
    klart "ingenting nytt — alla ${#NAMN[@]} finns redan här"
  fi

  if (( DRY_RUN )); then
    rubrik "Torrkörning — ingenting skrivs"
    for (( i = 0; i < ${#ATT_HAMTA[@]}; i++ )); do
      printf '  [dry-run] skulle hämta %s (%s byte)\n' "${ATT_HAMTA[i]}" "${ATT_HAMTA_STORLEK[i]}"
    done
    local -a FINNS=()
    while IFS= read -r rad; do [[ -n "$rad" ]] && FINNS+=("$rad"); done < <(lokala_kopior)
    printf '  [dry-run] %d kopior finns här; efter rotationen (--behall %d) skulle %d finnas kvar\n' \
      "${#FINNS[@]}" "$BEHALL" \
      "$(( BEHALL < ${#FINNS[@]} + ${#ATT_HAMTA[@]} ? BEHALL : ${#FINNS[@]} + ${#ATT_HAMTA[@]} ))"
    printf '\n  Ingenting ändrat.\n'
    return 0
  fi

  local hamtade=0 misslyckade=0
  for (( i = 0; i < ${#ATT_HAMTA[@]}; i++ )); do
    gor "hämtar ${ATT_HAMTA[i]} (${ATT_HAMTA_STORLEK[i]} byte)"
    if hamta_en "${ATT_HAMTA[i]}" "${ATT_HAMTA_SHA[i]}" "${ATT_HAMTA_STORLEK[i]}"; then
      klart "${ATT_HAMTA[i]} — sha256 stämmer"
      hamtade=$(( hamtade + 1 ))
    else
      misslyckade=$(( misslyckade + 1 ))
    fi
  done

  # Rotationen kör EFTER hämtningen och bara på hela kopior. En hämtning som misslyckas ska
  # aldrig ha hunnit radera den förra — det är just då man behöver den.
  rubrik "Rotation här på NAS:en — behåller de ${BEHALL} nyaste"
  local -a ALLA=()
  while IFS= read -r rad; do [[ -n "$rad" ]] && ALLA+=("$rad"); done < <(lokala_kopior | LC_ALL=C sort -r)
  local borttagna=0
  for (( i = BEHALL; i < ${#ALLA[@]}; i++ )); do
    gor "tar bort ${ALLA[i]}"
    rm -rf -- "${MAL:?}/${ALLA[i]}"
    borttagna=$(( borttagna + 1 ))
  done
  (( borttagna > 0 )) || klart "ingenting att ta bort (${#ALLA[@]} av ${BEHALL})"

  rubrik "Klart"
  printf '  hämtade     %s\n' "$hamtade"
  printf '  fanns redan %s\n' "$(( ${#NAMN[@]} - ${#ATT_HAMTA[@]} ))"
  printf '  misslyckade %s\n' "$misslyckade"
  printf '  här nu      %s (rotation --behall %s, %s borttagna)\n' \
    "$(( ${#ALLA[@]} - borttagna ))" "$BEHALL" "$borttagna"
  printf '\n  Arkiven är krypterade. Pröva att de GÅR att läsa: %s --prov --privat-nyckel <fil>\n' \
    "${0##*/}"

  (( misslyckade == 0 ))
}

# ── Provet ─────────────────────────────────────────────────────────────────────────────────
#
# Poängen med hela övningen. En krypterad säkerhetskopia som ingen kan dekryptera är samma sak
# som ingen säkerhetskopia, och skillnaden märks först den dag det är för sent. Provet gör
# därför exakt det en återställning skulle börja med — dekrypterar med den privata nyckeln och
# jämför varje databas mot manifestets sha256 — men gör det HÄR, på NAS:en, utan att röra
# driftvärden och utan att lägga tillbaka något någonstans.
#
# Under provet ligger driftens hemligheter i klartext på NAS:ens disk (compose/.env finns i
# arkivet). Katalogen är 0700 och tas bort av EXIT-fällan oavsett hur skriptet slutar. Att
# överskriva det raderade går inte att lova på ett Btrfs/ext4-filsystem med ögonblicksbilder —
# det står i README:s OTESTAT-avsnitt.

GPG_HEM=""

prov() {
  har_kommando gpg \
    || vagra "gpg finns inte på den här maskinen, och utan den går arkivet inte att pröva. På DSM: installera Entware och 'opkg install gnupg'. (Hämtningen fungerar utan gpg — det är bara provet som kräver den.)"
  [[ -n "$PRIVNYCKEL" ]] \
    || vagra "--prov kräver --privat-nyckel. Nyckeln finns i Bitwarden och ska ligga BARA här och där, aldrig på driftvärden."
  [[ -f "$PRIVNYCKEL" && ! -L "$PRIVNYCKEL" ]] \
    || vagra "hittar ingen vanlig fil på ${PRIVNYCKEL}."
  [[ -z "$PASSFRASFIL" || -f "$PASSFRASFIL" ]] \
    || vagra "hittar ingen lösenfrasfil på ${PASSFRASFIL}."

  local vald="$KOPIA"
  if [[ -z "$vald" ]]; then
    vald="$(lokala_kopior | LC_ALL=C sort | tail -n 1)"
    [[ -n "$vald" ]] || vagra "det finns ingen hämtad säkerhetskopia i ${MAL} att pröva."
  fi
  local kat="${MAL}/${vald}"
  [[ -d "$kat" && -f "${kat}/hamtad" ]] \
    || vagra "${kat} är ingen färdigt hämtad säkerhetskopia (filen 'hamtad' saknas)."
  [[ -f "${kat}/${ARKIV}" ]] || vagra "${kat}/${ARKIV} saknas."

  rubrik "Prov: går ${vald} att läsa tillbaka?"

  # Arkivet på disk ska fortfarande vara det vi hämtade. Ruttnar en bit här är det NAS:ens fel,
  # inte värdens, och då vill vi veta det innan vi skyller på krypteringen.
  local vantad faktisk
  vantad="$(awk -F= '$1 == "arkiv_sha256" { print $2; exit }' "${kat}/hamtad")"
  faktisk="$(sha256sum "${kat}/${ARKIV}" | cut -d' ' -f1)"
  [[ "$faktisk" == "$vantad" ]] \
    || avbryt "${ARKIV} har ändrats sedan den hämtades (${faktisk} mot ${vantad}). Hämta om den."
  klart "arkivet är oförändrat sedan hämtningen"

  # Klartexten packas upp i en egen katalog PÅ SAMMA VOLYM som kopian — inte i /tmp, som på en
  # DSM kan vara liten och ligga på en helt annan disk.
  PROVKATALOG="$(mktemp -d "${MAL}/.prov-XXXXXX")" || avbryt "kunde inte skapa en arbetskatalog i ${MAL}."
  chmod 700 "$PROVKATALOG"
  GPG_HEM="${PROVKATALOG}/gpg"
  mkdir -p "$GPG_HEM"; chmod 700 "$GPG_HEM"

  # Tom array + set -u biter i gamla bash (DSM). ${arr[@]+"${arr[@]}"} är det som funkar överallt.
  local -a passfras=()
  [[ -n "$PASSFRASFIL" ]] && passfras=(--pinentry-mode loopback --passphrase-file "$PASSFRASFIL")

  if ! GNUPGHOME="$GPG_HEM" gpg --batch --no-tty --quiet --import "$PRIVNYCKEL" 2>"$FJARRFEL"; then
    visa_fjarrfel
    avbryt "${PRIVNYCKEL} gick inte att importera som en OpenPGP-nyckel."
  fi
  if ! GNUPGHOME="$GPG_HEM" gpg --batch --no-tty --with-colons --list-secret-keys 2>/dev/null | grep -q '^sec:'; then
    vagra "${PRIVNYCKEL} innehåller ingen PRIVAT nyckel. Provet kräver den privata halvan — den publika kan bara kryptera."
  fi

  mkdir -p "${PROVKATALOG}/ut"
  if ! GNUPGHOME="$GPG_HEM" gpg --batch --no-tty --quiet ${passfras[@]+"${passfras[@]}"} \
        --decrypt "${kat}/${ARKIV}" 2>"$FJARRFEL" | tar -C "${PROVKATALOG}/ut" -xf - 2>>"$FJARRFEL"; then
    visa_fjarrfel
    avbryt "arkivet gick inte att dekryptera och packa upp med ${PRIVNYCKEL}. Det är EXAKT det här provet finns för att upptäcka — kopiorna är oläsbara tills nyckelfrågan är löst."
  fi
  klart "dekrypterat och uppackat med den privata nyckeln"

  local m="${PROVKATALOG}/ut/manifest"
  [[ -f "$m" ]] || avbryt "arkivet innehåller inget manifest — det är inte en säkerhetskopia från backup.sh."

  # Samma kontroll som restore.sh gör innan den rör en värd: varje databas ska finnas och ha
  # exakt den sha256 manifestet skrev ned när kopian togs.
  local antal=0 fel=0 nyckelord summa rest1 rest2 sokvag faktisk_db
  while read -r nyckelord summa rest1 rest2 sokvag; do
    [[ "$nyckelord" == "databas" ]] || continue
    : "$rest1" "$rest2"
    antal=$(( antal + 1 ))
    if [[ ! -s "${PROVKATALOG}/ut/databaser/${sokvag}" ]]; then
      varna "${sokvag}: saknas i arkivet"; fel=$(( fel + 1 )); continue
    fi
    faktisk_db="$(sha256sum "${PROVKATALOG}/ut/databaser/${sokvag}" | cut -d' ' -f1)"
    if [[ "$faktisk_db" != "$summa" ]]; then
      varna "${sokvag}: sha256 stämmer inte (${faktisk_db} mot ${summa})"; fel=$(( fel + 1 ))
    fi
  done <"$m"
  (( antal > 0 )) || varna "manifestet listar ingen databas alls — hade värden aldrig kört plattformen?"
  (( fel == 0 )) || avbryt "${fel} av ${antal} databaser i arkivet stämmer inte med manifestet."
  klart "${antal} databaser, alla med rätt sha256"

  # .env avgör om stacken går att starta efter en flytt. Vi kontrollerar att den finns och har
  # innehåll — och skriver ALDRIG ut något ur den.
  if [[ "$(awk -F= '$1 == "compose_env" { print $2; exit }' "$m")" == "ja" ]]; then
    if [[ -s "${PROVKATALOG}/ut/compose/.env" ]]; then
      klart "compose/.env finns i arkivet ($(wc -c <"${PROVKATALOG}/ut/compose/.env" | tr -d ' ') byte) — stacken går att starta ur kopian"
    else
      avbryt "manifestet säger compose_env=ja men .env saknas i arkivet."
    fi
  fi

  # PRAGMA integrity_check om maskinen kan. Ett oförändrat DSM har varken sqlite3 eller python3,
  # och det är inte ett skäl att underkänna provet: sha256 bevisar redan att arkivet går att
  # dekryptera och att innehållet är bit för bit det värden skrev. Men vi säger vilken av de två
  # nivåerna vi nådde, i stället för att låta läsaren tro att den starkare kontrollen kördes.
  local korning=""
  if har_kommando sqlite3; then korning=sqlite3
  elif har_kommando python3 && python3 -c 'import sqlite3' >/dev/null 2>&1; then korning=python3
  fi
  if [[ -n "$korning" ]]; then
    local trasiga=0 svar
    while read -r nyckelord summa rest1 rest2 sokvag; do
      [[ "$nyckelord" == "databas" ]] || continue
      : "$summa" "$rest1" "$rest2"
      if [[ "$korning" == sqlite3 ]]; then
        svar="$(sqlite3 "${PROVKATALOG}/ut/databaser/${sokvag}" 'PRAGMA integrity_check' 2>&1 | head -n 1)"
      else
        svar="$(python3 -c '
import sqlite3, sys
db = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
print(db.execute("PRAGMA integrity_check").fetchone()[0])
db.close()
' "${PROVKATALOG}/ut/databaser/${sokvag}" 2>&1 | head -n 1)"
      fi
      if [[ "$svar" != "ok" ]]; then
        varna "${sokvag}: integrity_check sa '${svar}'"; trasiga=$(( trasiga + 1 ))
      fi
    done <"$m"
    (( trasiga == 0 )) || avbryt "${trasiga} databaser underkändes av integrity_check."
    klart "integrity_check (${korning}): alla ${antal} databaser går att öppna och är hela"
  else
    varna "integrity_check kördes INTE — den här maskinen har varken sqlite3 eller python3. sha256 stämmer, så arkivet är läsbart och oförändrat, men att databaserna går att ÖPPNA är inte prövat här."
  fi

  rubrik "Provet gick igenom"
  printf '  kopia       %s\n' "$kat"
  printf '  tagen       %s på %s\n' \
    "$(awk -F= '$1 == "tidpunkt" { print $2; exit }' "$m")" \
    "$(awk -F= '$1 == "vard" { print $2; exit }' "$m")"
  printf '  version     %s\n' "$(awk -F= '$1 == "app_version" { print $2; exit }' "$m")"
  printf '  databaser   %s med rätt sha256%s\n' "$antal" \
    "$([[ -n "$korning" ]] && printf ' och godkända av integrity_check' || printf ', integrity_check ej körd')"
  printf '\n  Den privata nyckeln fungerar: kopian går att läsa tillbaka.\n'
  printf '  Klartexten är borta igen — den låg i %s under provet.\n' "$PROVKATALOG"
}

# Pulsen ligger EFTER hämtningen och utanför den, så att ett fel i pulsandet aldrig kan få en
# lyckad hämtning att se misslyckad ut — och så att en misslyckad hämtning aldrig kan pulsa.
skicka_puls() {
  [[ -n "$PULS" ]] || return 0
  if (( DRY_RUN )); then
    klart "skulle pulsa ${PULS%%\?*}"
    return 0
  fi
  # Kuma svarar 200 på en giltig push. Misslyckas den är det ingen katastrof: monitorn larmar då
  # av sig själv, vilket är precis rätt utfall.
  if curl -fsS --max-time 15 -o /dev/null "$PULS"; then
    klart "pulsen kvitterad"
  else
    varna "pulsen gick inte fram — monitorn kommer att larma av sig själv, och det är rätt."
  fi
}

if [[ "$LAGE" == prov ]]; then
  prov
else
  kor_hamtning
  skicka_puls
fi
