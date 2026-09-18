/**
 * Kontraktssvit för StorageAdapter. Körs oförändrad mot varje adapter, så att en app beter
 * sig likadant på plattformen, i tester och som fristående export.
 *
 * Scenarierna följer features/isolering/anvandarscope.feature och kvoter.feature, men ur
 * appens synvinkel: det här är vad SDK:t lovar den genererade koden.
 */
import { describe, expect, it } from 'vitest';
import { DOCUMENT_ID_PATTERN } from '@vibesandbox/contracts';
import type { WhoAmIResponse } from '@vibesandbox/contracts';
import { SdkError } from '../src/index.ts';
import type { SdkErrorCode, StorageAdapter } from '../src/index.ts';

export const ANNA: WhoAmIResponse = { userId: 'user-anna', displayName: 'anna' };
export const BERTIL: WhoAmIResponse = { userId: 'user-bertil', displayName: 'bertil' };

/** En fräsch, tom "app". `as` ger en adapter som agerar som den användaren mot SAMMA data. */
export interface AdapterWorld {
  as(user: WhoAmIResponse): StorageAdapter;
}

export async function expectSdkError(promise: Promise<unknown>, code: SdkErrorCode): Promise<SdkError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error, `förväntade SdkError med kod ${code}`).toBeInstanceOf(SdkError);
  const sdkError = error as SdkError;
  expect(sdkError.code).toBe(code);
  // Meddelandet ska gå att visa för en användare: inte tomt, och inte en rå statuskod.
  expect(sdkError.message.length).toBeGreaterThan(10);
  return sdkError;
}

