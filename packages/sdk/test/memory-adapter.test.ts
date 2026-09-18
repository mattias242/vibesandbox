import { describe, expect, it } from 'vitest';
import { createMemoryAdapter } from '../src/index.ts';
import { ANNA, BERTIL, describeAdapterContract, expectSdkError } from './adapter-contract.ts';

describeAdapterContract('minnesadaptern', () => {
  const adapter = createMemoryAdapter();
  return { as: (user) => adapter.asUser(user) };
});

describe('minnesadaptern', () => {
  it('har en lokal standardanvändare, så att en fristående app fungerar utan inloggning', async () => {
    const who = await createMemoryAdapter().whoami();
    expect(who.userId.length).toBeGreaterThan(0);
    expect(who.displayName.length).toBeGreaterThan(0);
  });

  it('kan startas som en viss användare', async () => {
    expect(await createMemoryAdapter({ user: ANNA }).whoami()).toEqual(ANNA);
  });

  it('två adaptrar delar ingenting — varje test får en tom app', async () => {
    await createMemoryAdapter().create('bokningar', 'app', { rum: 'Stora salen' });
    expect((await createMemoryAdapter().list('bokningar', 'app')).documents).toEqual([]);
  });

  it('asUser delar data med ursprungsadaptern', async () => {
    const anna = createMemoryAdapter({ user: ANNA });
    await anna.create('anslag', 'app', { rubrik: 'Fika' });
    expect((await anna.asUser(BERTIL).list('anslag', 'app')).documents).toHaveLength(1);
  });

  it('listar i den ordning dokumenten skapades', async () => {
    const adapter = createMemoryAdapter();
    for (const nummer of [1, 2, 3]) await adapter.create('poster', 'app', { nummer });
    const page = await adapter.list('poster', 'app');
    expect(page.documents.map((doc) => doc.data['nummer'])).toEqual([1, 2, 3]);
  });

  it('avvisar en markör den inte själv har delat ut', async () => {
    const adapter = createMemoryAdapter();
    await adapter.create('poster', 'app', { nummer: 1 });
    await expectSdkError(adapter.list('poster', 'app', { cursor: 'påhittad' }), 'invalid_request');
  });

  it('synligheten förblir låst även när kollektionen har blivit tom', async () => {
    const adapter = createMemoryAdapter();
    const doc = await adapter.create('svar', 'user', { svar: 'Ja' });
    await adapter.remove('svar', doc.id);
    await expectSdkError(adapter.list('svar', 'app'), 'scope_mismatch');
  });

  it('ett returnerat dokument delar inte minne med lagret', async () => {
    const adapter = createMemoryAdapter();
    const doc = await adapter.create('bokningar', 'app', { taggar: ['projektor'] });
    (doc.data['taggar'] as string[]).push('ändrat utifrån');
    const [listed] = (await adapter.list('bokningar', 'app')).documents;
    (listed?.data['taggar'] as string[]).push('ändrat igen');
    expect((await adapter.get('bokningar', doc.id)).data).toEqual({ taggar: ['projektor'] });
  });

  it('ogiltiga kollektionsnamn avvisas, precis som på plattformen', async () => {
    const adapter = createMemoryAdapter();
    await expectSdkError(adapter.create('../hemligt', 'app', { a: 1 }), 'invalid_request');
    await expectSdkError(adapter.list('../hemligt', 'app'), 'invalid_request');
  });
});
