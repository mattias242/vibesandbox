# shellcheck shell=bash
# Scenario 'inloggning' — fönstret mellan fas 1 och fas 2, beviset inför fas 2, och hemligheter.
#
#   B1  beviset ska vara en NYCKELinloggning som ops från tailnetet, inte bara "en session finns";
#       exempelvärdena ur provision.env.example och trasiga hashar avvisas
#   B2  ops får aldrig vara ett lösenordsangripbart sudo-konto mot publik port 22 — dropinen som
#       stänger lösenord för ops skrivs och verkar INNAN lösenordet sätts
#   B3  Tailscale-nyckeln: aldrig från miljön/kommandoraden, aldrig exporterad, aldrig kvar i /run
#
# Source:as av i-container.sh.

OPS_DROPIN=/etc/ssh/sshd_config.d/0-0-0-vibesandbox-ops.conf

# satt_env <VARIABEL> <värde> — byt (eller lägg till) en rad i testets provision.env.
satt_env() {
  sed -i "/^${1}=/d" "${INFRA}/provision.env"
  printf "%s='%s'\n" "$1" "$2" >>"${INFRA}/provision.env"
}

sshd_varde() { # <användare> <direktiv>
  sshd -T -C "user=${1},host=localhost,addr=203.0.113.10" 2>/dev/null | awk -v d="$2" '$1==d{print $2; exit}'
}

# En riktig hash av givet slag, gjord av systemets egen chpasswd (yescrypt går inte med openssl).
riktig_hash() { # <metod> [rundor]
  useradd --no-create-home hashprov >/dev/null 2>&1
  if [[ -n "${2:-}" ]]; then echo 'hashprov:ett-testlosenord' | chpasswd -c "$1" -s "$2"; else echo 'hashprov:ett-testlosenord' | chpasswd -c "$1"; fi
  getent shadow hashprov | cut -d: -f2
  userdel hashprov >/dev/null 2>&1
}

