#!/usr/bin/env bash
# verify.sh — kontrollerar värdens FAKTISKA läge, inte konfigurationsfilerna.
#
# Varför: hos många leverantörer kan en kontrollpanel köra root-skript i gästen (via
# gästagenten) och skriva om SSH-konfigurationen bakom ryggen. En fil som ser rätt ut bevisar
# ingenting — 'sshd -T', 'nft list', 'ss', 'sysctl -n' och 'docker info' gör det.
#
# Inga antaganden om vad andras filer heter: kontrollerna utgår från det sammanslagna,
# effektiva läget och pekar sedan ut VILKA filer som ligger i vägen.
#
# Utskrift: ✓ (rätt), ✗ (avvikelse ⇒ exit 1), ⚠ (medvetet val eller något att känna till).
# Fristående: installeras som /usr/local/sbin/vibesandbox-verify och körs varje timme av
# vibesandbox-verify.timer. Läser förväntat läge från /etc/vibesandbox/provision.state.

# Inte -e: en misslyckad kontroll ska rapporteras, inte avbryta resten.
# Inte pipefail: 'kommando | grep -q' avslutar grep vid första träffen, kommandot får SIGPIPE,
# och med pipefail skulle en RÄTT inställning då slumpvis rapporteras som avvikelse.
set -u

TYST=0
HOPPA_OVER=""
FEL=0
VARNINGAR=0

anvandning() {
  cat <<'EOF'
Användning: verify.sh [--tyst] [--hoppa-over <kontroll,kontroll>] [--lista]

  --tyst          Skriv bara avvikelser och varningar (för timer/cron).
  --hoppa-over    Kommaseparerade kontroller att hoppa över, t.ex. 'docker,kataloger'
                  när bara fas 1 är körd.
  --lista         Skriv ut kontrollernas namn.

Avslutar med 0 om allt stämmer, 1 vid minst en avvikelse (✗).
EOF
}

readonly KONTROLLER=(uppdateringar anvandare tailscale brandvagg ssh portar leverantor docker gvisor system kataloger)

ok()    { (( TYST )) || printf '  ✓ %s\n' "$*"; }
fel()   { printf '  ✗ %s\n' "$*"; FEL=$(( FEL + 1 )); }
obs()   { printf '  ⚠ %s\n' "$*"; VARNINGAR=$(( VARNINGAR + 1 )); }
rubrik() { (( TYST )) || printf '\n%s\n' "$*"; }
har_kommando() { command -v "$1" >/dev/null 2>&1; }

# forvanta <beskrivning> <faktiskt> <förväntat>
forvanta() {
  if [[ "$2" == "$3" ]]; then ok "$1: $2"; else fel "$1: är '$2', ska vara '$3'"; fi
}

las_tillstand() {
  local fil="${VIBESANDBOX_STATE:-/etc/vibesandbox/provision.state}"
  if [[ -r "$fil" ]]; then
    # shellcheck disable=SC1090
    . "$fil"
  else
    obs "hittar inte ${fil} — använder standardvärden (har provision.sh körts?)"
  fi
  OPS_USER="${OPS_USER:-ops}"
  SSH_PORT="${SSH_PORT:-22}"
  PUBLIC_TCP_PORTS="${PUBLIC_TCP_PORTS-443}"
  PUBLIC_UDP_PORTS="${PUBLIC_UDP_PORTS-443}"
  LOCK_ROOT_PASSWORD="${LOCK_ROOT_PASSWORD:-1}"
  HARDEN_GUEST_AGENT="${HARDEN_GUEST_AGENT:-0}"
  INSTALL_GVISOR="${INSTALL_GVISOR:-0}"
  DOCKER_XFS_LOOP="${DOCKER_XFS_LOOP:-0}"
  SWAPFILE_SIZE_GB="${SWAPFILE_SIZE_GB:-2}"
  VM_SWAPPINESS="${VM_SWAPPINESS:-20}"
  PLATFORM_ROOT="${PLATFORM_ROOT:-/srv/vibesandbox}"
  DATA_USER="${DATA_USER:-vibesandbox}"
  DATA_UID="${DATA_UID:-110001}"
  DOCKREMAP_SUBID_BASE="${DOCKREMAP_SUBID_BASE:-100000}"
}

