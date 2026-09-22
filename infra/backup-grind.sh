#!/usr/bin/env bash
#
# Grinden för NAS:ens hämtningsnyckel.
#
# Nyckeln som hämtar säkerhetskopian binds i `authorized_keys` till det här skriptet med
# `command=`, så den kan inte ge ett skal. Allt som kommer in står i `SSH_ORIGINAL_COMMAND` och
# prövas mot en ALLOWLIST: bara säkerhetskopians läsgränssnitt släpps igenom, och bara med
# argument som ser ut som de ska.
#
# Utan grinden ger nyckeln full `ops`-shell på driftvärden. Det är inte ett nytt förtroende — det
# är ägarens egen NAS, och tailnet-ACL:en släpper redan in ägarens enheter — men hela plattformen är
# byggd på att varje väg är så smal som den kan vara, och en nyckel som bara ska läsa ut ett
# krypterat arkiv ska inte kunna göra något annat.
#
# Varför en allowlist och inte en denylist: den som ändå tar sig igenom ska ta sig igenom något vi
# har tänkt på. En nekad rad loggas till syslog, så att ett försök går att se i efterhand.
#
# Raden i ops `authorized_keys` (läggs för hand — ett skript som skriver i authorized_keys kan
# låsa ute den enda vägen in, och det priset är inte värt automatiken):
#
#   restrict,command="/usr/local/sbin/vibesandbox-backup-grind" ssh-ed25519 AAAA… nas-hämtning
#
set -u

KMD="${SSH_ORIGINAL_COMMAND:-}"
BACKUP=/usr/local/sbin/vibesandbox-backup

neka() {
  logger -t vibesandbox-grind -p auth.warning "nekade fjärrkommando: ${KMD}" 2>/dev/null || true
  printf 'Den här nyckeln får bara läsa säkerhetskopior.\n' >&2
  exit 126
}

# `--lista` utan argument, eller `--manifest`/`--skicka` med ETT namn som ser ut som en
# säkerhetskopias katalognamn (ISO-tid utan skiljetecken). Inget annat, och inga extra ord:
# jämförelsen byggs om ur det tolkade argumentet och måste bli ordagrant samma sträng igen.
NAMN='[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z'
case "$KMD" in
  "sudo -n ${BACKUP} --lista") ;;
  "sudo -n ${BACKUP} --manifest "* | "sudo -n ${BACKUP} --skicka "*)
    arg="${KMD##* }"
    [[ "$KMD" == "sudo -n ${BACKUP} --manifest ${arg}" || "$KMD" == "sudo -n ${BACKUP} --skicka ${arg}" ]] || neka
    [[ "$arg" =~ ^${NAMN}$ ]] || neka
    ;;
  *) neka ;;
esac

# Ordklyvningen är avsiktlig: kommandot är redan prövat mot allowlisten ovan, och det ska köras
# som de orden — inte som en enda sträng.
# shellcheck disable=SC2086
exec $KMD
