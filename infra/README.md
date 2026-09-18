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
| `backup.sh` | *Kommer i skiva 6.* |
| `restore.sh` | *Kommer i skiva 6.* |

Stöds: Debian 13 (målet), Debian 12, Ubuntu 24.04. Allt annat vägras.

> **Inga adresser, domäner, nycklar eller lösenord hör hemma i repot.** Exemplen använder
> `example.org` och dokumentationsnätet `203.0.113.0/24`. Riktiga värden finns bara i
> `provision.env` på servern och i lösenordshanteraren.

---

## Körordning

Ordningen är ett säkerhetskrav: **man får aldrig låsa ute sig, och Docker får aldrig vara
uppe utan brandvägg.** Skriptet upprätthåller den själv, men läs igenom innan du kör.

### 0. Innan du rör servern (manuellt, en gång)

1. **Slå på 2FA på leverantörskontot.** Leverantörens panel kan köra root-skript i gästen via
   `qemu-guest-agent` — kontot *är* root på servern. Inget skript kan göra det här åt dig.
2. Jämför serverns SSH-värdnyckel med den som leverantörens panel visar.
3. Spara i lösenordshanteraren: ett nytt, starkt lösenord för `ops`. Det behövs för `sudo`
   och är **nödvägen** via leverantörens webbkonsol. Skapa hashen på din egen dator:
   `openssl passwd -6` — klartexten ska aldrig hamna på servern.
4. **Tailnet-ACL** (i Tailscales adminkonsol). Servern kör opålitlig kod och ska bara vara
   *nåbar* från tailnetet, aldrig kunna *initiera* trafik in i det:
   - skapa taggen `tag:vibesandbox` med dig själv som `tagOwner`;
   - tillåt `dina enheter → tag:vibesandbox:22`;
   - ha **ingen** regel med `tag:vibesandbox` som källa.

   Tailscales ACL är neka-som-standard, så det sista punkten betyder "lägg inte till en".
   Har tailnetet kvar standardregeln *allow all* måste den bort först. Brandväggen spärrar
   dessutom containrars trafik mot `100.64.0.0/10`, men ACL:en är det som skyddar om själva
   värden tas över.
5. Skapa en **engångs-auth-nyckel**, förtaggad med `tag:vibesandbox`, kort giltighetstid.
   Taggade noder har ingen nyckelutgång — bra, annars faller servern ur tailnetet efter 180 dagar.
6. **DNS**, två poster hos DNS-värden, båda rena DNS-poster (ingen proxy — en DNS-värd som
   också agerar proxy terminerar TLS och hamnar i datavägen, se `docs/adr/0002`):

   | Namn | Typ | Värde |
   |---|---|---|
   | `example.org` | A | `203.0.113.10` |
   | `*.example.org` | A | `203.0.113.10` |

   Wildcard-certifikatet hämtas med DNS-utmaning, så port 80 behövs aldrig. API-nyckeln till
   DNS-värden hör till `compose.yml` (skiva 6), inte hit.

### 1. Fas 1 — uppdatering, driftanvändare, Tailscale

```sh
scp -r infra root@203.0.113.10:/root/vibesandbox-infra        # från din dator
ssh root@203.0.113.10
cd /root/vibesandbox-infra
cp provision.env.example provision.env && chmod 600 provision.env
editor provision.env                                           # nyckel, lösenordshash

./provision.sh --dry-run                                       # läs vad som skulle hända
TAILSCALE_AUTHKEY=tskey-auth-… ./provision.sh                  # nyckeln via miljön, aldrig i fil
```

Skriptet **stannar med flit** efter Tailscale och skriver ut vad du ska göra. Behåll
root-sessionen öppen.

### 2. Bevisa att vägen in via tailnetet fungerar

Från din egen dator, i en ny terminal:

```sh
ssh ops@<värd>          # MagicDNS-namnet, eller tailnet-adressen
sudo -v                      # lösenordet ska fungera
```

### 3. Fas 2 — körs FRÅN tailnet-sessionen

```sh
cd /root/vibesandbox-infra   # via sudo -i, eller kopiera katalogen till ops
sudo ./provision.sh --bekrafta-tailscale-ssh
```

Skriptet kräver både flaggan **och** att det just nu finns en etablerad SSH-session från
`100.64.0.0/10` — flaggan är ett löfte, sessionen är ett bevis.

Två steg har **död mans grepp**: efter att brandväggen laddats och efter att sshd laddats om
frågar skriptet efter `JA`. Öppna då en *ny* terminal och kontrollera att du kommer in. Svarar
du inte inom 3 minuter — eller har sessionen dött — **ångras ändringen automatiskt** och
root-låsningen görs aldrig. Svara inte JA på känn.

### 4. Kontrollera

```sh
sudo /usr/local/sbin/vibesandbox-verify
```

`✓` rätt, `✗` avvikelse (slutkod 1), `⚠` medvetet val eller något att känna till. Kontrollen
körs sedan varje timme av `vibesandbox-verify.timer`; avvikelser syns i
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
steg körs klart även om SSH-sessionen dör.

