/**
 * Mejl. Två implementationer av samma lilla gränssnitt:
 *
 * - `createMailgunSender`: Mailguns HTTP-API i EU. Vanlig `fetch`, ingen egen agent och ingen
 *   direkt TCP-anslutning — i drift når plattformen internet ENBART via egress-proxyn, och Nodes
 *   `fetch` följer `HTTPS_PROXY` när `NODE_USE_ENV_PROXY=1`.
 * - `createOutboxSender`: sparar mejlen i minnet (tester) och, om så önskas, som filer i en
 *   katalog (lokal utveckling — där läser man koden).
 *
 * Bara text. Inga länkar med spårning: Mailguns klick- och öppningsspårning stängs av per mejl.
 * Mejlets innehåll loggas aldrig och hamnar aldrig i ett felmeddelande — det innehåller koder.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface MailSender {
  send(message: MailMessage): Promise<void>;
}

export interface MailgunOptions {
  readonly apiKey: string;
  /** Den verifierade avsändardomänen hos Mailgun, t.ex. `mg.example.org`. */
  readonly domain: string;
  /** `Namn <adress>` eller bara adressen. */
  readonly from: string;
  /** Bara EU: personuppgifter (adresser) ska inte lämna EU. */
  readonly region: 'eu';
  /** Standard 10 s. */
  readonly timeoutMs?: number;
  /** För tester. Standard: den globala `fetch`, som följer miljöns proxy. */
  readonly fetch?: typeof fetch;
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Radbrytningar och andra kontrolltecken i ett huvudfält kan bli en extra mottagare hos någon. */
function hasControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** En mottagare, inte en lista: inga kommatecken, semikolon eller vinkelparenteser. */
function assertSingleRecipient(to: string): void {
  if (typeof to !== 'string' || to.length === 0 || to.length > 254 || hasControlCharacters(to) || /[,;<>\s]/.test(to)) {
    throw new Error('Mejlet kunde inte skickas: ogiltig mottagare.');
  }
}

function assertHeaderText(text: string): void {
  if (typeof text !== 'string' || text.length > 998 || hasControlCharacters(text)) {
    throw new Error('Mejlet kunde inte skickas: ogiltigt ämne.');
  }
}

export function createMailgunSender(options: MailgunOptions): MailSender {
  if (options.region !== 'eu') throw new Error('Mailgun: bara regionen eu stöds.');
  if (typeof options.apiKey !== 'string' || options.apiKey.length < 8 || hasControlCharacters(options.apiKey)) {
    throw new Error('Mailgun: API-nyckeln saknas eller är ogiltig.');
  }
  if (typeof options.domain !== 'string' || !DOMAIN_PATTERN.test(options.domain)) {
    throw new Error('Mailgun: avsändardomänen ska vara ett värdnamn i gemener.');
  }
  if (typeof options.from !== 'string' || options.from.length === 0 || hasControlCharacters(options.from)) {
    throw new Error('Mailgun: avsändaren är ogiltig.');
  }

  // Domänen är validerad ovan och kan därför inte ändra sökvägen eller värden i adressen.
  const url = `https://api.eu.mailgun.net/v3/${options.domain}/messages`;
  const authorization = `Basic ${Buffer.from(`api:${options.apiKey}`, 'utf8').toString('base64')}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const from = options.from;
  const doFetch = options.fetch ?? fetch;

  return {
    async send(message) {
      assertSingleRecipient(message.to);
      assertHeaderText(message.subject);

      const body = new URLSearchParams({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        'o:tracking': 'no',
        'o:tracking-clicks': 'no',
        'o:tracking-opens': 'no',
      });

      let status: number;
      try {
        const response = await doFetch(url, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
        status = response.status;
        // Kroppen läses och kastas: den kan eka nyckel eller adress och ska inte hamna någonstans.
        await response.arrayBuffer().catch(() => undefined);
      } catch {
        // Det ursprungliga felet släpps medvetet (ingen `cause`): det kan bära adressen eller,
        // hos vissa proxyfel, huvudena.
        throw new Error('Mejlet kunde inte skickas: ingen kontakt med Mailgun.');
      }
      if (status < 200 || status >= 300) {
        throw new Error(`Mejlet kunde inte skickas: Mailgun svarade ${status}.`);
      }
    },
  };
}

export interface OutboxSender extends MailSender {
  readonly messages: readonly MailMessage[];
  clear(): void;
}

export interface OutboxOptions {
  /** Skriv även varje mejl som en fil här (skapas vid behov, läsbar bara för ägaren). */
  readonly directory?: string;
}

export function createOutboxSender(options: OutboxOptions = {}): OutboxSender {
  const messages: MailMessage[] = [];
  let sequence = 0;
  const directory = options.directory;
  if (directory !== undefined) mkdirSync(directory, { recursive: true, mode: 0o700 });

  return {
    messages,
    clear() {
      messages.length = 0;
    },
    async send(message) {
      assertSingleRecipient(message.to);
      assertHeaderText(message.subject);
      // Synkront, så att mejlet finns i utkorgen innan anroparen ens hunnit vänta på det.
      messages.push({ to: message.to, subject: message.subject, text: message.text });
      if (directory !== undefined) {
        sequence += 1;
        // Namnet byggs av tid, löpnummer och slump — aldrig av något ur mejlet.
        const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
        const name = `${stamp}-${String(sequence).padStart(6, '0')}-${randomBytes(4).toString('hex')}.txt`;
        const text = `Till: ${message.to}\nÄmne: ${message.subject}\n\n${message.text}\n`;
        writeFileSync(join(directory, name), text, { mode: 0o600, flag: 'wx' });
      }
    },
  };
}
