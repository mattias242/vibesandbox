# infra — driftvärden

Allt som behövs för att göra en ny Linux-VPS till driftvärd för vibesandbox. Kravet är
**flyttbarhet**: `provision.sh` på en ny värd + `restore.sh` ska räcka. Därför görs ingenting
för hand på servern — det som inte står i ett skript finns inte efter en flytt.

| Fil | Vad |
|---|---|
| `provision.sh` | Härdar värden och installerar Docker. Idempotent, `--dry-run`, körbar steg för steg. |
| `verify.sh` | Kontrollerar det **faktiska** läget (`sshd -T`, `nft list`, `ss`, `docker info` …). Körs varje timme. |
| `provision.env.example` | Mall för konfigurationen. Kopian `provision.env` är gitignorerad. |
| `test/` | Tester i lokala engångscontainrar. Rör aldrig en server. |
| `compose.yml` | *Kommer i skiva 6* — se [kraven nedan](#kommer-i-skiva-6). |
| `backup.sh` | Säkerhetskopierar `data/` och `compose/`. Konsekvent SQLite-kopia, verifierad, roterad. `--dry-run`. Se [Säkerhetskopiering](#säkerhetskopiering). |
| `restore.sh` | Lägger tillbaka `data/` och `compose/` på en provisionerad värd. Kontrollerar allt före, skriver aldrig över i tysthet. `--dry-run`. |

Stöds: Debian 13 (målet), Debian 12, Ubuntu 24.04. Allt annat vägras.

> **Inga adresser, domäner, nycklar eller lösenord hör hemma i repot.** Exemplen använder
> `example.org` och dokumentationsnätet `203.0.113.0/24`. Riktiga värden finns bara i
> `provision.env` på servern och i lösenordshanteraren.

---

## Körordning

Ordningen är ett säkerhetskrav: **man får aldrig låsa ute sig, och Docker får aldrig vara
uppe utan brandvägg.** Skriptet upprätthåller den själv, men det här är den officiella
körordningen — följ den, i den här ordningen, första gången på en ny värd.

### 0. Innan du rör servern (manuellt, en gång)

1. **Ta en ögonblicksbild (snapshot) i leverantörens panel.** Den är ångervägen om allt annat
   går fel, också sådant som inget skript kan ångra.
2. **Slå på 2FA på leverantörskontot.** Leverantörens panel kan köra root-skript i gästen via
   `qemu-guest-agent` — kontot *är* root på servern. Inget skript kan göra det här åt dig.
3. Jämför serverns SSH-värdnyckel med den som leverantörens panel visar.
4. Spara i lösenordshanteraren: ett nytt, starkt lösenord för `ops`. Det behövs för `sudo`
   och är **nödvägen** via leverantörens webbkonsol. Skapa hashen på din egen dator:
   `openssl passwd -6` — klartexten ska aldrig hamna på servern. **Bara bokstäver a–z/A–Z och
   siffror, hellre långt (24+ tecken):** webbkonsolen skickar tangenter som om tangentbordet vore
   amerikanskt, så `@ - / ( ) { } | < > ;` och å ä ö blir andra tecken där — lösenordet fungerar
   då för `sudo` över SSH men inte i nödvägen. Skriv det för hand i konsolen; inklistring där
   är lika opålitlig.
5. **Tailnet-ACL** (i Tailscales adminkonsol). Servern kör opålitlig kod och ska bara vara
   *nåbar* från tailnetet, aldrig kunna *initiera* trafik in i det:
   - skapa taggen `tag:vibesandbox` med dig själv som `tagOwner`;
   - tillåt `dina enheter → tag:vibesandbox:22`;
   - ha **ingen** regel med `tag:vibesandbox` som källa.

   Tailscales ACL är neka-som-standard, så det sista punkten betyder "lägg inte till en".
   Har tailnetet kvar standardregeln *allow all* måste den bort först. Brandväggen spärrar
   dessutom containrars trafik mot `100.64.0.0/10`, men ACL:en är det som skyddar om själva
   värden tas över.
6. Skapa en **engångs-auth-nyckel**, förtaggad med `tag:vibesandbox`, kort giltighetstid.
   Taggade noder har ingen nyckelutgång — bra, annars faller servern ur tailnetet efter 180 dagar.
7. **DNS**, två poster hos DNS-värden, båda rena DNS-poster (ingen proxy — en DNS-värd som
   också agerar proxy terminerar TLS och hamnar i datavägen, se `docs/adr/0002`):

   | Namn | Typ | Värde |
   |---|---|---|
   | `example.org` | A | `203.0.113.10` |
   | `*.example.org` | A | `203.0.113.10` |

   Wildcard-certifikatet hämtas med DNS-utmaning, så port 80 behövs aldrig. API-nyckeln till
   DNS-värden hör till `compose.yml` (skiva 6), inte hit.

### 1. Kontrollera före körning (på servern, som root, innan fas 1)

Det här går inte att avgöra utan att titta på just den här värden. Inget av det stoppar körningen
— skriptet hanterar fallen — men du ska veta svaret innan du börjar:

| Kontroll | Varför |
|---|---|
| `systemctl is-enabled nftables.service` | Är den `enabled` från början laddas `/etc/nftables.conf` vid *varje* uppstart. Ett ångrat brandväggssteg återställer filen (A3), men det är därför det måste göra det. |
| `tail -c1 /etc/fstab \| od -c` (ska visa `\n`) | En fil utan avslutande radbrytning rättas nu av skriptet, men gör den det inte har du en annan avvikelse att förstå. |
| `cat /etc/subuid /etc/subgid` | Poster som överlappar `100000–165535` (dockremap) stoppar Docker-steget. Bättre att se dem nu. |
| `ls /etc/sudoers.d/; grep -rn NOPASSWD /etc/sudoers /etc/sudoers.d` | Lösenordsfri sudo är avdrift — `verify.sh` larmar. Avbildens standardanvändare (Ubuntu: `ubuntu`) har ofta en sådan. |
| `tailscale version` efter fas 1, och ACL:en ovan | `tailscale up --auth-key=file:` och `--advertise-tags` måste fungera i installerad version och mot din ACL. |
| `resolvectl status` (eller `/etc/resolv.conf`) | Är uppströms-DNS en RFC1918-adress tappar containrar DNS (de spärras mot privata nät). |
| `systemctl is-enabled ssh.socket` (Ubuntu 24.04) | Socketaktiverad sshd: omladdning och lyssnare fungerar annorlunda. Testat bara mot `ssh.service`. |
| `sudo -V \| grep -i use_pty` | Kör fas 2 i `tmux`: då spelar det ingen roll om `/dev/tty` dör när anslutningen gör det. |

Kopiera sedan filerna och fyll i konfigurationen:

```sh
scp -r infra root@203.0.113.10:/root/vibesandbox-infra        # från din dator
ssh root@203.0.113.10
cd /root/vibesandbox-infra
cp provision.env.example provision.env && chmod 600 provision.env
editor provision.env              # din nyckel, din hash — EXEMPEL-värdena avvisas
./provision.sh --dry-run          # läs vad som skulle hända
```

### 2. Fas 1 — uppdatering, driftanvändare, Tailscale (root-sessionen ÖPPEN)

```sh
./provision.sh                    # frågar efter auth-nyckeln — dold inmatning
```

Auth-nyckeln ges **aldrig** på kommandoraden eller i miljön — där hamnar den i `ps`, sudo-loggen,
skalhistoriken och varje barnprocess; skriptet vägrar om `TAILSCALE_AUTHKEY` är satt. Antingen svarar du på frågan, eller så
lägger du nyckeln i en rootägd fil med läge 600 och sätter `TAILSCALE_AUTHKEY_FILE`; filen
raderas efter lyckad anslutning. Den tillfälliga filen i `/run` som skriptet själv skapar raderas
vad som än händer, också vid Ctrl-C.

Fas 1 stänger **lösenordsinloggning över SSH för `ops`** (en egen dropin, `0-0-0-vibesandbox-ops.conf`)
*innan* `ops` får sitt lösenord — annars vore `ops` ett lösenordsangripbart sudo-konto mot en
publik port 22 i timmarna mellan fas 1 och fas 2. Skriptet **stannar med flit** efter Tailscale.
Behåll root-sessionen öppen.

### 3. Bevisa vägen in — och nödvägen — innan fas 2

Alla tre, från din egen dator:

```sh
ssh ops@<värd>          # 1. MagicDNS-namnet eller tailnet-adressen — med NYCKEL
sudo -v                      # 2. lösenordet ska fungera
```

3. **Logga in som `ops` med lösenordet i leverantörens WEBBKONSOL.** Det är den vägen du har kvar
   om allt annat går fel — pröva den nu, inte då.
4. **Se att journalen har beviset** — i tailnet-sessionen från punkt 1, på servern:

   ```sh
   sudo journalctl -t sshd -t sshd-session _UID=0 | grep Accepted
   ```

   Här ska en rad `Accepted publickey for ops from 100.… port …` stå för din session. Det är
   just den raden fas 2 kräver innan brandväggen rörs. Skriptets tolkning av journalen är
   bara prövad mot en efterbildning (se *OTESTAT*) — syns ingen rad här vägrar fas 2, och då
   vet du varför innan du börjar. (Äldre OpenSSH loggar under `sshd`, nyare under `sshd-session`.)

### 4. Fas 2 — i `tmux`, från tailnet-sessionen

```sh
tmux new -s fas2
sudo -i
cd /root/vibesandbox-infra
./provision.sh --bekrafta-tailscale-ssh
```

Skriptet kräver flaggan, en etablerad SSH-session från `100.64.0.0/10` **och** raden
`Accepted publickey for ops from 100.… port …` i sshd:s journal för just den sessionen —
flaggan är ett löfte, sessionen och journalraden är bevis på att *nyckeln* fungerar.

Två steg har **död mans grepp** (se *Ångra-mekanismen* nedan): efter att brandväggen laddats och
efter att sshd laddats om frågar skriptet efter `JA`. Då:

- öppna en **ny** terminal och logga in (`ssh ops@<värd>`, `sudo -v`) — svara `JA` först
  när det har fungerat;
- **tryck aldrig Ctrl-C vid frågan** för att "prova igen" — det ångrar ändringen (med flit), och
  du får köra om steget;
- använd **aldrig** `--ingen-bekraftelse` mot en riktig server. Flaggan tar bort både frågan
  och backstoppet, och därför låser skriptet aldrig roots lösenord med den: ingen människa
  har då visat att `ops` kommer in. En senare körning utan flaggan litar inte heller på den
  "bekräftelsen" — den ställer frågan igen, och först efter ett riktigt `JA` låses root.
  Flaggan finns för testerna.

Svarar du inte inom 3 minuter, eller dör sessionen, ångras ändringen — och roots lösenord låses
aldrig förrän SSH-steget är bekräftat.

### 5. Kontrollera, starta om, kontrollera igen

```sh
# stäng alla sessioner som INTE går över tailnetet (root-sessionen från steg 1)
sudo /usr/local/sbin/vibesandbox-verify
sudo systemctl reboot
# logga in igen över tailnetet
sudo /usr/local/sbin/vibesandbox-verify
```

Omstarten är en del av körordningen: först efter den vet du att brandväggen laddas vid
uppstart, att Docker väntar på den, och att inget obekräftat låg kvar.

`✓` rätt, `✗` avvikelse (slutkod 1), `⚠` medvetet val eller något att känna till. Ett kommando
som misslyckas eller saknas ger aldrig `✓` — `verify.sh` bedömer slutkod och utdata var för sig.
Kontrollen körs sedan varje timme av `vibesandbox-verify.timer`; avvikelser syns i
`systemctl status vibesandbox-verify` och `journalctl -u vibesandbox-verify`.
**TODO (skiva 6):** larm ut ur värden — låt tjänsten pinga en push-övervakning vid godkänd
körning, så att både en avvikelse och en död värd märks.

### Steg för steg och felsökning

```sh
./provision.sh --lista-steg
sudo ./provision.sh --steg system                 # ett steg, kan köras om hur ofta som helst
sudo ./provision.sh --steg ssh --bekrafta-tailscale-ssh
```

Körningen loggas i `/var/log/vibesandbox-provision.log`. Skriptet ignorerar SIGHUP, så ett
steg körs klart även om SSH-sessionen dör — men JA-frågan kräver en terminal, därav `tmux`.

| Steg | Gör |
|---|---|
| `uppdatering` | `full-upgrade`; **avmaskar** det som behövs (apt-timrarna, `unattended-upgrades` m.fl.) och redovisar allt annat som är maskat; säkerhetsuppdateringar + omstart 04:00 |
| `anvandare` | `ops`: sudo, **inte** docker-gruppen, **inga** underordnade uid/gid; nyckeln kontrolleras (exempelnyckeln avvisas); dropin som stänger lösenord över SSH för `ops` skrivs och verifieras med `sshd -T` **före** lösenordet, som sätts med `chpasswd -e` (hashen på stdin, aldrig i argv) |
| `tailscale` | förråd med fingeravtryckskontroll; `tailscale up --auth-key=file:` med nyckeln ur dold inmatning eller en rootägd 600-fil |
| `brandvagg` | nftables `inet vibesandbox`: INPUT drop, FORWARD drop, SSH bara på `tailscale0`, spärrar för containrar; kandidaten prövas med `nft -c` och skrivs atomiskt; **död mans grepp** |
| `ssh` | dropin `0-0-vibesandbox.conf` som sorteras först, Include-raden först i `sshd_config` (atomiskt, prövat med `sshd -t -f`); `sshd -T` före omladdning; **död mans grepp**; bekräftelsemarkör; låser roots lösenord **bara** i bekräftat läge |
| `leverantor` | cloud-init: egen sist sorterad fil, kontroll av det **sammanslagna** resultatet; ev. härdad gästagent |
| `dockerdisk` | valfri XFS-volym för `/var/lib/docker`; avbilden byggs under annat namn och byter namn först när `mkfs` är klar; fstab-tillägget prövas med `findmnt --verify` före bytet |
| `gvisor` | valfri `runsc`; utan låst `GVISOR_SHA512` avbryts steget |
| `docker` | Dockers förråd, `daemon.json` (validerad som tempfil före bytet), `dockremap` med låsta id:n och kontroll av överlapp i subuid/subgid; vägrar utan laddad brandvägg |
| `system` | sysctl (egen sist sorterad fil, kontroll med `sysctl -n`, redovisar andra filer som sätter samma nycklar), swapfil (byggd under annat namn, kontrollerad med `blkid`), LLMNR av, tidssynk |
| `kataloger` | `/srv/vibesandbox/{compose,data,backups}`; driftsättningens rotsteg `/usr/local/sbin/vibesandbox-driftsatt` och — med `DEPLOY_UTAN_LOSENORD=1` — en sudo-regel som låter `ops` köra JUST det utan lösenord (prövad med `visudo` före bytet). Rotsteget godtar bara en SSH-session från tailnetet. Priset: `ops` nyckel räcker för att lägga ut vad som helst, och en compose-fil kan nå root. |
| `overvakning` | installerar `verify.sh` + timer |

---

## Ångra-mekanismen (död mans grepp)

Brandväggs- och SSH-steget kan låsa ute ägaren. Därför gäller en ändring där bara när ägaren
har svarat `JA` — och **varje annan utgång ångrar den**, också de där skriptet självt inte
hinner göra någonting. Allt nedan sker *före* ändringen:

1. `angra.sh` installeras som `/usr/local/sbin/vibesandbox-angra` och uppstartsenheten
   `vibesandbox-angra-uppstart.service` aktiveras. Går något av det inte görs ingen ändring.
2. En obekräftad ändring från en tidigare, avbruten körning ångras först.
3. En ögonblicksbild av filerna som ska röras läggs i `/etc/vibesandbox/angra/<steg>/`
   (root, läge 700). Fanns filen inte antecknas det, så att ångrandet tar bort den nya.
4. Markören `obekraftad` skrivs, fällorna för INT/TERM/QUIT gäller, och en **transient timer**
   armeras: `systemd-run --on-active=240s vibesandbox-angra <steg>`. Går den inte att armera
   görs ingen ändring.

Sedan görs ändringen och frågan ställs. Tre oberoende utlösare kör samma fristående skript:

| Utlösare | Täcker |
|---|---|
| `provision.sh` självt (EXIT-fällan) | tidsgräns, fel svar, Ctrl-C, SIGTERM, död terminal |
| den transienta timern (240 s, alltså efter skriptets egen tidsgräns på 180 s) | `kill -9`, OOM-dödaren, en tappad anslutning där skriptet hänger |
| uppstartsenheten (före `nftables.service`, `ssh.service` och nätverket) | omstart i fönstret — transienta timrar överlever inte en omstart, markören gör det |

**Markören är auktoriteten**, inte utlösarna: finns den ångras ändringen, saknas den görs
ingenting. `JA` tar bort markören under samma lås som ångra-skriptet håller, så "bekräftat" och
"ångrat" kan aldrig ske samtidigt; hann timern före gäller ångrandet, och skriptet säger det.

Efter `JA` skrivs **bekräftelsemarkörer** — sha256 över filerna så som ägaren bekräftade dem
(`/etc/vibesandbox/brandvagg.bekraftad`, `/etc/vibesandbox/ssh.bekraftad`). Saknas en markör eller
stämmer den inte med filerna på disk (avbruten körning, eller någon har ändrat efteråt) görs hela
kedjan om — `sshd -t`, omladdning, fråga — hur rätt `sshd -T` än ser ut. `passwd -l root` körs
bara i bekräftat läge, och aldrig med `--ingen-bekraftelse`. En ögonblicksbild förbrukas av
ett `JA` eller ett ångrande och kan aldrig återställas av en senare körning.

Ett ångrat brandväggssteg lägger tillbaka `/etc/nftables.conf` **så som den såg ut före
steget** — efter en tidigare bekräftelse är det den senast bekräftade regeluppsättningen, men
**första gången är det paketets standardfil** (den med `flush ruleset`), och fanns ingen fil tas
den nya bort. I kärnan laddas ögonblicksbilden bara om den innehåller vår tabell; annars tas
tabellen bort (hellre öppet än utelåst). Värden står då utan brandvägg tills steget körs igen.

**Ögonblicksbilden synkas till disk innan markören skrivs.** Utan det kan ett strömavbrott
lämna markören men en bild på 0 byte, som uppstartsenheten då skulle kopiera över
`nftables.conf` eller `sshd_config`. Ångra-skriptet vägrar dessutom en tom eller saknad bild
(och en tom originalfil stoppar steget innan något ändras).

**Om ångrandet självt misslyckas** (en bild som inte går att använda, `sshd -t` som underkänner
den återställda konfigurationen, en omladdning som inte går): markören ligger kvar, händelsen
loggas med prioritet `crit` i journalen och skickas med `wall` till alla terminaler, och
ångra-skriptet armerar en **ny** timer som försöker igen var 120:e sekund. Vid uppstart kör det
`sshd -t` (efter att ha skapat `/run/sshd`) och avslutas med fel om den underkänner — enheten
blir då `failed` och har en tidsgräns (`TimeoutStartSec=120`), så att uppstarten aldrig hänger på
den. Se efter med:

```sh
sudo journalctl -p crit -t vibesandbox-angra
systemctl --failed
```

**Timerns klocka startar när den armeras, inte när frågan ställs.** Hänger själva ändringen
(t.ex. `nft -f` eller omladdningen av sshd) längre än tidsgränsen plus marginalen (240 s) kan
timern lösa ut mitt i den och ångra medan skriptet fortfarande arbetar. Skriptet kan då ladda
den *återställda* filen i stället för den nya (första gången: paketets standardfil, med
`flush ruleset`). Markören avgör ändå — ett senare `JA` får beskedet att ändringen redan var
ångrad och steget avbryts — men kontrollera läget med `vibesandbox-verify` och kör om steget.

`vibesandbox-angra` läser ingen konfiguration och ingen miljö, har hårdkodade målsökvägar och
vägrar använda ett underlag som inte ligger i rootägda kataloger med läge 700.

---

## Nödvägen — om du låser ute dig

1. Logga in på leverantörens panel (2FA) och öppna **webbkonsolen** (VNC/seriell).
2. Logga in som `ops` med lösenordet från lösenordshanteraren. (Root är låst; `sudo -i` ger root.)
3. Beroende på vad som gått fel:

   ```sh
   sudo journalctl -p crit -t vibesandbox-angra          # har ett ångrande misslyckats?
   sudo vibesandbox-angra --alla                          # ångra det som INTE är bekräftat
   sudo tailscale status                                  # är tailnetet uppe?
   sudo mv /etc/ssh/sshd_config.d/0-0-vibesandbox.conf /root/ && sudo systemctl reload ssh
   ```

   Brandväggen bort **tillfälligt** — i den här ordningen:

   ```sh
   sudo docker ps -q | xargs -r sudo docker stop          # 1. stoppa CONTAINRARNA
   sudo systemctl stop docker.service docker.socket       # 2. sedan demonen
   sudo nft delete table inet vibesandbox                 # 3. först nu tabellen
   ```

   Utan vår tabell finns ingen INPUT-drop och ingen spärr framför Dockers kedjor, så
   publicerade containerportar står öppna mot internet. Att bara stoppa demonen räcker inte:
   med `live-restore` lever containrarna vidare när `dockerd` stoppas. `vibesandbox-angra
   --alla` stoppar **inte** Docker. Tar den själv bort tabellen (första brandväggssteget, eller
   när den tidigare regeluppsättningen inte går att ladda) medan Docker kör larmar den med
   `crit` — gör då punkt 1–2 ovan, eller ladda en fungerande `/etc/nftables.conf` med `nft -f`.
4. Rätta felet och kör om steget från konsolen. Där finns ingen SSH-session att hitta, så
   båda flaggorna behövs:

   ```sh
   sudo ./provision.sh --steg ssh --bekrafta-tailscale-ssh --hoppa-over-sessionskontroll
   ```

   JA-frågan ställs ändå. Är ögonblicksbilden från steg 0 närmaste vägen tillbaka: använd den.

Med `HARDEN_GUEST_AGENT=1` kan panelen **inte** längre återställa lösenord eller lägga in
nycklar. Då är `ops`-lösenordet den enda nödvägen före leverantörens räddningsläge — tappa inte bort det.

---

## Flytt till en ny värd

1. Beställ värden; gör punkt 0 ovan för den (värdnyckel, ny engångs-auth-nyckel).
   2FA, tailnet-ACL och taggen finns redan.
2. Kopiera `infra/` och **samma** `provision.env` dit. `DOCKREMAP_SUBID_BASE` och
   `PLATFORM_CONTAINER_UID` måste vara oförändrade: de bestämmer vilket uid som äger datat
   på disk (100000 + 10001 = 110001), och det är därför en säkerhetskopia går att lägga
   tillbaka utan `chown`.
3. Fas 1 → verifiera SSH över tailnet → fas 2 → `vibesandbox-verify`.
4. `restore.sh <backupkatalog>` lägger tillbaka `data/` och `compose/`. Den vägrar mot en värd
   som redan har data (`--skriv-over` om du verkligen menar det), och den kontrollerar hela
   säkerhetskopian — manifest, sha256 och `PRAGMA integrity_check` — **innan** den skriver något.
5. Peka om de två DNS-posterna. Sänk TTL dagen före.
6. När den nya värden har tagit över: ta bort den gamla noden ur tailnetet och säg upp den gamla värden.

Ingenting annat ska behövas. Behövs något annat är det en bugg i `provision.sh`.

**Ubuntu:** molnavbilder har en standardanvändare `ubuntu` med lösenordsfri sudo.
`verify.sh` flaggar den som avvikelse; ta bort den (`userdel -r ubuntu`) när `ops` fungerar.

---

## Säkerhetskopiering

```sh
sudo ./backup.sh --dry-run              # vad skulle säkras?
sudo ./backup.sh --behall 14            # ta en kopia, behåll de 14 nyaste (standard 7)
sudo ./restore.sh --kontrollera /srv/vibesandbox/backups/2026-01-31T030000Z
sudo ./restore.sh /srv/vibesandbox/backups/2026-01-31T030000Z
```

Resultatet är en katalog per körning under `/srv/vibesandbox/backups/` (0700 `root:root`,
allt i den 0600/0700 `root`):

| I kopian | Vad |
|---|---|
| `databaser/…` | en konsekvent kopia av varje `*.sqlite` under `data/`, med sökvägen bevarad |
| `filer/` | uppladdningarna och allt annat under `data/` som inte är en databas |
| `compose/` | compose-filerna och `.env` — **alltså driftens hemligheter** |
| `manifest` | version, tidpunkt, värd, körtid, och en rad per databas med sha256 och integritetsresultat |

**Aldrig `cp` av en levande databas.** Plattformen kör SQLite i WAL-läge: de senaste
transaktionerna ligger i `<db>-wal`, inte i huvudfilen. En rå kopia blir i bästa fall gammal
och i värsta fall oläsbar, och det syns först den dag någon försöker återställa. Kopian görs
därför av SQLite självt med `VACUUM INTO`, som tar en läslåsning och skriver en
färdigcheckpointad fil medan plattformen fortsätter arbeta. **Varje kopia prövas sedan med
`PRAGMA integrity_check`**, och en enda underkänd kopia gör att *ingen* säkerhetskopia skrivs
— en halv backup är en fälla. Katalogen byter dessutom namn från `.ofullstandig` först när
manifestet ligger på plats, så en avbruten körning kan aldrig lämna något som ser färdigt ut.

Uppladdningarna kopieras däremot vanligt, och det är ett val: en fil får sitt namn under
`blobs/` först när hela innehållet ligger på disk (atomiskt namnbyte från `tmp/`), så det
finns ingen halv fil att fånga. Halvskrivna `*.tmp` utesluts av samma skäl.

Körtiden för SQLite väljs efter vad värden faktiskt har: `sqlite3` om någon har installerat
den, annars plattformsbilden (`vibesandbox-platform:lokal`, Node 24 med `node:sqlite` — samma
SQLite som skrev filerna), annars `python3`. Vilken som användes står i manifestet.

### Hemligheter — `compose/.env` följer med

Det är ett medvetet beslut. Skälet är kravet den här katalogen finns för: *`provision.sh` på
en ny värd + `restore.sh` ska räcka*. Utan `.env` går stacken inte att starta efter en flytt,
och en säkerhetskopia som kräver att någon minns var resten låg är ingen säkerhetskopia.
Priset är betalbart **på värden**: `backups/` är 0700 `root` och `compose/.env` 0600 `root`,
så den som kan läsa kopian kunde redan läsa originalet.

Priset som **inte** är betalt: i samma stund som en säkerhetskopia lämnar värden bär den
driftens samtliga hemligheter. **Kryptera den innan den kopieras någon annanstans.** Den
kopieringen gör `backup.sh` inte, och ska inte göra.

### Installerad av `provision.sh`

Steget `backup` lägger säkerhetskopieringen på värden — samma krav som hela katalogen finns för:
*det som inte står i ett skript finns inte efter en flytt.*

| På värden | Vad |
|---|---|
| `/usr/local/sbin/vibesandbox-backup` | `backup.sh`, root 0755 |
| `/usr/local/sbin/vibesandbox-restore` | `restore.sh`, root 0755 |
| `/etc/sudoers.d/vibesandbox-backup` | `ops ALL=(root) NOPASSWD: /usr/local/sbin/vibesandbox-backup` (root 0440) |
| `/etc/vibesandbox/backup-pub.asc` | den **publika** krypteringsnyckeln (root 0644 — den är publik) |
| `vibesandbox-backup.timer` | `OnCalendar=*-*-* <BACKUP_TID>:00`, `RandomizedDelaySec=30m`, `Persistent=true` |
| `vibesandbox-backup.service` | `ExecStart=… --behall <BACKUP_BEHALL> --publik-nyckel …` |

Regeln ligger i en **egen** fil — driftsättningens rörs inte — och kandidaten prövas med `visudo`
innan den byts in: en trasig fil i `sudoers.d` stänger av ALL sudo. **Återställningen har med flit
ingen lösenordsfri regel**; den är sällsynt och förstörande. Timern kör som root via systemd, så
sudo-regeln finns för den kopia man tar för hand innan något riskabelt — och för NAS:ens
läsgränssnitt (`--lista`, `--manifest`, `--skicka`).

Inställningar: `INSTALL_BACKUP`, `BACKUP_TID`, `BACKUP_BEHALL`, `BACKUP_MAX_ALDER_TIMMAR`,
`BACKUP_PUBNYCKEL` (se `provision.env.example`). `INSTALL_BACKUP=0` installerar ingenting och tar
bort det som redan ligger där — ett halvt läge (timer utan skript) är sämre än inget.

`verify.sh` kontrollerar varje timme att skripten finns med rätt ägare och läge, att regeln är
exakt vår, att enheterna inte har skrivits om, att timern är aktiverad och schemalagd — och **hur
gammal den nyaste färdiga säkerhetskopian är** (standard 36 h). Det sista är poängen: en timer kan
vara aktiv medan varje körning misslyckas, och det läget upptäcks annars först den dag någon
behöver kopian. Finns ingen kopia alls räknas tiden från när `backup.sh` lades på värden, så en
nyss förberedd värd larmar inte.

### Kryptering och kopian ut ur värden

Kopian krypteras med **gpg** och en publik nyckel. Valet föll på gpg och inte det finare `age`
därför att `provision.sh` redan installerar gnupg (apt-nycklarnas fingeravtryck) — krypteringen vi
hade var ingen alls, och den skulden betalas inte av ännu ett paketberoende.

Asymmetrin är hela poängen: **värden har bara den publika halvan.** Inget nyckelknippe byggs där,
och en värd som tas över kan inte läsa sina egna gamla kopior. `backup.sh` vägrar uttryckligen om
nyckelfilen bär en privat nyckel, och `provision.sh` fångar samma fel innan något installeras.

**Saknas nyckeln vägrar backupen**, med slutkod 2 och före första byten. Tyst klartext är felet vi
bygger bort, och "klartext med varning" betyder slutkod 0 — ett schemalagt jobb som avslutas med 0
larmar ingen. Priset för en vägran är att *dagens* kopia uteblir, inte att gårdagens försvinner.

**NAS:en hämtar, värden skickar aldrig.** Tailnet-ACL:en förbjuder med flit värden att initiera
trafik in i tailnetet — servern kör opålitlig kod och ska vara nåbar, aldrig nående.
`hamta-backup.sh` körs därför på NAS:en och läser över SSH genom `backup.sh --lista/--manifest/
--skicka`. Det gränssnittet lämnar bara ut det **krypterade** arkivet; databaserna, klartexten och
`compose/.env` går inte att nå den vägen. (`rsync` vore enklare men hade krävt en sudo-regel som
gav `ops` läsning av hela värden som root.)

`--prov` på NAS-sidan dekrypterar med den privata nyckeln och kontrollerar integriteten. Det är
värt att köra regelbundet: **en krypterad kopia som ingen kan dekryptera är samma sak som ingen
kopia.**

**Varje säkerhetskopia tar ungefär dubbel plats på värden** — klartext för en lokal återställning
plus det krypterade arkivet för NAS:en. `--behall` styr båda.

Innan hämtningen kan köras skarpt: NAS:ens publika SSH-nyckel måste in i `ops` `authorized_keys`
på värden, och `gpg` måste finnas på DSM för `--prov` (`opkg install gnupg` via Entware).

---

## Designval

### Brandvägg och Docker

**Docker får behålla iptables-bakänden (iptables-nft); våra regler ligger i en egen
nftables-tabell.** Docker 29 har en inbyggd nftables-bakände (`"firewall-backend": "nftables"`),
men den är uttryckligen experimentell och kan ändras mellan utgåvor. På Debian 13 skriver
`iptables` ändå till nf_tables, så allt hamnar i samma kärnmotor.

Det som gör samexistensen robust är en egenskap hos nftables: ett paket måste släppas igenom
av **varje** baskedja på en krok, och ett `drop` i någon av dem är slutgiltigt. Vår tabell är
därför ett yttre skal — `accept` betyder "gå vidare till Dockers kedjor", `drop` betyder stopp.

- **Ingen `flush ruleset`.** Debians standardfil börjar så, och det raderar Dockers och
  Tailscales regler vid varje omladdning. Vi byter bara ut vår egen tabell, atomiskt.
  Av samma skäl är `ExecStop` i `nftables.service` tömd (den kör annars `flush ruleset`).
- **FORWARD drop sätts uttryckligen.** Vissa leverantörers avbilder slår på `ip_forward` och lämnar
  FORWARD på ACCEPT; Docker sätter bara DROP när den själv har slagit på routningen. Utan vår
  policy routar värden trafik mellan internet, containrar och tailnetet. (Testat: se nedan.)
- **Varför inte `DOCKER-USER`?** Den som kan Docker väntar sig att egna regler ligger där.
  Här ligger de i stället i en egen baskedja på forward-kroken med prioritet `filter - 10`,
  alltså *före* Dockers kedjor (prioritet `filter` = 0). Verkan är densamma — ett `drop` hos
  oss är slutgiltigt, ett `accept` lämnar över till Docker — men:
  - `DOCKER-USER` skapas av Docker. Före installationen, och i glappet när Docker startar om,
    finns den inte; vår kedja finns från uppstart (`nftables.service` laddas före nätverket)
    och gör det möjligt att kräva "ingen Docker utan brandvägg";
  - den skrivs med `iptables`, så reglerna måste läggas tillbaka av en egen tjänst efter varje
    Docker-start; vår tabell är en fil som laddas atomiskt;
  - Dockers nftables-bakände har **ingen** `DOCKER-USER` alls — Dockers dokumentation anvisar
    just en egen tabell med lägre prioritetsnummer. Ett byte av bakände kräver alltså ingen
    ändring här.

  `tung-docker.sh` visar att det håller: samma trafik prövas med och utan vår tabell.
- **Inkommande till containrar släpps bara för portar i `PUBLIC_TCP_PORTS`/`PUBLIC_UDP_PORTS`**
  (matchas på porten *före* DNAT). En `ports: "8080:80"` som smyger in i compose-filen blir
  därmed inte nåbar från internet.
- **Containrar når inte:** tailnetet (`100.64.0.0/10`), länklokalt inklusive moln-metadata
  (`169.254.0.0/16`), RFC1918, SMTP (25/465/587) eller värdens egna portar (input-kedjan
  droppar allt från `docker0`/`br-*`). Byggcontainrar ska därutöver ligga på `--internal`-nät;
  det sköter plattformen.
- **`docker.service` har `ExecStartPre=nft list table inet vibesandbox`.** Laddades inte
  brandväggen vid uppstart startar inte Docker.
- **sshd begränsas inte med `ListenAddress`** till tailnet-adressen: sshd skulle vägra starta
  om `tailscale0` inte är uppe vid start. Brandväggen gör jobbet.

### Leverantörsoberoende

Skripten letar aldrig efter en viss leverantörs filer. En flytt till en annan leverantör ska
inte kräva en kodändring, och en leverantör som byter filnamn ska inte kunna lura dem. Mönstret
är detsamma överallt: **en egen fil som vinner på sin placering, kontroll av det faktiska
läget, och utpekande av vilka andra filer som ligger i vägen.**

| Område | Vår fil vinner genom att | Facit | `verify.sh` larmar om |
|---|---|---|---|
| sshd | `0-0-vibesandbox.conf` sorteras **först** (första förekomsten vinner) och `Include` står före alla direktiv i `sshd_config` | `sshd -T` | avvikelse i `sshd -T`, *någon* dropin som sorteras före vår (även en ofarlig — utom vår egen fas 1-fil för `ops`, som i stället kontrolleras på innehållet), att Include-raden inte står först, eller att den **körande** sshd erbjuder något annat än nyckel (provinloggning mot loopback) |
| cloud-init | `zzz-vibesandbox.cfg` sorteras **sist** (sista värdet vinner) | cloud-inits egen sammanslagning | det sammanslagna resultatet, oavsett vilken fil som orsakar det |
| sysctl | `zz-vibesandbox.conf` sorteras **sist** | `sysctl -n` | fel värde (med besked om vilka andra filer som sätter nyckeln), eller en fil som sorteras efter vår |
| systemd | — | `systemctl list-unit-files --state=masked` | att något vi är beroende av är maskat; övrigt maskat redovisas |

Står ett direktiv i `sshd_config` före Include-raden (eller saknas raden) lägger
`provision.sh` Include **först** och kommenterar ut den gamla raden, så att dropins inte läses
två gånger. Andras rader och filer tas aldrig bort — vi vinner över dem i stället, och
ändringen ångras byte för byte om bekräftelsen uteblir.

Känd gräns: **user-data från leverantörens seed går före filerna i `cloud.cfg.d`.** En
ominitiering med `ssh_pwauth: true` i user-data kan vi inte överrösta i cloud-init. Det som då
håller är sshd-dropinen (cloud-init skriver sin ändring i en fil som sorteras efter vår) och
`verify.sh`.

### Docker: `userns-remap` kräver overlay2

Docker 29 använder containerd-bildlagret som standard på nya installationer, och det går
**inte** ihop med `userns-remap`. `daemon.json` låser därför `"storage-driver": "overlay2"`
och `"features": {"containerd-snapshotter": false}` uttryckligen, i stället för att lita på
ett tyst bakåtfall. Håll ögonen på Dockers utgåvenoteringar: den dag grafdrivrutinerna tas
bort måste valet göras om (rootless eller containerd + userns).

`dockremap` skapas av skriptet med **låst** id-intervall (`100000:65536`) i stället för att
Docker väljer. Plattformen ska köra som uid `10001` i sin container (`user: "10001:10001"` i
compose) ⇒ `data/` ägs av `110001` på värden. Systemanvändaren `vibesandbox` finns för att ge
det numret ett namn och hindra att något annat får det.

Inget `nproc` i `default-ulimits`: gränsen räknas per *värd-uid*, och under userns-remap delar
alla containrars root samma uid. Använd `--pids-limit` per container.

### Diskkvot

Roten är ext4, och overlay2 kan bara sätta kvot per container (`--storage-opt size=`) på XFS
med projektkvot. Två skydd, olika syften:

1. **Opålitliga byggen arbetar i tmpfs med `size=`** (plattformen). Det är huvudskyddet: hårt
   tak, försvinner med containern. Priset är RAM — räkna 1–1,5 GB per samtidigt bygge på 4 GB.
2. **`DOCKER_XFS_LOOP=1`** lägger `/var/lib/docker` på en **förallokerad** XFS-avbild med
   `pquota`. Då kan bilder, lager och loggar aldrig fylla roten (och därmed `data/` och
   journalen), och `--storage-opt size=` börjar fungera.

Flaggan är **av som standard** eftersom den är oåterkallelig i praktiken och måste väljas innan
Docker installeras:

| För | Emot |
|---|---|
| Full Docker-disk drabbar inte roten eller plattformens data | Fast storlek: 20 av 50 GB är reserverade även om de står tomma |
| Kvot per container blir möjlig | Loopback ger ett extra lager (dubbel cachning, något långsammare) |
| Förallokerad ⇒ kan inte växa och överraska | Växa kräver `fallocate` + `xfs_growfs`; krympa går inte |
| | En trasig avbild ⇒ Docker startar inte (`nofail` + `ExecStartPre=findmnt`; värden startar ändå) |

Rekommendation: slå på den på en ny värd om leverantören inte kan ge en separat volym — en
riktig blockenhet med XFS är bättre än loopback. Oavsett val varnar `verify.sh` vid 85 % på roten.

### Gästagenten (`HARDEN_GUEST_AGENT`)

Av som standard: panelens lösenordsåterställning och nyckelinläggning fortsätter fungera, men
leverantörskontot är root på servern och kan skriva om SSH-konfigurationen bakom ryggen.
`verify.sh` påminner (`⚠`) vid varje körning och fångar avdriften i `sshd -T`.
På (`=1`): `guest-exec`, filskrivning, lösenordsbyte och nyckelhantering spärras;
avstängning och frysning för ögonblicksbilder fungerar fortfarande.

### gVisor (`INSTALL_GVISOR`)

Av tills spiken om gVisor + `userns-remap` + byggprestanda är gjord. Kräver en låst utgåva
(`GVISOR_RELEASE=ÅÅÅÅMMDD`), aldrig `latest`. Lås även `GVISOR_SHA512`: summan som hämtas från
samma server skyddar bara mot trasig hämtning. Värden saknar `/dev/kvm` ⇒ plattformen `systrap`.

### Versionspinning av Docker och Tailscale — inte nu

Docker och Tailscale installeras från respektive förråd (signeringsnyckelns fingeravtryck
kontrolleras) och följer med i de automatiska uppdateringarna — inte låsta till en version.
Avvägningen:

| Lås versionen | Följ förrådet (valt) |
|---|---|
| samma version på varje värd; en flytt ger exakt samma läge | säkerhetsrättningar (runc, containerd, WireGuard) kommer inom ett dygn |
| en uppgradering är ett medvetet, testat beslut | på en värd som kör opålitlig kod väger en ooppgraderad `runc` tyngre än en oväntad ändring |
| kräver att någon faktiskt följer utgåvorna och flyttar låset | `AUTO_UPGRADE_DOCKER=0` stänger av Dockers automatiska uppgradering inför en större version |

Tas upp igen när det finns en testmiljö som kan köra en ny version före produktionen.

### Värdens egen utgående trafik — TODO

Gjort nu: värden kan inte leverera e-post direkt (tcp/25 avvisas) och containrar är spärrade
enligt ovan. **Inte gjort:** en allowlist för värdens övriga utgående trafik.

Varför inte nu: målen (Berget.ai, Mailgun EU, Let's Encrypt, DNS-API:t, apt- och
Docker-förråden, Tailscale) ligger bakom CDN:er med rörliga adresser. IP-regler håller inte, och
nftables kan inte matcha domännamn. Rätt lösning är en **egress-proxy med domänlista**, och den
hör hemma i `compose.yml` (skiva 6):

- `platform` och `caddy` på ett `--internal`-nät; enda vägen ut är proxyn (`HTTPS_PROXY`),
  som släpper `CONNECT` bara till listade värdnamn;
- värdens apt via samma proxy (`Acquire::https::Proxy`);
- därefter kan output-kedjan stängas: bara proxyns uid, `tailscaled` och DNS mot resolvern
  får ut (`meta skuid`), allt annat loggas och droppas.

Tailscale är undantaget som inte går via en proxy (UDP, STUN, DERP) — det får en uid-regel.

---

## Kommer i skiva 6

`compose.yml`, egress-proxyn och larm ut ur värden. `backup.sh` och `restore.sh` finns
([Säkerhetskopiering](#säkerhetskopiering)) men installeras inte av `provision.sh` — det som
återstår för dem är en sudo-regel, en timer, och **en kopia ut ur värden**: en säkerhetskopia
som bara ligger kvar på maskinen överlever inte att maskinen gör det. Krav som redan är kända
och inte får tappas bort:

**Reverse-proxyn framför plattformen** (gatewayn avgör vilken app en förfrågan hör till enbart
ur `Host`, så proxyn får inte ge den något annat att gå på):

- skicka `Host` **oförändrat** till plattformen;
- **neka absolut mål-URL** i förfrågningsraden (`GET http://annan.example.org/ HTTP/1.1`) —
  annars kan rad och `Host` säga olika saker;
- **kortare keepalive mot plattformen än plattformens 5 s**, så att proxyn aldrig återanvänder
  en anslutning som plattformen just stänger;
- varken **lägga till eller lita på `X-Forwarded-Host`**.

**DNS:** de två posterna (apex och wildcard) ska vara rena DNS-poster. Ingen proxy hos
DNS-värden — då termineras TLS av en tredje part som hamnar i datavägen (`docs/adr/0002`).

**Från det här arbetet:** plattformen kör som `user: "10001:10001"` (se *Docker* ovan);
byggcontainrar på `--internal`-nät med tmpfs och `size=`; bara portarna i `PUBLIC_*_PORTS`
går att publicera; egress-proxyn enligt TODO ovan; en container når **inte** värdens publika
adress (hairpin mot :443 stoppas av brandväggen) — trafik mellan appar och plattformen går på det
interna nätet.

---

## Tester

```sh
infra/test/kor-tester.sh                    # alla scenarier, Debian 13, ~15 min
BAS=debian:12 infra/test/kor-tester.sh      # även ubuntu:24.04
infra/test/kor-tester.sh avbrott verify     # enskilda scenarier
infra/test/kor-tester.sh statisk backup     # bara säkerhetskopieringen
infra/test/tung-docker.sh                   # riktig Docker/brandvägg + riktig systemd, ~10 min, kräver nät
infra/test/tung-docker.sh systemd           # bara ångra-mekanismen med systemd som PID 1
```

Allt körs i lokala engångscontainrar; inget rör en server. `shellcheck` körs i containern, så
det behöver inte finnas på din dator.

| Scenario | Visar |
|---|---|
| `statisk` | `bash -n`, shellcheck, inga riktiga IP-adresser, nycklar eller leverantörsnamn i `infra/` |
| `vagran` | vägrar utan root / fel OS / skrivbar env-fil; **ordningen**: ingen brandvägg utan bevisad tailnet-session, ingen Docker utan brandvägg, ingen SSH-härdning om `ops` inte kan bli root |
| `dryrun` | `--dry-run` ändrar ingenting (läge, ägare, tid, innehåll) och kör bara läsande kommandon |
| `fas1` | avmaskning före aktivering, `ops`, auth-nyckeln syns aldrig på kommandorad eller disk, fel fingeravtryck ⇒ avbrott; **körs två gånger** |
| `angra` | död mans grepp utan terminal ångrar brandvägg och SSH (även `sshd_config`, byte för byte); en främmande dropin som vinner över vår ⇒ ingen härdning; trasig konfiguration laddas aldrig |
| `avbrott` | **A1–A3:** Ctrl-C, SIGTERM och `kill -9` VID frågan (riktig pty); backstoppet körs som timern kör det — tom miljö, `provision.sh` borta, två gånger; uppstartsläget; underlag med fel rättigheter vägras; utan backstopp ingen ändring; JA stoppar timern; en gammal ögonblicksbild återställs aldrig; omkörning efter avbrott ställer frågan igen och låser inte root; ändrad fil efter bekräftelse ⇒ ny bekräftelse |
| `fas2ja` | hela fas 2 med riktiga JA på båda frågorna: två backstopp armeras och stoppas, markörerna skrivs, andra körningen frågar inget |
| `besked` | "ÅNGRAD" och senare varningar/avbrott syns efter tidsgräns (riktig, kortad till 5 s), fel svar, utan terminal och efter ett första JA; `--ingen-bekraftelse` låser aldrig root, och en senare körning utan flaggan frågar igen |
| `angrafel` | ögonblicksbilden synkas före markören (ordningen i anropen); tom eller saknad bild vägras, också vid uppstart; misslyckat ångrande ⇒ `crit` + `wall` + ny timer, som sedan lyckas och stoppas; `sshd -t` i uppstartsläget (skapar `/run/sshd`); låset på fd 8 släpps före ångrandet; `TimeoutStartSec` |
| `inloggning` | **B1–B3:** exempelnyckel och exempelhash avvisas, trasiga hashar avvisas; `ops` lösenord stängs över SSH *före* lösenordet (riktig `sshd -T`, Match-blockets avgränsning); beviset kräver `Accepted publickey for ops` för just den sessionen; nyckeln aldrig ur miljön, aldrig i någon `/proc/*/cmdline`, aldrig kvar i `/run` — inte heller efter SIGTERM/Ctrl-C mitt i `tailscale up` |
| `filer` | **B4–B6, C:** radbrytning/säkerhetskopia/`findmnt --verify` vid tillägg i fstab/subuid/subgid; överlapp mot dockremap; `SSH_PORT` och 22 bland publika portar avvisas; env-filens ägare; `PLATFORM_ROOT`-injektion; halvfärdig XFS-avbild/swapfil; `daemon.json` valideras före bytet; gVisor utan kontrollsumma |
| `verify` | **B7:** varje kontroll med sitt kommando i tre fellägen — tyst, saknas, och *rätt utdata men felkod* — ger aldrig `✓`; provinloggning mot en riktig sshd (en demon som startats med annan konfiguration än filerna fångas); sshd bland lyssnarna; `AuthorizedKeysCommand`; NOPASSWD; 20 körningar i rad med `pipefail` |
| `fas2` | riktigt laddade nft-regler, riktig `sshd -T` med leverantörens dropins, riktig cloud-init-sammanslagning; **hela körningen två gånger**; `verify.sh` fångar 14 sorters avdrift |
| `backupinstall` | **I1–I7:** `provision.sh` installerar backup.sh, restore.sh, sudo-regeln, den publika nyckeln och timern; ops kör säkerhetskopian genom sudo utan lösenord men inte återställningen; två körningar ändrar ingenting; `--dry-run` ändrar ingenting ens när inställningarna säger att filerna skulle skrivas om; sudo-regeln prövas med `visudo` FÖRE bytet och en underkänd kandidat rör aldrig den regel som gäller; driftsättningens regel orörd; `INSTALL_BACKUP=0` städar undan; `verify.sh` fångar saknad fil, fel läge, ändrad regel, omskriven enhet, stoppad och avaktiverad timer — och en säkerhetskopia som blivit för gammal; ett kommando som ljuger (rätt utdata, fel felkod) ger aldrig ✓ |
| `flaggor` | `HARDEN_GUEST_AGENT`, `DOCKER_XFS_LOOP` (riktig `mkfs.xfs`), extra/tomma portlistor, gVisor |
| `backup` | **S1–S7:** en LEVANDE WAL-databas (en skrivare håller anslutningen öppen med `wal_autocheckpoint=0` och skriver under tiden) — en rå `cp` av huvudfilen missar WAL:en, vår kopia gör det inte; integrity_check och en invariant över två tabeller; en databas som inte går att kopiera ⇒ INGEN säkerhetskopia alls; `restore.sh` underkänner en ändrad kopia på sha256 **och** en rätt summerad men trasig kopia på `integrity_check`, samt smuggelgods och saknat manifest; rotationen (`--behall`) rör bara sina egna kataloger; `--dry-run` i båda skripten ändrar ingenting; 0700/0600 `root` genomgående, också på `.env`; återställning på en tom värd ger tillbaka rader, ägare och lägen; `shellcheck` på båda skripten |
| `tung-docker.sh` (docker) | Docker installerat av skriptet; `dockerd` med vår `daemon.json`; paket genom reglerna från ett låtsat internet och tailnet, IPv4 **och IPv6**, TCP och **UDP/443**, **169.254.169.254**, **hairpin mot :443** — med kontrollkörning utan tabellen |
| `tung-docker.sh` (systemd) | systemd som PID 1: den transienta timern armeras och stoppas vid JA; efter `kill -9` löper den ut och ångrar; **omstart** med två obekräftade ändringar ⇒ uppstartsenheten ångrar båda, kör `sshd -t` och är klar före `nftables.service` och `ssh.service`; tidsgränsen 120 s |

### Vad som fortfarande är OTESTAT

Ärligt redovisat — det här kräver extra granskning, eller den första skarpa körningen enligt
körordningen ovan (ögonblicksbild först):

- **Omstartsordningen `nftables` → `docker`** på en riktig värd. Ångra → nftables → ssh är
  prövad med riktig systemd; Docker finns inte i den containern.
- **En riktig VM-omstart** (kärna, cloud-init som kör om, leverantörens avbild). Omstarten i
  testet är en omstart av en container: samma systemd-ordning, men ingen kärna och ingen cloud-init.
- **Tailscale mot ett riktigt tailnet**: `--auth-key=file:` i installerad version, taggen mot ACL:en,
  och att `tailscale0` finns när brandväggen laddas.
- **Ubuntu 24.04 med socketaktiverad sshd** (`ssh.socket`): omladdning och lyssnarkontrollen är
  skrivna för det, men prövade bara mot `ssh.service`.
- **SIGHUP och `/dev/tty` under `sudo` med `use_pty`** när anslutningen dör — därför `tmux`.

**Säkerhetskopiering, kryptering och hämtning — det som inte är prövat**

- **Den riktiga transporten.** Testerna kör värdsidan lokalt i en container. Ledet
  `ssh ops@… sudo -n /usr/local/sbin/vibesandbox-backup` är aldrig kört i sviten: att NAS:ens
  nyckel kommer in som `ops`, att sudo-regeln räcker, och att ACL:en släpper NAS → värd men inte
  tvärtom, är verifierat först när det körts skarpt en gång.
- **Synology själv.** `hamta-backup.sh` är skriven för DSM 7:s verktygsuppsättning men bara körd
  på Debian 13. Busybox-varianterna av `find`, `tar`, `wc` och `sha256sum` är oprövade, och `gpg`
  finns inte på ett oförändrat DSM — `--prov` kräver Entware och har därför aldrig körts på den
  maskin där det ska köras.
- **Att timern faktiskt löper ut och kör.** Testcontainern har ingen systemd: `OnCalendar`,
  `RandomizedDelaySec` och `Persistent` är prövade som filinnehåll. Att systemd godtar
  kalenderuttrycket visar `systemd-analyze calendar` på värden vid första skarpa körningen.
- **Att larmet når någon.** En avvikelse hamnar i journalen för `vibesandbox-verify` och
  ingenstans annars. En för gammal säkerhetskopia upptäcks alltså bara av den som läser
  `systemctl status vibesandbox-verify`.
- **Nyckelrotation.** Byts nyckelparet går gamla arkiv bara att läsa med den gamla privata
  nyckeln. Det finns inget stöd för flera mottagare och ingen rutin för att kryptera om
  historiken — behåll varje gammal privat nyckel så länge arkiv krypterade till den finns kvar.
- **En övertagen värd kan ljuga i manifestet.** Både `--lista` och `arkiv_sha256` kommer från
  värden. Krypteringen skyddar det som redan hämtats och det värden inte kan läsa — den gör inte
  värden betrodd. Försvaret är NAS-sidans egen historik och rotation.
- **Diskutrymme.** Varje kopia bär nu både klartext och krypterat arkiv. Att `--behall` räcker på
  en 50 GB-disk när plattformen har riktig data är inte mätt.
- **Stora datamängder och full disk.** `VACUUM INTO` läser hela databasen och kräver plats för en
  hel kopia. Testets databaser är tiotals kilobyte; tid, utrymme och beteendet mot en disk som tar
  slut är omätt.
- **Journalbeviset** (`Accepted publickey for ops …` för just den sessionen) är bara prövat mot en
  efterbildning av journalen — därför kontrollen i körordningens steg 3.4.
- **SSH-ångrandet via timern med riktig `systemctl reload`**: med riktig systemd prövas bara
  brandväggens timer och SSH-ångrandet vid *uppstart*; timerns SSH-väg (omladdning av en körande
  sshd) är prövad mot en stubb.
- **Ett misslyckat ångrande med riktig systemd**: `systemd-cat -p crit`, `wall` och den nya timern
  (`systemd-run --no-block`, också tidigt i uppstarten) är prövade mot stubbar. Att enheten blir
  `failed` och att tidsgränsen är 120 s är prövat med riktig systemd; ett riktigt misslyckande vid
  uppstart är det inte.
- **Ett riktigt strömavbrott**: att ögonblicksbilden synkas *före* markören är prövat som ordningen
  i anropen, inte med en avbruten disk.
- `sysctl`, swap, `mount` av XFS-avbilden, cgroup-drivrutinen `systemd`, AppArmor, en riktig
  `qemu-guest-agent`, och en verklig leverantörs filer (testerna använder neutrala efterbildningar
  under `test/fixturer/`).
- **Säkerhetskopieringens Docker-väg.** `backup.sh` och `restore.sh` väljer körtid för SQLite i
  ordningen `sqlite3` → plattformsbilden via Docker → `python3`. Testcontainern har varken
  `sqlite3`, Node eller Docker, så **det är `python3`-vägen som körs i testerna** — samma
  SQLite-bibliotek och samma `VACUUM INTO`, men inte samma process. Att `docker run … node -e`
  startar, att containern kör som rätt uid under `userns-remap` och att den kommer åt både
  `data/` och den utlånade målkatalogen är prövat i läsning, inte i körning. Det är den första
  skarpa körningen på värden som visar det — kör `backup.sh --dry-run` först och läs vilken
  körtid den väljer.
- **Att stoppa och starta stacken vid en återställning.** `restore.sh` talar med
  `docker compose` med samma projektnamn och samma filer som driftsättningens rotsteg. I
  testet finns ingen Docker, så bara grenen "ingen stack kör här" är prövad. Att `down`
  verkligen stoppar en körande plattform, och att `up --wait` får igång den efteråt, är inte det.
- **Ett fullt filsystem mitt i en säkerhetskopia.** Att arbetet sker i `.ofullstandig` och byter
  namn först när manifestet är skrivet är prövat som ordning (en trasig databas avbryter, och
  ingen katalog lämnas kvar) — inte med en disk som tar slut mitt i en `VACUUM INTO`.
- **En riktigt stor datamängd.** Testets databaser är några tiotal kilobyte. `VACUUM INTO` läser
  hela databasen och kräver plats för en hel kopia; på en värd med många hyresgäster är det både
  tid och diskutrymme som ingen har mätt än.
- **Hairpin mot :443** är prövad och *stoppas* — en container når inte plattformen via värdens
  publika adress. Det är en följd av att input-kedjan släpper in ingenting från `docker0`/`br-*`;
  plattformen ska nås via det interna nätet (krav till skiva 6).
