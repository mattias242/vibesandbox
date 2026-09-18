/**
 * Tolkning av `Host`-huvudet — den enda uppgift i en förfrågan som får avgöra vilken app den
 * hör till. Ren funktion: ingen I/O, inget tillstånd, går att testa och granska för sig.
 *
 * ALLOWLIST, inte blocklist. Ett värdnamn godtas bara om det i sin HELHET matchar ett av två
 * mönster. Därför finns här medvetet ingen `toLowerCase()`, ingen trimning, ingen IDN- eller
 * punycode-hantering och ingen URL-parser: varje sådan "hjälpsam" normalisering är ett ställe
 * där två olika indata kan bli samma app, eller där vår tolkning kan skilja sig från proxyns.
 * Det som inte matchar exakt är ogiltigt.
 *
 * ADR 0002: `appDomain` och `previewDomain` får vara SAMMA domän. Publicerad app och
 * förhandsvisning skiljs då enbart på prefixet `p-`. Ingen förväxling är möjlig: ett app-id är
 * exakt 26 tecken ur ett alfabet utan bindestreck, så `p-<id>` (28 tecken, med bindestreck) kan
 * aldrig vara ett app-id. Reserverade namn (`bygg`, `login`, `<id>--c`), apex och allt annat
 * faller utanför båda mönstren och är ogiltiga.
 */
import { isAppId } from '@vibesandbox/contracts';
import type { AppId, TenantKind } from '@vibesandbox/contracts';

export interface HostDomains {
  readonly appDomain: string;
  readonly previewDomain: string;
}

export interface ParsedHost {
  readonly appId: AppId;
  readonly kind: TenantKind;
  /** Det validerade värdnamnet utan port. Härlett ur mönstret, aldrig ekat ur indata. */
  readonly hostname: string;
}

export type HostParser = (hostHeader: string | undefined) => ParsedHost | 'ogiltigt';

/** Samma alfabet och längd som `APP_ID_PATTERN` i kontraktet; `isAppId` kontrollerar en gång till. */
const APP_ID_SOURCE = '[0-9a-hjkmnp-tv-z]{26}';

/** Port är tillåten (lokal utveckling, tester) men påverkar aldrig vilken app som väljs. */
const PORT_SOURCE = '(?::[0-9]{1,5})?';

/** Längsta DNS-namn är 253 tecken; plus kolon och fem siffror. Allt längre är skräp. */
const MAX_HOST_HEADER_LENGTH = 253 + 6;

/**
 * Domänerna är konfiguration, inte indata — men ett skrivfel där (versaler, avslutande punkt,
 * blanktecken) skulle tyst ge en gateway som aldrig matchar, eller matchar fel. Hellre ett
 * tydligt fel vid start.
 */
const CONFIG_DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Punkten i en domän ska matcha en punkt, inte "vilket tecken som helst". */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
}

function assertConfigDomain(name: string, value: string): void {
  if (typeof value !== 'string' || !CONFIG_DOMAIN_PATTERN.test(value)) {
    throw new Error(`Ogiltig inställning ${name}: ska vara ett värdnamn i gemener utan port och avslutande punkt.`);
  }
}

/** Bygger tolken en gång vid start. Kastar om domänerna är felkonfigurerade. */
export function createHostParser(domains: HostDomains): HostParser {
  assertConfigDomain('appDomain', domains.appDomain);
  assertConfigDomain('previewDomain', domains.previewDomain);

  // Utan `m`-flagga matchar `$` i JavaScript ENDAST vid strängens slut — inte före en avslutande
  // radbrytning, som i en del andra regex-dialekter.
  const published = new RegExp(`^(${APP_ID_SOURCE})\\.${escapeRegExp(domains.appDomain)}${PORT_SOURCE}$`);
  const draft = new RegExp(`^p-(${APP_ID_SOURCE})\\.${escapeRegExp(domains.previewDomain)}${PORT_SOURCE}$`);

  const build = (id: string | undefined, kind: TenantKind, hostname: string): ParsedHost | 'ogiltigt' =>
    id !== undefined && isAppId(id) ? { appId: id, kind, hostname } : 'ogiltigt';

  return (hostHeader) => {
    if (typeof hostHeader !== 'string') return 'ogiltigt';
    if (hostHeader.length === 0 || hostHeader.length > MAX_HOST_HEADER_LENGTH) return 'ogiltigt';

    const publishedMatch = published.exec(hostHeader);
    if (publishedMatch) return build(publishedMatch[1], 'published', `${publishedMatch[1]}.${domains.appDomain}`);

    const draftMatch = draft.exec(hostHeader);
    if (draftMatch) return build(draftMatch[1], 'draft', `p-${draftMatch[1]}.${domains.previewDomain}`);

    return 'ogiltigt';
  };
}

/** Bekväm engångsform av `createHostParser`, för tester och granskning. */
export function parseHost(hostHeader: string | undefined, domains: HostDomains): ParsedHost | 'ogiltigt' {
  return createHostParser(domains)(hostHeader);
}