# ── Kontroller ─────────────────────────────────────────────────────────────────────────────

kontroll_uppdateringar() {
  rubrik "Automatiska säkerhetsuppdateringar"
  local enhet lage
  for enhet in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service; do
    lage="$(systemctl is-enabled "$enhet" 2>/dev/null || true)"
    if [[ "$lage" == masked* ]]; then
      fel "${enhet} är MASKAD — uppdateringar kör aldrig"
    else
      ok "${enhet} är inte maskad (${lage:-okänt})"
    fi
  done
  for enhet in apt-daily.timer apt-daily-upgrade.timer; do
    # Beviset är att timern faktiskt har en nästa körning.
    if systemctl list-timers --all --no-legend --no-pager "$enhet" 2>/dev/null | grep -q "$enhet" \
      && systemctl is-active --quiet "$enhet" 2>/dev/null; then
      ok "${enhet} är schemalagd"
    else
      fel "${enhet} finns inte bland aktiva timrar (systemctl list-timers)"
    fi
  done
  forvanta "unattended-upgrades.service" "$(systemctl is-enabled unattended-upgrades.service 2>/dev/null || true)" "enabled"
  # Allt som är maskat, utan antaganden om namn; det vi är beroende av får inte finnas bland dem.
  local alla maskade ovriga
  alla="$(systemctl list-unit-files --state=masked --no-legend --no-pager 2>/dev/null | awk '{print $1}')"
  maskade="$(grep -E '^(apt-daily|apt-daily-upgrade|unattended-upgrades|nftables|docker|containerd|tailscaled|ssh|sshd|systemd-timesyncd|systemd-resolved|vibesandbox-verify)\.' <<<"$alla" || true)"
  if [[ -n "$maskade" ]]; then
    fel "maskade enheter som ska vara igång: $(tr '\n' ' ' <<<"$maskade")"
  else
    ok "inga av enheterna vi är beroende av är maskade"
  fi
  ovriga="$(grep -vxF -e "$maskade" <<<"$alla" | tr '\n' ' ')"
  [[ -n "${ovriga// /}" ]] && ok "övriga maskade enheter på värden (lämnas orörda): ${ovriga}"
  if har_kommando apt-config; then
    local v
    v="$(apt-config dump 2>/dev/null | grep -E '^APT::Periodic::Unattended-Upgrade ' | tr -dc '0-9')"
    forvanta "APT::Periodic::Unattended-Upgrade (effektivt, apt-config dump)" "${v:-0}" "1"
  fi
  [[ -e /var/run/reboot-required ]] && obs "en omstart väntar (/var/run/reboot-required)"
  return 0
}

kontroll_anvandare() {
  rubrik "Användare och grupper"
  if ! id "$OPS_USER" >/dev/null 2>&1; then
    fel "driftanvändaren ${OPS_USER} finns inte"
    return 0
  fi
  local grupper
  grupper="$(id -nG "$OPS_USER" | tr ' ' '\n')"
  if grep -qx sudo <<<"$grupper"; then ok "${OPS_USER} är med i sudo"; else fel "${OPS_USER} är INTE med i sudo"; fi
  if grep -qx docker <<<"$grupper"; then
    fel "${OPS_USER} är med i docker-gruppen (= root utan lösenord)"
  else
    ok "${OPS_USER} är inte med i docker-gruppen"
  fi
  local medlemmar
  medlemmar="$(getent group docker 2>/dev/null | cut -d: -f4)"
  if [[ -n "$medlemmar" ]]; then fel "docker-gruppen har medlemmar: ${medlemmar}"; else ok "docker-gruppen är tom"; fi
  medlemmar="$(getent group sudo 2>/dev/null | cut -d: -f4)"
  forvanta "medlemmar i sudo" "$medlemmar" "$OPS_USER"
  forvanta "lösenordsstatus för ${OPS_USER} (krävs för sudo och webbkonsol)" "$(passwd -S "$OPS_USER" 2>/dev/null | awk '{print $2}')" "P"
  if (( LOCK_ROOT_PASSWORD )); then
    forvanta "lösenordsstatus för root" "$(passwd -S root 2>/dev/null | awk '{print $2}')" "L"
  fi
  # Andra konton med uid 0 eller med inloggningsskal är avdrift.
  local extra
  extra="$(awk -F: '$3==0 && $1!="root"{print $1}' /etc/passwd | tr '\n' ' ')"
  if [[ -n "$extra" ]]; then fel "fler konton med uid 0: ${extra}"; else ok "bara root har uid 0"; fi
  extra="$(awk -F: -v ops="$OPS_USER" '$7 ~ /(bash|sh|zsh|dash)$/ && $1!="root" && $1!=ops {print $1}' /etc/passwd | tr '\n' ' ')"
  if [[ -n "$extra" ]]; then fel "oväntade konton med inloggningsskal: ${extra}"; else ok "inga oväntade konton med skal"; fi
  return 0
}