export function describeAdapterContract(name: string, createWorld: () => AdapterWorld): void {
  describe(`StorageAdapter-kontraktet: ${name}`, () => {
    describe('whoami', () => {
      it('berättar vem som är inloggad, utan e-postadress', async () => {
        const anna = createWorld().as(ANNA);
        expect(await anna.whoami()).toEqual({ userId: 'user-anna', displayName: 'anna' });
      });
    });

    describe('gemensam kollektion', () => {
      it('givet en tom kollektion, när den listas, så är listan tom och saknar markör', async () => {
        const anna = createWorld().as(ANNA);
        const page = await anna.list('bokningar', 'app');
        expect(page.documents).toEqual([]);
        expect(page.nextCursor).toBeUndefined();
      });

      it('när ett dokument sparas, så får det id och tidsstämplar', async () => {
        const anna = createWorld().as(ANNA);
        const doc = await anna.create('bokningar', 'app', { rum: 'Stora salen' });
        expect(doc.id).toMatch(DOCUMENT_ID_PATTERN);
        expect(doc.data).toEqual({ rum: 'Stora salen' });
        expect(Number.isNaN(Date.parse(doc.createdAt))).toBe(false);
        expect(doc.updatedAt).toBe(doc.createdAt);
      });

      it('givet ett sparat dokument, när det hämtas med id, så kommer samma dokument tillbaka', async () => {
        const anna = createWorld().as(ANNA);
        const created = await anna.create('bokningar', 'app', { rum: 'Stora salen', platser: 12 });
        expect(await anna.get('bokningar', created.id)).toEqual(created);
      });

      it('givet att Anna har sparat ett dokument, när Bertil listar, så ser han det', async () => {
        const world = createWorld();
        await world.as(ANNA).create('anslag', 'app', { rubrik: 'Fika fredag' });
        const page = await world.as(BERTIL).list('anslag', 'app');
        expect(page.documents.map((doc) => doc.data)).toEqual([{ rubrik: 'Fika fredag' }]);
      });

      it('när ett dokument ersätts, så försvinner fält som inte skickas med', async () => {
        const anna = createWorld().as(ANNA);
        const created = await anna.create('bokningar', 'app', { rum: 'Stora salen', vem: 'Anna' });
        const replaced = await anna.replace('bokningar', created.id, { rum: 'Lilla salen' });
        expect(replaced.id).toBe(created.id);
        expect(replaced.data).toEqual({ rum: 'Lilla salen' });
        expect(replaced.createdAt).toBe(created.createdAt);
        expect(Date.parse(replaced.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.createdAt));
        expect((await anna.get('bokningar', created.id)).data).toEqual({ rum: 'Lilla salen' });
      });

      it('när ett dokument tas bort, så finns det inte längre', async () => {
        const anna = createWorld().as(ANNA);
        const created = await anna.create('bokningar', 'app', { rum: 'Stora salen' });
        await anna.remove('bokningar', created.id);
        await expectSdkError(anna.get('bokningar', created.id), 'not_found');
        expect((await anna.list('bokningar', 'app')).documents).toEqual([]);
      });

      it('lagrad data påverkas inte av att anroparen ändrar sitt objekt efteråt', async () => {
        const anna = createWorld().as(ANNA);
        const data = { rum: 'Stora salen', taggar: ['projektor'] };
        const created = await anna.create('bokningar', 'app', data);
        data.rum = 'ändrat';
        data.taggar.push('ändrat');
        expect((await anna.get('bokningar', created.id)).data).toEqual({
          rum: 'Stora salen',
          taggar: ['projektor'],
        });
      });
    });

    describe('dokument som inte finns', () => {
      const missingId = '0123456789abcdefghjkmnpqrs';

      it('hämtning ger not_found', async () => {
        const anna = createWorld().as(ANNA);
        await anna.create('bokningar', 'app', { rum: 'Stora salen' });
        await expectSdkError(anna.get('bokningar', missingId), 'not_found');
      });

      it('ersättning ger not_found', async () => {
        const anna = createWorld().as(ANNA);
        await expectSdkError(anna.replace('bokningar', missingId, { rum: 'x' }), 'not_found');
      });

      it('borttagning ger not_found', async () => {
        const anna = createWorld().as(ANNA);
        await expectSdkError(anna.remove('bokningar', missingId), 'not_found');
      });
    });

    describe('personlig kollektion', () => {
      it('givet att Anna har sparat ett svar, när Bertil listar, så är hans lista tom', async () => {
        const world = createWorld();
        await world.as(ANNA).create('svar', 'user', { svar: 'Ja' });
        expect((await world.as(BERTIL).list('svar', 'user')).documents).toEqual([]);
        expect((await world.as(ANNA).list('svar', 'user')).documents).toHaveLength(1);
      });

      it('när Bertil hämtar Annas dokument med dess id, så får han not_found', async () => {
        const world = createWorld();
        const annas = await world.as(ANNA).create('svar', 'user', { svar: 'Ja' });
        await expectSdkError(world.as(BERTIL).get('svar', annas.id), 'not_found');
      });

      it('när Bertil försöker ersätta eller ta bort Annas dokument, så får han not_found och det är orört', async () => {
        const world = createWorld();
        const annas = await world.as(ANNA).create('svar', 'user', { svar: 'Ja' });
        await expectSdkError(world.as(BERTIL).replace('svar', annas.id, { svar: 'Nej' }), 'not_found');
        await expectSdkError(world.as(BERTIL).remove('svar', annas.id), 'not_found');
        expect((await world.as(ANNA).get('svar', annas.id)).data).toEqual({ svar: 'Ja' });
      });
    });

    describe('synligheten låses när kollektionen skapas', () => {
      it('en personlig kollektion kan inte listas som gemensam', async () => {
        const world = createWorld();
        await world.as(ANNA).create('svar', 'user', { svar: 'Ja' });
        await expectSdkError(world.as(BERTIL).list('svar', 'app'), 'scope_mismatch');
      });

      it('en gemensam kollektion kan inte fyllas på som personlig', async () => {
        const world = createWorld();
        await world.as(ANNA).create('anslag', 'app', { rubrik: 'Fika' });
        await expectSdkError(world.as(ANNA).create('anslag', 'user', { rubrik: 'Hemligt' }), 'scope_mismatch');
      });
    });

    describe('gränser', () => {
      it('ett dokument på 300 kB avvisas som för stort', async () => {
        const anna = createWorld().as(ANNA);
        await expectSdkError(anna.create('bokningar', 'app', { text: 'x'.repeat(300 * 1024) }), 'too_large');
      });

      it('långa listor delas upp i sidor som går att följa till slutet', async () => {
        const anna = createWorld().as(ANNA);
        for (let nummer = 1; nummer <= 5; nummer += 1) {
          await anna.create('poster', 'app', { nummer });
        }

        const first = await anna.list('poster', 'app', { limit: 2 });
        expect(first.documents).toHaveLength(2);
        expect(first.nextCursor).toBeTypeOf('string');

        const seen = [...first.documents];
        let cursor = first.nextCursor;
        while (cursor !== undefined) {
          const page = await anna.list('poster', 'app', { limit: 2, cursor });
          seen.push(...page.documents);
          cursor = page.nextCursor;
        }
        expect(seen.map((doc) => doc.data['nummer']).sort()).toEqual([1, 2, 3, 4, 5]);
        expect(new Set(seen.map((doc) => doc.id)).size).toBe(5);
      });

      it('en sida är aldrig större än 100 dokument, vad anroparen än ber om', async () => {
        const anna = createWorld().as(ANNA);
        for (let nummer = 1; nummer <= 101; nummer += 1) {
          await anna.create('poster', 'app', { nummer });
        }
        const page = await anna.list('poster', 'app', { limit: 5000 });
        expect(page.documents).toHaveLength(100);
        expect(page.nextCursor).toBeTypeOf('string');
      });
    });
  });
}
