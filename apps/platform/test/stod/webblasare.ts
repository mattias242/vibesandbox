/**
 * En minimal webbläsare för testerna: skickar förfrågningar till plattformen på 127.0.0.1 med
 * ett eget `Host`, och håller kakor PER VÄRD (host-only, som webbläsaren gör för kakor utan
 * `Domain=`). Följer inga omdirigeringar själv — testerna vill se varje 303.
 *
 * Varje person i ett test har sin egen instans, alltså sin egen kakburk.
 */
import { request } from 'node:http';
import { CSRF_HEADER } from '@vibesandbox/contracts';

export interface Svar {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface Forfragan {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export class Webblasare {
  readonly #port: number;
  readonly #kakor = new Map<string, Map<string, string>>();

  constructor(port: number) {
    this.#port = port;
  }

  /** Kakorna webbläsaren har för en värd (namn → värde). */
  kakor(host: string): ReadonlyMap<string, string> {
    return this.#kakor.get(vardnamn(host)) ?? new Map();
  }

  /** Lägger in en kaka för en värd, som om en annan webbläsare hade lämnat över den. */
  sattKaka(host: string, namn: string, varde: string): void {
    const burk = this.#kakor.get(vardnamn(host)) ?? new Map<string, string>();
    burk.set(namn, varde);
    this.#kakor.set(vardnamn(host), burk);
  }

  skicka(host: string, forfragan: Forfragan = {}): Promise<Svar> {
    const burk = this.#kakor.get(vardnamn(host));
    const kaka = burk === undefined || burk.size === 0 ? undefined : [...burk].map(([n, v]) => `${n}=${v}`).join('; ');
    const body = forfragan.body;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: this.#port,
          method: forfragan.method ?? 'GET',
          path: forfragan.path ?? '/',
          setHost: false,
          headers: {
            Host: host,
            Connection: 'close',
            ...(kaka === undefined ? {} : { Cookie: kaka }),
            ...(body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
            ...forfragan.headers,
          },
        },
        (res) => {
          const bitar: Buffer[] = [];
          res.on('data', (bit: Buffer) => bitar.push(bit));
          res.on('end', () => {
            this.#sparaKakor(host, res.headers['set-cookie']);
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(bitar).toString('utf8') });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  /** En sidnavigering, som när man klickar på en länk eller skriver adressen. */
  oppna(host: string, path = '/', extra: Readonly<Record<string, string>> = {}): Promise<Svar> {
    return this.skicka(host, { path, headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', ...extra } });
  }

  /** Ett HTML-formulär som skickas från värdens egen sida (därav `Origin`). */
  skickaFormular(host: string, path: string, falt: Readonly<Record<string, string>>, origin: string | null): Promise<Svar> {
    return this.skicka(host, {
      method: 'POST',
      path,
      body: new URLSearchParams(falt).toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Mode': 'navigate',
        ...(origin === null ? {} : { Origin: origin }),
      },
    });
  }

  /** Ett `fetch` från en sida: JSON, plattformens skyddshuvud och den angivna `Origin`. */
  api(host: string, method: string, path: string, options: { json?: unknown; origin?: string | null; skyddshuvud?: boolean } = {}): Promise<Svar> {
    const body = options.json === undefined ? undefined : JSON.stringify(options.json);
    return this.skicka(host, {
      method,
      path,
      ...(body === undefined ? {} : { body }),
      headers: {
        Accept: 'application/json',
        'Sec-Fetch-Mode': 'cors',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.skyddshuvud === false ? {} : { [CSRF_HEADER]: '1' }),
        ...(options.origin === undefined || options.origin === null ? {} : { Origin: options.origin }),
      },
    });
  }

  #sparaKakor(host: string, satt: readonly string[] | undefined): void {
    if (satt === undefined) return;
    const burk = this.#kakor.get(vardnamn(host)) ?? new Map<string, string>();
    for (const rad of satt) {
      const [par = '', ...attribut] = rad.split(';').map((del) => del.trim());
      const lika = par.indexOf('=');
      if (lika <= 0) continue;
      const namn = par.slice(0, lika);
      const varde = par.slice(lika + 1);
      if (attribut.some((a) => /^domain=/i.test(a))) throw new Error(`Plattformen satte en kaka med Domain=: ${namn}`);
      const utgangen = attribut.some((a) => /^max-age=0$/i.test(a)) || varde === '';
      if (utgangen) burk.delete(namn);
      else burk.set(namn, varde);
    }
    this.#kakor.set(vardnamn(host), burk);
  }
}

function vardnamn(host: string): string {
  return host.replace(/:[0-9]+$/, '');
}