kontroll_tailscale() {
  rubrik "Tailscale"
  if ! har_kommando tailscale; then fel "tailscale är inte installerat"; return 0; fi
  if systemctl is-active --quiet tailscaled 2>/dev/null; then ok "tailscaled är igång"; else fel "tailscaled är inte igång"; fi
  local ip
  ip="$(tailscale ip -4 2>/dev/null | head -n1)"
  if [[ -n "$ip" ]]; then ok "ansluten till tailnetet"; else fel "inte ansluten till tailnetet (tailscale ip -4)"; fi
  return 0
}

kontroll_brandvagg() {
  rubrik "Brandvägg (laddat regelverk, nft list)"
  if ! har_kommando nft; then fel "nft saknas"; return 0; fi
  local tabell
  tabell="$(nft -s list table inet vibesandbox 2>/dev/null)"
  if [[ -z "$tabell" ]]; then
    fel "tabellen 'inet vibesandbox' är INTE laddad — värden saknar brandvägg"
    return 0
  fi
  ok "tabellen inet vibesandbox är laddad"
  if grep -Eq 'hook input priority (filter|0); policy drop;' <<<"$tabell"; then ok "input: policy drop"; else fel "input-kedjan har inte policy drop"; fi
  if grep -Eq 'hook forward priority (filter - 10|-10); policy drop;' <<<"$tabell"; then ok "forward: policy drop, före Dockers kedjor"; else fel "forward-kedjan har inte policy drop med prioritet filter - 10"; fi
  if grep -Eq "iifname \"tailscale0\" tcp dport ${SSH_PORT} accept" <<<"$tabell"; then ok "SSH tillåts på tailscale0"; else fel "regeln för SSH på tailscale0 saknas"; fi
  # Ingen annan regel får släppa in SSH.
  if grep -E "dport.*\b${SSH_PORT}\b.*accept" <<<"$tabell" | grep -vq 'iifname "tailscale0"'; then
    fel "SSH-porten släpps in på fler gränssnitt än tailscale0"
  else
    ok "SSH släpps inte in någon annanstans"
  fi
  if grep -q 'ip daddr @sparrade_v4 counter drop' <<<"$tabell" && grep -q '100.64.0.0/10' <<<"$tabell"; then
    ok "containrars trafik mot tailnet/privata nät spärras"
  else
    fel "spärren för containrars trafik mot tailnet/privata nät saknas"
  fi
  # Helheten: exakt det regelverk som provision.sh laddade.
  local summafil=/etc/vibesandbox/nft.sha256 summa
  if [[ -r "$summafil" ]]; then
    summa="$(sha256sum <<<"$tabell" | awk '{print $1}')"
    if [[ "$summa" == "$(cat "$summafil")" ]]; then
      ok "laddat regelverk är identiskt med det provision.sh laddade"
    else
      fel "laddat regelverk AVVIKER från det provision.sh laddade (någon har ändrat reglerna)"
    fi
  else
    obs "ingen kontrollsumma för regelverket (${summafil} saknas)"
  fi
  forvanta "nftables.service" "$(systemctl is-enabled nftables.service 2>/dev/null || true)" "enabled"
  if grep -Eq '^\s*flush ruleset' /etc/nftables.conf 2>/dev/null; then
    fel "/etc/nftables.conf innehåller 'flush ruleset' — en omladdning raderar Dockers regler"
  else
    ok "/etc/nftables.conf saknar 'flush ruleset'"
  fi
  if har_kommando iptables; then
    if iptables --version 2>/dev/null | grep -q nf_tables; then ok "iptables använder nf_tables-bakänden"; else fel "iptables använder INTE nf_tables ($(iptables --version 2>/dev/null))"; fi
  fi
  return 0
}