| Steg | Gör |
|---|---|
| `uppdatering` | `full-upgrade`; **avmaskar** det som behövs (apt-timrarna, `unattended-upgrades` m.fl.) och redovisar allt annat som är maskat; säkerhetsuppdateringar + omstart 04:00 |
| `anvandare` | `ops`: sudo, **inte** docker-gruppen; nyckel och lösenordshash från konfigurationen |
| `tailscale` | förråd med fingeravtryckskontroll; `tailscale up` med nyckeln via fil i `/run` |
| `brandvagg` | nftables `inet vibesandbox`: INPUT drop, FORWARD drop, SSH bara på `tailscale0`, spärrar för containrar |
| `ssh` | dropin `0-0-vibesandbox.conf` som sorteras först, Include-raden först i `sshd_config`; `sshd -t` + `sshd -T` före omladdning; låser roots lösenord |
| `leverantor` | cloud-init: egen sist sorterad fil, kontroll av det **sammanslagna** resultatet; ev. härdad gästagent |
| `dockerdisk` | valfri XFS-volym för `/var/lib/docker` |
| `gvisor` | valfri `runsc` med kontrollsumma |
| `docker` | Dockers förråd, `daemon.json`, `dockremap` med låsta id:n; vägrar utan laddad brandvägg |
| `system` | sysctl (egen sist sorterad fil, kontroll med `sysctl -n`, redovisar andra filer som sätter samma nycklar), swapfil, LLMNR av, tidssynk |
| `kataloger` | `/srv/vibesandbox/{compose,data,backups}` |
| `overvakning` | installerar `verify.sh` + timer |

---

## Nödvägen — om du låser ute dig

1. Logga in på leverantörens panel (2FA) och öppna **webbkonsolen** (VNC/seriell).
2. Logga in som `ops` med lösenordet från lösenordshanteraren. (Root är låst; `sudo -i` ger root.)
3. Beroende på vad som gått fel:

   ```sh
   sudo tailscale status                                  # är tailnetet uppe?
   sudo nft delete table inet vibesandbox                 # brandväggen bort TILLFÄLLIGT
   sudo rm /etc/ssh/sshd_config.d/0-0-vibesandbox.conf && sudo systemctl reload ssh
   ```

   Stoppa Docker (`sudo systemctl stop docker docker.socket`) **innan** du tar bort
   brandväggen — utan den står publicerade portar öppna.
4. Rätta felet och kör om `provision.sh` med `--hoppa-over-sessionskontroll`
   (från konsolen finns ingen SSH-session att hitta).

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
4. `restore.sh` (skiva 6) lägger tillbaka `data/` och `compose/`.
5. Peka om de två DNS-posterna. Sänk TTL dagen före.
6. När den nya värden har tagit över: ta bort den gamla noden ur tailnetet och säg upp den gamla värden.

Ingenting annat ska behövas. Behövs något annat är det en bugg i `provision.sh`.

**Ubuntu:** molnavbilder har en standardanvändare `ubuntu` med lösenordsfri sudo.
`verify.sh` flaggar den som avvikelse; ta bort den (`userdel -r ubuntu`) när `ops` fungerar.

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
| sshd | `0-0-vibesandbox.conf` sorteras **först** (första förekomsten vinner) och `Include` står före alla direktiv i `sshd_config` | `sshd -T` | avvikelse i `sshd -T`, *någon* dropin som sorteras före vår (även en ofarlig), eller att Include-raden inte står först |
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

`compose.yml`, `backup.sh`, `restore.sh`, egress-proxyn och larm ut ur värden. Krav som redan
är kända och inte får tappas bort:

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
går att publicera; egress-proxyn enligt TODO ovan.

---

## Tester

```sh
infra/test/kor-tester.sh                    # alla scenarier, Debian 13, ~2 min
BAS=debian:12 infra/test/kor-tester.sh      # även ubuntu:24.04
infra/test/kor-tester.sh fas2 angra         # enskilda scenarier
infra/test/tung-docker.sh                   # riktig Docker + riktig brandvägg, ~5 min, kräver nät
```

Allt körs i lokala engångscontainrar (`docker run --rm`); inget rör en server.
`shellcheck` körs i containern, så det behöver inte finnas på din dator.

| Scenario | Visar |
|---|---|
| `statisk` | `bash -n`, shellcheck, inga riktiga IP-adresser, nycklar eller leverantörsnamn i `infra/` |
| `vagran` | vägrar utan root / fel OS / skrivbar env-fil; **ordningen**: ingen brandvägg utan bevisad tailnet-session, ingen Docker utan brandvägg, ingen SSH-härdning om `ops` inte kan bli root |
| `dryrun` | `--dry-run` ändrar ingenting (läge, ägare, tid, innehåll) och kör bara läsande kommandon |
| `fas1` | avmaskning före aktivering, `ops`, auth-nyckeln syns aldrig på kommandorad eller disk, fel fingeravtryck ⇒ avbrott; **körs två gånger** |
| `angra` | död mans grepp ångrar brandvägg och SSH (även ändringen i `sshd_config`, byte för byte); en främmande dropin som vinner över vår ⇒ ingen härdning; `sshd_config` utan Include hanteras; trasig konfiguration laddas aldrig |
| `fas2` | riktigt laddade nft-regler, riktig `sshd -T` med leverantörens dropins på plats, riktig cloud-init-sammanslagning; **hela körningen två gånger**; generisk avmaskning; `verify.sh` fångar 14 sorters avdrift, och `provision.sh` läker en omskriven `sshd_config` |
| `flaggor` | `HARDEN_GUEST_AGENT`, `DOCKER_XFS_LOOP` (riktig `mkfs.xfs`), extra/tomma portlistor, gVisor |
| `tung-docker.sh` | Docker installerat från Dockers förråd av skriptet; `dockerd` startar med vår `daemon.json`; paket skickas genom reglerna från ett låtsat internet och ett låtsat tailnet — med kontrollkörning utan tabellen |

**Går inte att testa i en container, och kräver därför extra granskning:** systemd (enheter,
timrar, avmaskning, uppstartsordning `nftables` → `docker`), Tailscale mot ett riktigt tailnet,
`sysctl`, swap, `mount` av XFS-avbilden, cgroup-drivrutinen `systemd`, AppArmor, en riktig
`qemu-guest-agent`, omstart, och en verklig leverantörs filer (testerna använder neutrala
efterbildningar under `test/fixturer/`).
