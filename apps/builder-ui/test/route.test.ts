/**
 * Vy-adresser i gränssnittet (#/ och #/app/<id>). Bara en fragment-adress: den når aldrig
 * servern, och ett konstigt värde ger startsidan — aldrig ett gissat app-id.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_HASH, appHash, parseRoute } from '../src/route.ts';

describe('parseRoute', () => {
  it('startsidan', () => {
    for (const hash of ['', '#', '#/', '#/okänd']) expect(parseRoute(hash)).toEqual({ view: 'start' });
  });

  it('en app', () => {
    expect(parseRoute('#/app/01jabcdefghjkmnpqrstvwxyz0')).toEqual({ view: 'app', appId: '01jabcdefghjkmnpqrstvwxyz0' });
  });

  it('fientliga eller konstiga id:n ger startsidan', () => {
    for (const hash of ['#/app/', '#/app/..', '#/app/a/b', '#/app/%2e%2e', '#/app/a%00', '#/app/å', `#/app/${'x'.repeat(100)}`]) {
      expect(parseRoute(hash)).toEqual({ view: 'start' });
    }
  });

  it('appHash är parseRoutes omvändning', () => {
    expect(parseRoute(appHash('abc123'))).toEqual({ view: 'app', appId: 'abc123' });
  });

  it('kontrollrummet', () => {
    expect(parseRoute(ADMIN_HASH)).toEqual({ view: 'admin' });
    expect(ADMIN_HASH).toBe('#/admin');
  });

  it('bara den exakta adressen är kontrollrummet', () => {
    for (const hash of ['#/admin/', '#/admin/appar', '#/Admin', '#/administration']) {
      expect(parseRoute(hash)).toEqual({ view: 'start' });
    }
  });
});