kontroll_ssh() {
  rubrik "SSH (effektivt läge, sshd -T)"
  if ! har_kommando sshd; then fel "sshd saknas"; return 0; fi
  local anv adress utdata par nyckel varde faktiskt
  # Både en publik adress och en tailnet-adress: ett Match-block kan ge olika svar.
  for anv in root "$OPS_USER"; do
    for adress in 203.0.113.10 100.64.0.10; do
      utdata="$(sshd -T -C "user=${anv},host=localhost,addr=${adress}" 2>/dev/null)"
      if [[ -z "$utdata" ]]; then
        fel "sshd -T misslyckades (user=${anv}, addr=${adress}) — konfigurationen är trasig"
        continue
      fi
      for par in "permitrootlogin no" "passwordauthentication no" "kbdinteractiveauthentication no" \
        "pubkeyauthentication yes" "allowusers ${OPS_USER}" "allowagentforwarding no" \
        "allowtcpforwarding no" "maxauthtries 3" "x11forwarding no" "permittunnel no" "permitemptypasswords no"; do
        nyckel="${par%% *}"; varde="${par#* }"
        faktiskt="$(grep -i "^${nyckel} " <<<"$utdata" | cut -d' ' -f2- | tr '\n' ' ' | sed 's/ $//')"
        if [[ "${faktiskt,,}" == "${varde,,}" ]]; then
          ok "${nyckel} ${faktiskt} (user=${anv}, addr=${adress})"
        else
          fel "${nyckel} är '${faktiskt}', ska vara '${varde}' (user=${anv}, addr=${adress})"
        fi
      done
    done
  done
  # Placeringen: vår dropin måste komma FÖRST, annars kan en annan fil vinna i morgon även om
  # 'sshd -T' råkar stämma i dag. Inga antaganden om vad andras filer heter.
  local var=0-0-vibesandbox.conf katalog=/etc/ssh/sshd_config.d fore="" f forsta
  if [[ -f "${katalog}/${var}" ]]; then
    fore="$(
      LC_ALL=C
      cd "$katalog" || exit 0
      for f in *.conf; do [[ -e "$f" && "$f" != "$var" && "$f" < "$var" ]] && printf '%s ' "$f"; done
    )"
    if [[ -n "$fore" ]]; then
      fel "andra dropins sorteras FÖRE vår och kan vinna över den: ${fore}"
    else
      ok "vår dropin sorteras först i ${katalog}"
    fi
  else
    fel "${katalog}/${var} saknas"
  fi
  forsta="$(awk '!/^[[:space:]]*(#|$)/ { print; exit }' /etc/ssh/sshd_config 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')"
  if [[ "${forsta,,}" == "include ${katalog}/*.conf" ]]; then
    ok "sshd_config: Include-raden står före alla direktiv"
  else
    fel "sshd_config: första direktivet är '${forsta}', inte Include-raden — direktiv i huvudfilen kan vinna över dropins"
  fi
  if [[ -s /root/.ssh/authorized_keys ]]; then
    obs "root har authorized_keys (verkningslöst så länge PermitRootLogin=no, men en kontrollpanel kan skriva dit)"
  fi
  return 0
}

