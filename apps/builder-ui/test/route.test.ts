/**
 * Vy-adresser i gränssnittet (#/ och #/app/<id>). Bara en fragment-adress: den når aldrig
 * servern, och ett konstigt värde ger startsidan — aldrig ett gissat app-id.
 */
import { describe, expect, it } from 'vitest';
import { appHash, parseRoute } from '../src/route.ts';

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
});
