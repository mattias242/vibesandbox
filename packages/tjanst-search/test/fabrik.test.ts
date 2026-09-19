/** Fabriken: inställningar ur SVC_SEARCH_* och Berget, och begripliga fel vid start. */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServiceDependencies, TenantStore } from '@vibesandbox/contracts';
import { createTenantStore } from '@vibesandbox/data-api';
import { factory } from '../src/index.ts';
import { tempKatalog } from './hjalp.ts';

let stada: () => Promise<void>;
let katalog: string;
const butiker: TenantStore[] = [];

beforeEach(async () => {
  ({ katalog, stada } = await tempKatalog());
});
afterEach(async () => {
  for (const butik of butiker.splice(0)) await butik.close();
  await stada();
});

function beroenden(env: Record<string, string | undefined>, berget: AppServiceDependencies['berget'] | null = { baseUrl: 'https://api.example.org/v1', apiKey: 'k' }): AppServiceDependencies {
  const store = createTenantStore({ dataDir: join(katalog, 'data') });
  butiker.push(store);
  return {
    dataDir: join(katalog, 'search'),
    env,
    log: () => {},
    now: () => new Date(),
    members: { members: async () => [] },
    store,
    publishedUrl: () => 'https://x',
    ...(berget === null ? {} : { berget }),
  };
}

describe('factory', () => {
  it('finns och ger tjänsten "search"', async () => {
    expect(factory).toBeDefined();
    const { service } = factory!(beroenden({ SVC_SEARCH_MODEL: 'intfloat/multilingual-e5-large' }));
    expect(service.name).toBe('search');
    await service.close?.();
  });

  it('kastar begripligt utan modell', () => {
    expect(() => factory!(beroenden({}))).toThrow(/SVC_SEARCH_MODEL/);
  });

  it('kastar begripligt utan Berget', () => {
    expect(() => factory!(beroenden({ SVC_SEARCH_MODEL: 'm' }, null))).toThrow(/Berget/);
  });

  it.each([
    ['SVC_SEARCH_TOKENS_PER_APP_DAY', '0'],
    ['SVC_SEARCH_TOKENS_PER_APP_DAY', 'många'],
    ['SVC_SEARCH_MAX_DOCUMENTS', '-1'],
    ['SVC_SEARCH_QUERIES_PER_USER_MINUTE', '1.5'],
    ['SVC_SEARCH_MAX_VECTORS_PER_APP', ''],
  ])('kastar begripligt när %s är %j', (namn, varde) => {
    expect(() => factory!(beroenden({ SVC_SEARCH_MODEL: 'm', [namn]: varde }))).toThrow(new RegExp(namn));
  });
});