kontroll_portar() {
  rubrik "Lyssnande portar (ss)"
  if ! har_kommando ss; then fel "ss saknas"; return 0; fi
  local rad proto lokal port adress process tillatna_tcp tillatna_udp ovantade=0
  tillatna_tcp=" ${SSH_PORT} ${PUBLIC_TCP_PORTS} "
  tillatna_udp=" ${PUBLIC_UDP_PORTS} "
  while read -r rad; do
    [[ -n "$rad" ]] || continue
    proto="$(awk '{print $1}' <<<"$rad")"
    lokal="$(awk '{print $5}' <<<"$rad")"
    process="$(grep -o 'users:.*' <<<"$rad" || true)"
    port="${lokal##*:}"
    adress="${lokal%:*}"
    case "$adress" in
      127.*|\[::1\]|'[::ffff:127.'*) continue ;;                       # loopback
    esac
    [[ "$adress" == 127.* || "$adress" == *%lo ]] && continue
    [[ "$process" == *tailscaled* ]] && continue                         # tailscaleds egna portar
    [[ "$adress" == \[fe80:* && "$port" == 546 ]] && continue            # DHCPv6-klient, länklokal
    [[ "$proto" == udp* && "$port" == 68 ]] && continue                  # DHCP-klient
    if [[ "$proto" == tcp* && "$tillatna_tcp" == *" ${port} "* ]]; then continue; fi
    if [[ "$proto" == udp* && "$tillatna_udp" == *" ${port} "* ]]; then continue; fi
    fel "oväntad lyssnare: ${proto} ${lokal} ${process}"
    ovantade=$(( ovantade + 1 ))
  done < <(ss -H -lntup 2>/dev/null)
  (( ovantade == 0 )) && ok "inga oväntade lyssnare utanför loopback"
  if ss -H -lntu 2>/dev/null | awk '{print $5}' | grep -Eq ':5355$'; then
    fel "LLMNR lyssnar på port 5355"
  else
    ok "LLMNR (5355) lyssnar inte"
  fi
  return 0
}

kontroll_leverantor() {
  rubrik "Kanaler utifrån (cloud-init, gästagent)"
  if [[ -d /etc/cloud/cloud.cfg.d ]]; then
    local effektivt=""
    # Helst det sammanslagna läget, så som cloud-init självt läser det.
    if har_kommando python3; then
      effektivt="$(python3 - 2>/dev/null <<'EOF'
from cloudinit import stages
i = stages.Init()
i.read_cfg()
print("ssh_pwauth=%s disable_root=%s" % (i.cfg.get("ssh_pwauth"), i.cfg.get("disable_root")))
EOF
)"
    fi
    if [[ -n "$effektivt" ]]; then
      forvanta "cloud-init, sammanslagen konfiguration" "$effektivt" "ssh_pwauth=False disable_root=True"
    else
      # Reserv när cloud-inits python-modul inte går att nå: sista filen (i namnordning) som
      # sätter ssh_pwauth avgör — vilken fil det än är.
      local f sist="" varde=""
      for f in /etc/cloud/cloud.cfg /etc/cloud/cloud.cfg.d/*.cfg; do
        grep -Eq '^ssh_pwauth:' "$f" 2>/dev/null && sist="$f"
      done
      [[ -n "$sist" ]] && varde="$(sed -n 's/^ssh_pwauth:[[:space:]]*//p' "$sist" | tail -n1 | tr -d '"'"'"' ' | tr '[:upper:]' '[:lower:]')"
      if [[ "$varde" == "false" || "$varde" == "no" || "$varde" == "0" ]]; then
        ok "cloud-init: sista filen som sätter ssh_pwauth (${sist}) säger ${varde}"
      else
        fel "cloud-init: ssh_pwauth är '${varde:-osatt}' efter sammanslagning (sista fil: ${sist:-ingen})"
      fi
    fi
  else
    ok "cloud-init finns inte"
  fi

  if har_kommando qemu-ga; then
    local sparrade
    sparrade="$(qemu-ga -D 2>/dev/null | grep -E '^(block-rpcs|blacklist)=' | cut -d= -f2-)"
    if (( HARDEN_GUEST_AGENT )); then
      if [[ "$sparrade" == *guest-exec* && "$sparrade" == *guest-set-user-password* && "$sparrade" == *guest-file-write* ]]; then
        ok "gästagenten spärrar guest-exec, filskrivning och lösenordsbyte"
      else
        fel "gästagenten ska vara härdad (HARDEN_GUEST_AGENT=1) men spärrar: '${sparrade:-ingenting}'"
      fi
      # Konfigurationen läses bara vid start ⇒ agenten måste ha startats efter att filen skrevs.
      local start fil
      start="$(systemctl show -p ActiveEnterTimestampMonotonic --value qemu-guest-agent.service 2>/dev/null || true)"
      fil="$(stat -c %Y /etc/qemu/qemu-ga.conf 2>/dev/null || echo 0)"
      if [[ -n "$start" && "$start" != 0 ]]; then
        local nu uppe startad
        nu="$(date +%s)"; uppe="$(cut -d. -f1 /proc/uptime)"
        startad=$(( nu - uppe + start / 1000000 ))
        if (( startad + 5 < fil )); then fel "qemu-guest-agent har inte startats om sedan qemu-ga.conf ändrades"; fi
      fi
    else
      obs "gästagenten är obegränsad (medvetet val, HARDEN_GUEST_AGENT=0): kontot hos leverantören är root här — kräver 2FA på kontot"
    fi
  else
    ok "qemu-guest-agent finns inte"
  fi
  return 0
}