scenario_inloggning() {
  forbered_vard
  local bra_hash
  bra_hash="$(sed -n "s/^OPS_PASSWORD_HASH='\(.*\)'$/\1/p" "${INFRA}/provision.env")"

  # ── B1: exempelvärden och trasiga hashar ─────────────────────────────────────────────────
  test_rubrik "B1: värdena ur provision.env.example avvisas — innan någonting har skapats"
  cp "${INFRA}/provision.env" /tmp/provision.env.bra
  cp "${INFRA}/provision.env.example" "${INFRA}/provision.env"; chmod 600 "${INFRA}/provision.env"
  provision --steg anvandare
  if (( KOD != 0 )) && innehaller "$UT" "EXEMPEL"; then godkand "en orörd kopia av exempelfilen avvisas med besked"; else underkand "exempelfilen godtogs (kod ${KOD})"; visa_vid_fel 1; fi
  pastar_inte "…och ops skapades inte" id ops
  cp /tmp/provision.env.bra "${INFRA}/provision.env"
  # Bara exempelNYCKELN, riktig hash:
  sed -i '/^OPS_SSH_PUBKEY_FILE=/d' "${INFRA}/provision.env"
  grep '^OPS_SSH_PUBKEY=' "${INFRA}/provision.env.example" >>"${INFRA}/provision.env"
  provision --steg anvandare
  if (( KOD != 0 )) && innehaller "$UT" "EXEMPEL"; then godkand "exempelnyckeln avvisas"; else underkand "exempelnyckeln godtogs (kod ${KOD})"; fi
  pastar_inte "…och ops skapades inte" id ops
  cp /tmp/provision.env.bra "${INFRA}/provision.env"
  # Bara exempelHASHEN, riktig nyckel:
  sed -i '/^OPS_PASSWORD_HASH=/d' "${INFRA}/provision.env"
  grep '^OPS_PASSWORD_HASH=' "${INFRA}/provision.env.example" >>"${INFRA}/provision.env"
  provision --steg anvandare
  if (( KOD != 0 )) && innehaller "$UT" "OPS_PASSWORD_HASH"; then godkand "exempelhashen avvisas"; else underkand "exempelhashen godtogs (kod ${KOD})"; fi
  pastar_inte "…och ops skapades inte" id ops
  cp /tmp/provision.env.bra "${INFRA}/provision.env"

  test_rubrik "B1: en hash som inte är en hel \$6\$- eller \$y\$-hash avvisas (annars: ops utan fungerande lösenord, root låst)"
  local dalig
  # shellcheck disable=SC2016  # hasharna ska stå ORDAGRANT
  for dalig in '$6$salt$forkort' "${bra_hash}x" "${bra_hash%?}" '$1$abcdefgh$0123456789abcdefghijkl' "${bra_hash%?}:" '$6$$'"${bra_hash##*\$}" '!' 'klartext-ar-ingen-hash'; do
    satt_env OPS_PASSWORD_HASH "$dalig"
    provision --steg anvandare
    if (( KOD != 0 )) && innehaller "$UT" "OPS_PASSWORD_HASH"; then godkand "avvisas: ${dalig:0:24}…"; else underkand "godtogs: ${dalig:0:24}… (kod ${KOD})"; fi
  done
  pastar_inte "ops skapades inte av något av försöken" id ops
  local y r
  y="$(riktig_hash YESCRYPT)"; r="$(riktig_hash SHA512 10000)"
  if [[ "$y" == "\$y\$"* ]]; then
    satt_env OPS_PASSWORD_HASH "$y"; provision --steg anvandare --dry-run
    if (( KOD == 0 )); then godkand "en riktig yescrypt-hash från systemets chpasswd godtas"; else underkand "riktig yescrypt-hash avvisades"; visa_vid_fel; fi
  else
    godkand "(yescrypt finns inte i den här basens chpasswd — hoppar över: '${y:0:4}')"
  fi
  satt_env OPS_PASSWORD_HASH "$r"; provision --steg anvandare --dry-run
  if [[ "$r" == "\$6\$rounds=10000\$"* ]] && (( KOD == 0 )); then godkand "en riktig \$6\$rounds=…-hash godtas"; else underkand "riktig \$6\$rounds-hash avvisades ('${r:0:20}')"; visa_vid_fel; fi
  cp /tmp/provision.env.bra "${INFRA}/provision.env"

  # ── B2: fönstret mellan fas 1 och fas 2 ──────────────────────────────────────────────────
  test_rubrik "B2: fas 1 stänger lösenordsinloggning för ops INNAN ops får sitt lösenord"
  : >"$ANROP"
  kor_fas1
  if (( KOD == 0 )); then godkand "fas 1 avslutas med 0"; else underkand "fas 1 gav kod ${KOD}"; visa_vid_fel; fi
  local fas1_ut="$UT"
  pastar "dropinen för ops finns" test -f "$OPS_DROPIN"
  pastar "…med läge 600 root" test "$(stat -c '%a %U' "$OPS_DROPIN" 2>/dev/null)" = "600 root"
  if [[ "$(sshd_varde ops passwordauthentication)" == "no" && "$(sshd_varde ops kbdinteractiveauthentication)" == "no" ]]; then
    godkand "sshd -T (user=ops): lösenord och kbd-interactive är AV — trots leverantörens dropins som slår på dem"
  else underkand "sshd -T (user=ops): passwordauthentication=$(sshd_varde ops passwordauthentication) kbdinteractive=$(sshd_varde ops kbdinteractiveauthentication)"; fi
  pastar "sshd laddades om i fas 1 (annars gäller dropinen bara på disk)" grep -q '^systemctl reload ssh' "$ANROP"
  if awk '/lösenordsinloggning för ops/{d=NR} /sätter lösenord för ops/{l=NR} END{exit !(d && l && d<l)}' <<<"$fas1_ut"; then
    godkand "ordningen: dropin skriven och omladdad FÖRE att lösenordet sätts"; else underkand "lösenordet sattes innan lösenordsinloggningen var stängd"; fi

  test_rubrik "B2: Match-blocket är avgränsat till sin fil och vinner över senare Match-block"
  if [[ "$(sshd_varde root passwordauthentication)" == "yes" && "$(sshd_varde root kbdinteractiveauthentication)" == "yes" ]]; then
    godkand "user=root ser fortfarande senare filers GLOBALA direktiv (Match läcker inte ut ur Include-filen)"
  else underkand "Match-blocket fångade direktiv i senare filer: root password=$(sshd_varde root passwordauthentication) kbd=$(sshd_varde root kbdinteractiveauthentication)"; fi
  echo "MaxSessions 3" >/etc/ssh/sshd_config.d/zz-senare-global.conf
  if [[ "$(sshd_varde root maxsessions)" == 3 && "$(sshd_varde ops maxsessions)" == 3 ]]; then godkand "ett globalt direktiv i en senare fil gäller både root och ops"; else underkand "senare globalt direktiv når inte fram"; fi
  printf 'Match all\n\tPasswordAuthentication yes\n' >/etc/ssh/sshd_config.d/zz-match-all.conf
  if [[ "$(sshd_varde ops passwordauthentication)" == "no" ]]; then godkand "ett senare 'Match all' som slår på lösenord vinner INTE över vårt (första träffen gäller)"; else underkand "senare Match all vann"; fi
  find /etc/ssh/sshd_config.d/zz-senare-global.conf /etc/ssh/sshd_config.d/zz-match-all.conf -delete
  pastar "fas 1 rörde inte sshd_config och skrev ingen härdnings-dropin" bash -c '! test -e /etc/ssh/sshd_config.d/0-0-vibesandbox.conf'

  test_rubrik "B2: verkar dropinen inte (t.ex. ingen Include-rad) sätts INGET lösenord"
  userdel -r ops >/dev/null 2>&1; find "$OPS_DROPIN" -delete
  cp /etc/ssh/sshd_config /tmp/sshd_config.orig
  grep -v '^Include' /tmp/sshd_config.orig >/etc/ssh/sshd_config
  provision --steg anvandare
  if (( KOD != 0 )) && innehaller "$UT" "Include"; then godkand "steget avbryts med besked om Include-raden"; else underkand "steget fortsatte fast dropinen inte verkar (kod ${KOD})"; visa_vid_fel 1; fi
  if [[ "$(passwd -S ops 2>/dev/null | awk '{print $2}')" == "P" ]]; then underkand "ops fick ett lösenord fast lösenordsinloggningen står öppen"; else godkand "ops har inget användbart lösenord"; fi
  cp /tmp/sshd_config.orig /etc/ssh/sshd_config
  provision --steg anvandare

  # ── B3 + C: hemligheter ──────────────────────────────────────────────────────────────────
  test_rubrik "B3/C: hashen står aldrig i argv och exporteras aldrig"
  pastar "lösenordet sattes med 'chpasswd -e' (hashen på stdin)" grep -q '^chpasswd -e' "$ANROP"
  pastar_inte "ingen 'usermod -p <hash>'" grep -q '^usermod .*-p' "$ANROP"
  pastar_inte "hashens salt förekommer inte i något anrop" grep -q 'testsalt' "$ANROP"
  pastar_inte "inget barn har sett OPS_PASSWORD_HASH eller TAILSCALE_AUTHKEY i sin miljö" grep -q '^HEMLIGHET-I-MILJON' "$ANROP"
  if [[ "$(passwd -S ops | awk '{print $2}')" == "P" ]]; then godkand "ops har ett användbart lösenord"; else underkand "ops saknar lösenord"; fi

  test_rubrik "B3: nyckeln tas aldrig från miljön"
  find "${STUBBKATALOG}/tillstand/tailscale-uppe" -delete
  : >"$ANROP"
  TAILSCALE_AUTHKEY="tskey-auth-HEMLIG-MILJONYCKEL" provision --steg tailscale
  if (( KOD != 0 )) && innehaller "$UT" "TAILSCALE_AUTHKEY_FILE"; then godkand "TAILSCALE_AUTHKEY i miljön avvisas, med besked om rätt väg"; else underkand "nyckeln togs från miljön (kod ${KOD})"; fi
  pastar_inte "…utan att ansluta" test -e "${STUBBKATALOG}/tillstand/tailscale-uppe"
  pastar_inte "…utan att något barn hann ärva den" grep -q '^HEMLIGHET-I-MILJON' "$ANROP"
  if grep -q 'HEMLIG' <<<"$UT" || grep -rq 'HEMLIG' /var/log 2>/dev/null; then underkand "nyckeln ekades i utskriften eller loggen"; else godkand "nyckeln ekas varken i utskriften eller i loggen"; fi

  test_rubrik "B3: nyckelfilen måste vara en vanlig fil, ägd av root, utan rättigheter för andra"
  printf 'tskey-auth-HEMLIG-FILNYCKEL' >/root/ts.nyckel
  chmod 644 /root/ts.nyckel
  TAILSCALE_AUTHKEY_FILE=/root/ts.nyckel provision --steg tailscale
  if (( KOD != 0 )) && innehaller "$UT" "600"; then godkand "läge 644 avvisas"; else underkand "läge 644 godtogs"; fi
  chmod 600 /root/ts.nyckel; chown nobody /root/ts.nyckel
  TAILSCALE_AUTHKEY_FILE=/root/ts.nyckel provision --steg tailscale
  if (( KOD != 0 )) && innehaller "$UT" "root"; then godkand "annan ägare än root avvisas"; else underkand "fel ägare godtogs"; fi
  chown root /root/ts.nyckel; ln -s /root/ts.nyckel /root/ts.lank
  TAILSCALE_AUTHKEY_FILE=/root/ts.lank provision --steg tailscale
  if (( KOD != 0 )); then godkand "en symbolisk länk avvisas"; else underkand "symbolisk länk godtogs"; fi
  pastar_inte "inget av försöken anslöt" test -e "${STUBBKATALOG}/tillstand/tailscale-uppe"
  : >"$ANROP"
  TAILSCALE_AUTHKEY_FILE=/root/ts.nyckel provision --steg tailscale
  if (( KOD == 0 )) && [[ -e "${STUBBKATALOG}/tillstand/tailscale-uppe" ]]; then godkand "rätt fil ⇒ ansluten"; else underkand "rätt fil gav kod ${KOD}"; visa_vid_fel; fi
  pastar "tailscale fick nyckeln som fil, inte som text" grep -Eq '^tailscale up --auth-key=file:/' "$ANROP"
  pastar_inte "nyckeln syns inte i något anrop" grep -q 'HEMLIG' "$ANROP"
  pastar_inte "engångsnyckelns fil är raderad efter lyckad anslutning" test -e /root/ts.nyckel

  test_rubrik "B3: utan fil frågar skriptet — dold inmatning, ingenting på kommandoraden"
  find "${STUBBKATALOG}/tillstand/tailscale-uppe" -delete
  : >"$ANROP"; echo 2 >"${STUBBKATALOG}/tailscale-up-sov"
  provision_pty "auth-nyckel=>skicka:tskey-auth-HEMLIG-PTYNYCKEL" \
    "ansluter till tailnetet=>kor:sleep 1; n=0; for p in /proc/[0-9]*; do c=\$(tr '\\0' ' ' <\$p/cmdline 2>/dev/null); [[ \$c == *pty-kor.py* ]] && continue; [[ \$c == *PTYNY[C]KEL* ]] && n=\$((n+1)); done; echo cmdline-träffar=\$n; stat -c 'nyckelfil %a %U' /run/vibesandbox-ts.* 2>&1" \
    -- --steg tailscale
  if (( KOD == 0 )) && [[ -e "${STUBBKATALOG}/tillstand/tailscale-uppe" ]]; then godkand "inmatad nyckel ⇒ ansluten"; else underkand "inmatning gav kod ${KOD}"; visa_vid_fel; fi
  # pty-kor.py har nyckeln i sin EGEN kommandorad (den är testets inmatning) och räknas inte; i
  # ögonblicksbildens egen kod står nyckeln som PTYNY[C]KEL, så att den inte träffar sig själv.
  if grep -q 'cmdline-träffar=0' <<<"$UT"; then godkand "ögonblicksbild av /proc/*/cmdline UNDER 'tailscale up': nyckeln står inte i någon process argument"; else underkand "nyckeln syntes i en kommandorad (eller ögonblicksbilden togs aldrig)"; fi
  if grep -q 'nyckelfil 600 root' <<<"$UT"; then godkand "den tillfälliga filen i /run hade 600 root under anropet"; else underkand "den tillfälliga nyckelfilen: $(grep -o 'nyckelfil.*' <<<"$UT" | head -n1)"; fi
  if grep -v '^\[\[' <<<"$UT" | grep -q 'HEMLIG'; then underkand "inmatningen ekades på terminalen"; else godkand "inmatningen ekades inte"; fi
  if grep -rq 'HEMLIG' /var/log /etc "$ANROP" 2>/dev/null; then underkand "nyckeln finns i loggen, i /etc eller i ett anrop"; else godkand "nyckeln finns varken i loggen, i /etc eller i något anrop"; fi
  if compgen -G '/run/vibesandbox-ts.*' >/dev/null; then underkand "nyckelfilen ligger kvar i /run"; else godkand "nyckelfilen i /run är borta efteråt"; fi
  pastar_inte "inget barn såg nyckeln i sin miljö" grep -q '^HEMLIGHET-I-MILJON' "$ANROP"

  test_rubrik "B3: avbruten körning (SIGTERM / Ctrl-C under 'tailscale up') lämnar ingen nyckelfil"
  local s
  for s in "signal:TERM" "ctrlc"; do
    find "${STUBBKATALOG}/tillstand/tailscale-uppe" -delete 2>/dev/null
    echo 3 >"${STUBBKATALOG}/tailscale-up-sov"
    provision_pty "auth-nyckel=>skicka:tskey-auth-HEMLIG-AVBRUTEN" "ansluter till tailnetet=>kor:sleep 1; ls /run/vibesandbox-ts.* >/dev/null 2>&1 && echo nyckelfilen-fanns" "=>${s}" -- --steg tailscale
    if grep -q 'nyckelfilen-fanns' <<<"$UT" && (( KOD != 0 )); then godkand "${s}: avbrottet skedde medan nyckelfilen fanns (kod ${KOD})"; else underkand "${s}: avbrottet träffade inte fönstret (kod ${KOD})"; fi
    if compgen -G '/run/vibesandbox-ts.*' >/dev/null; then underkand "${s}: nyckelfilen ligger KVAR i /run"; else godkand "${s}: ingen nyckelfil finns kvar"; fi
  done
  find "${STUBBKATALOG}/tailscale-up-sov" -delete
  touch "${STUBBKATALOG}/tillstand/tailscale-uppe"

  # ── B1: beviset inför fas 2 ──────────────────────────────────────────────────────────────
  test_rubrik "B1: en session från tailnetet räcker inte — den ska vara en NYCKELinloggning som ops"
  lat_tailnet_session_finnas
  local ratt_rad
  ratt_rad="$(cat "${STUBBKATALOG}/journal")"
  vagrar_utan_bevis() { # <etikett>
    provision --steg brandvagg --bekrafta-tailscale-ssh
    if (( KOD != 0 )) && innehaller "$UT" "Accepted publickey"; then godkand "$1 ⇒ vägrar, med besked om vad som saknas"; else underkand "$1 ⇒ godtogs (kod ${KOD})"; fi
    pastar_inte "  …och ingen tabell laddades" nft list table inet vibesandbox
  }
  : >"${STUBBKATALOG}/journal"
  vagrar_utan_bevis "sessionen finns men journalen saknar inloggningsraden"
  echo "Accepted password for ops from 100.101.102.103 port 51234 ssh2" >"${STUBBKATALOG}/journal"
  vagrar_utan_bevis "sessionen loggade in med LÖSENORD"
  echo "Accepted publickey for root from 100.101.102.103 port 51234 ssh2: ED25519 SHA256:x" >"${STUBBKATALOG}/journal"
  vagrar_utan_bevis "nyckelinloggningen gällde root, inte ops"
  echo "Accepted publickey for ops from 100.101.102.103 port 40000 ssh2: ED25519 SHA256:x" >"${STUBBKATALOG}/journal"
  vagrar_utan_bevis "nyckelinloggningen gällde en ANNAN (avslutad) session än den som pågår"
  echo "Accepted publickey for ops from 198.51.100.7 port 51234 ssh2: ED25519 SHA256:x" >"${STUBBKATALOG}/journal"
  vagrar_utan_bevis "nyckelinloggningen kom från en publik adress"
  echo "$ratt_rad" >"${STUBBKATALOG}/journal"; touch "${STUBBKATALOG}/journalctl-misslyckas"
  vagrar_utan_bevis "journalctl misslyckas (inget bevis går att få fram)"
  find "${STUBBKATALOG}/journalctl-misslyckas" -delete
  provision --steg brandvagg --bekrafta-tailscale-ssh
  if innehaller "$UT" "nyckelinloggning som ${OPS_USER:-ops}" && innehaller "$UT" "laddar tabellen"; then godkand "rätt rad (samma adress OCH port som den pågående sessionen) ⇒ steget går vidare"; else underkand "rätt bevis godtogs inte"; visa_vid_fel 1; fi
}
