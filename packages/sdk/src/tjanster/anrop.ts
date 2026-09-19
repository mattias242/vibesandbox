/**
 * Den gemensamma vägen till plattformstjänsterna (`/_api/<namn>/…`). Varje tjänstemodul i den
 * här katalogen anropar tjänsten genom `callService` och ingenting annat: adressen är alltid
 * relativ till appens egen origin, skrivande anrop bär skyddshuvudet, och fel blir `SdkError`.
 */
import { API_PREFIX, APP_SERVICE_NAME_PATTERN, CSRF_HEADER } from '@vibesandbox/contracts';
import { SdkError } from '../errors.ts';
import { toSdkError } from '../platform-adapter.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Den del av `fetch` som behövs. Webbläsarens `fetch` passar in som den är. */
export type ServiceFetch = (
  url: string,
  init: {
    readonly method: Method;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string | Uint8Array;
    readonly credentials: 'same-origin';
  },
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface ServiceCallOptions {
  readonly json?: unknown;
  readonly bytes?: Uint8Array;
  /** Typen på `bytes`. Standard: `application/octet-stream`. */
  readonly contentType?: string;
  /** Vad som väntas tillbaka. Standard: JSON. */
  readonly expect?: 'json' | 'bytes';
  /** Bara för tester. */
  readonly fetch?: ServiceFetch;
}

/** Vägen efter tjänstens namn: tom, eller `/…` utan `//`, `..`, schema eller omvänt snedstreck. */
const PATH_PATTERN = /^(?:\/[^/?#\\]+)*(?:\?[^#]*)?$/;

function assertSafe(name: string, path: string): void {
  const segments = path.split('?')[0]?.split('/') ?? [];
  if (!APP_SERVICE_NAME_PATTERN.test(name) || !PATH_PATTERN.test(path) || segments.some((s) => s === '..' || s === '.')) {
    throw new SdkError('invalid_request');
  }
}

export async function callService(
  name: string,
  method: Method,
  path: string,
  options: ServiceCallOptions = {},
): Promise<unknown> {
  assertSafe(name, path);
  const doFetch: ServiceFetch = options.fetch ?? ((url, init) => (globalThis as unknown as { fetch: ServiceFetch }).fetch(url, init));

  const headers: Record<string, string> = { accept: options.expect === 'bytes' ? '*/*' : 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  let body: string | Uint8Array | undefined;
  if (options.bytes !== undefined) {
    body = options.bytes;
    headers['content-type'] = options.contentType ?? 'application/octet-stream';
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] = 'application/json';
  }

  let response: Awaited<ReturnType<ServiceFetch>>;
  try {
    response = await doFetch(`${API_PREFIX}/${name}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    throw new SdkError('network');
  }

  if (!response.ok) throw await toSdkError(response);
  if (response.status === 204) return undefined;
  try {
    if (options.expect === 'bytes') {
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
    }
    return await response.json();
  } catch {
    throw new SdkError('internal');
  }
}