kontroll_docker() {
  rubrik "Docker (docker info)"
  if ! har_kommando docker; then fel "docker är inte installerat"; return 0; fi
  if ! docker info >/dev/null 2>&1; then fel "docker-demonen svarar inte"; return 0; fi
  local sakerhet
  sakerhet="$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null)"
  local val
  for val in userns no-new-privileges seccomp apparmor cgroupns; do
    if grep -q "name=${val}" <<<"$sakerhet"; then ok "säkerhetsval aktivt: ${val}"; else fel "säkerhetsval SAKNAS i docker info: ${val}"; fi
  done
  forvanta "cgroup-drivrutin" "$(docker info --format '{{.CgroupDriver}}' 2>/dev/null)" "systemd"
  forvanta "cgroup-version" "$(docker info --format '{{.CgroupVersion}}' 2>/dev/null)" "2"
  forvanta "lagringsdrivrutin" "$(docker info --format '{{.Driver}}' 2>/dev/null)" "overlay2"
  forvanta "live-restore" "$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null)" "true"
  forvanta "standardruntime" "$(docker info --format '{{.DefaultRuntime}}' 2>/dev/null)" "runc"
  forvanta "loggdrivrutin" "$(docker info --format '{{.LoggingDriver}}' 2>/dev/null)" "json-file"
  forvanta "Dockers rotkatalog (userns-remap ⇒ underkatalog per id-intervall)" \
    "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" "/var/lib/docker/${DOCKREMAP_SUBID_BASE}.${DOCKREMAP_SUBID_BASE}"
  forvanta "icc på standardbryggan" \
    "$(docker network inspect bridge --format '{{index .Options "com.docker.network.bridge.enable_icc"}}' 2>/dev/null)" "false"

  local runtimes
  runtimes="$(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null)"
  if (( INSTALL_GVISOR )); then
    if [[ " $runtimes " == *" runsc "* ]]; then ok "runtime runsc är registrerad"; else fel "runsc ska finnas (INSTALL_GVISOR=1) men saknas: ${runtimes}"; fi
  elif [[ " $runtimes " == *" runsc "* ]]; then
    obs "runsc är registrerad fast INSTALL_GVISOR=0"
  fi

  # Containrar som kör utan skydden — det är så en avdrift i compose-filen syns.
  local c
  while read -r c; do
    [[ -n "$c" ]] || continue
    fel "container med farliga inställningar: ${c}"
  done < <(docker ps -q 2>/dev/null | xargs -r docker inspect --format \
    '{{.Name}} privileged={{.HostConfig.Privileged}} userns={{.HostConfig.UsernsMode}} net={{.HostConfig.NetworkMode}} pid={{.HostConfig.PidMode}}' 2>/dev/null \
    | grep -E 'privileged=true|userns=host|net=host|pid=host' || true)

  if (( DOCKER_XFS_LOOP )); then
    forvanta "filsystem under /var/lib/docker" "$(findmnt -no FSTYPE /var/lib/docker 2>/dev/null)" "xfs"
    if findmnt -no OPTIONS /var/lib/docker 2>/dev/null | grep -Eq 'p(rj)?quota'; then ok "projektkvot påslagen på /var/lib/docker"; else fel "projektkvot (pquota) saknas på /var/lib/docker"; fi
  fi
  # docker.service ska vägra starta utan brandvägg.
  if systemctl cat docker.service 2>/dev/null | grep -q 'ExecStartPre=/usr/sbin/nft list table inet vibesandbox'; then
    ok "docker.service kräver laddad brandvägg (ExecStartPre)"
  else
    fel "docker.service saknar spärren mot start utan brandvägg"
  fi
  return 0
}

kontroll_gvisor() {
  (( INSTALL_GVISOR )) || return 0
  rubrik "gVisor"
  if [[ -x /usr/local/bin/runsc ]]; then ok "runsc finns ($(/usr/local/bin/runsc --version 2>/dev/null | head -n1))"; else fel "runsc saknas"; fi
  return 0
}

# Vilka ANDRA filer sätter den här nyckeln? Inga antaganden om namn — alla sysctl-kataloger söks.
sysctl_andra_filer() {
  local nyckel="$1" f ut=""
  for f in /etc/sysctl.conf /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/local/lib/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf; do
    [[ -f "$f" && "$f" != /etc/sysctl.d/zz-vibesandbox.conf ]] || continue
    grep -Eq "^-?${nyckel//./[.]}[[:space:]]*=" "$f" 2>/dev/null && ut+="$(basename "$f") "
  done
  printf '%s' "${ut% }"
}

kontroll_system() {
  rubrik "Kärnparametrar, swap, tid (sysctl, swapon, timedatectl)"
  local par nyckel varde faktiskt andra
  for par in "kernel.kptr_restrict=2" "kernel.yama.ptrace_scope=2" "kernel.dmesg_restrict=1" \
    "kernel.kexec_load_disabled=1" "net.core.bpf_jit_harden=2" "fs.suid_dumpable=0" \
    "net.ipv4.conf.all.rp_filter=2" "net.ipv4.conf.default.rp_filter=2" \
    "net.ipv6.conf.all.forwarding=0" "net.ipv4.conf.all.accept_redirects=0" \
    "net.ipv4.conf.all.send_redirects=0" "net.ipv4.conf.all.accept_source_route=0" \
    "net.ipv4.tcp_syncookies=1" "vm.swappiness=${VM_SWAPPINESS}"; do
    nyckel="${par%%=*}"; varde="${par#*=}"
    faktiskt="$(sysctl -n "$nyckel" 2>/dev/null || echo saknas)"
    andra="$(sysctl_andra_filer "$nyckel")"
    if [[ "$faktiskt" == "$varde" ]]; then
      ok "${nyckel}: ${faktiskt}${andra:+ (sätts också av: ${andra})}"
    else
      fel "${nyckel}: är '${faktiskt}', ska vara '${varde}'${andra:+ — sätts också av: ${andra}}"
    fi
  done
  # En fil som sorteras EFTER vår vinner vid nästa omstart, även om värdena stämmer just nu.
  local var=/etc/sysctl.d/zz-vibesandbox.conf efter="" f
  if [[ -f "$var" ]]; then
    efter="$(
      LC_ALL=C
      for f in /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/local/lib/sysctl.d/*.conf /usr/lib/sysctl.d/*.conf; do
        [[ -f "$f" && "$f" != "$var" && "$(basename "$f")" > "$(basename "$var")" ]] && printf '%s ' "$f"
      done
    )"
    if [[ -n "$efter" ]]; then fel "sysctl-filer som sorteras EFTER vår och vinner vid nästa omstart: ${efter}"; else ok "vår sysctl-fil sorteras sist"; fi
  else
    fel "${var} saknas"
  fi
  local bpf
  bpf="$(sysctl -n kernel.unprivileged_bpf_disabled 2>/dev/null || echo saknas)"
  if [[ "$bpf" == 1 || "$bpf" == 2 ]]; then ok "kernel.unprivileged_bpf_disabled: ${bpf}"; else fel "kernel.unprivileged_bpf_disabled är '${bpf}'"; fi
  if sysctl -n kernel.unprivileged_userns_clone >/dev/null 2>&1; then
    forvanta "kernel.unprivileged_userns_clone" "$(sysctl -n kernel.unprivileged_userns_clone)" "0"
  fi

  if (( SWAPFILE_SIZE_GB > 0 )); then
    local swap prio_fil prio_zram
    swap="$(swapon --show=NAME,PRIO --noheadings 2>/dev/null)"
    prio_fil="$(awk '$1=="/swapfile"{print $2}' <<<"$swap")"
    prio_zram="$(awk '$1 ~ /zram/{print $2; exit}' <<<"$swap")"
    if [[ -z "$prio_fil" ]]; then
      fel "swapfilen /swapfile är inte aktiv"
    elif [[ -n "$prio_zram" ]] && (( prio_fil >= prio_zram )); then
      fel "swapfilen har prioritet ${prio_fil}, inte lägre än zram (${prio_zram})"
    else
      ok "swapfilen är aktiv med prioritet ${prio_fil}${prio_zram:+ (zram: ${prio_zram})}"
    fi
  fi

  if har_kommando timedatectl; then
    forvanta "klockan synkad (NTPSynchronized)" "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" "yes"
  fi
  if har_kommando aa-status || [[ -r /sys/module/apparmor/parameters/enabled ]]; then
    forvanta "AppArmor" "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" "Y"
  fi

  local anvant
  anvant="$(df --output=pcent / 2>/dev/null | tail -n1 | tr -dc '0-9')"
  if [[ -n "$anvant" ]] && (( anvant >= 85 )); then obs "rotfilsystemet är ${anvant} % fullt"; else ok "rotfilsystemet: ${anvant:-?} % använt"; fi
  return 0
}

kontroll_kataloger() {
  rubrik "Kataloger"
  local rad katalog forvantat
  for rad in "${PLATFORM_ROOT}|755 0:0" "${PLATFORM_ROOT}/compose|750 0:0" \
    "${PLATFORM_ROOT}/data|750 ${DATA_UID}:${DATA_UID}" "${PLATFORM_ROOT}/backups|700 0:0"; do
    katalog="${rad%%|*}"; forvantat="${rad#*|}"
    if [[ -d "$katalog" ]]; then
      forvanta "$katalog" "$(stat -c '%a %u:%g' "$katalog")" "$forvantat"
    else
      fel "${katalog} saknas"
    fi
  done
  forvanta "uid för ${DATA_USER}" "$(id -u "$DATA_USER" 2>/dev/null || echo saknas)" "$DATA_UID"
  return 0
}

# ── Huvudprogram ───────────────────────────────────────────────────────────────────────────

main() {
  while (( $# > 0 )); do
    case "$1" in
      --tyst) TYST=1 ;;
      --hoppa-over) HOPPA_OVER="${2:-}"; shift ;;
      --hoppa-over=*) HOPPA_OVER="${1#--hoppa-over=}" ;;
      --lista) printf '%s\n' "${KONTROLLER[@]}"; exit 0 ;;
      --hjalp | --help | -h) anvandning; exit 0 ;;
      *) anvandning >&2; exit 2 ;;
    esac
    shift
  done
  if (( EUID != 0 )); then
    printf '✗ måste köras som root (sshd -T, nft och ss -p kräver det).\n' >&2
    exit 2
  fi
  las_tillstand

  local k
  for k in ${HOPPA_OVER//,/ }; do
    [[ " ${KONTROLLER[*]} " == *" ${k} "* ]] || { printf '✗ okänd kontroll: %s\n' "$k" >&2; exit 2; }
  done
  for k in "${KONTROLLER[@]}"; do
    if [[ ",${HOPPA_OVER}," == *",${k},"* ]]; then
      obs "hoppar över kontrollen '${k}'"
      continue
    fi
    # Uttrycklig växel i stället för "kontroll_${k}": då ser shellcheck att funktionerna används.
    case "$k" in
      uppdateringar) kontroll_uppdateringar ;;
      anvandare) kontroll_anvandare ;;
      tailscale) kontroll_tailscale ;;
      brandvagg) kontroll_brandvagg ;;
      ssh) kontroll_ssh ;;
      portar) kontroll_portar ;;
      leverantor) kontroll_leverantor ;;
      docker) kontroll_docker ;;
      gvisor) kontroll_gvisor ;;
      system) kontroll_system ;;
      kataloger) kontroll_kataloger ;;
    esac
  done

  if (( FEL > 0 )); then
    printf '\n✗ %d avvikelse(r), %d varning(ar).\n' "$FEL" "$VARNINGAR"
    exit 1
  fi
  (( TYST )) || printf '\n✓ Inga avvikelser (%d varning(ar)).\n' "$VARNINGAR"
  exit 0
}

main "$@"
