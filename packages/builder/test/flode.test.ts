/**
 * Projektets mål i ett test: bygg en todo-lista och dela länken med en vän.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ANNA, anropa, api, publiceraViaGranskning, skapaMiljo, vantaPaJobb } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

it('ny app "En todo-lista" → jobb klart → publicera → dela med en väns adress', async () => {
  const ny = await anropa(m.builder, ANNA, 'POST', api('/apps'), { body: {} });
  expect(ny.status).toBe(201);
  const appId: string = ny.json.appId;

  const meddelande = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/messages`), { body: { text: 'En todo-lista' } });
  expect(meddelande.status).toBe(202);
  const jobb = await vantaPaJobb(m.builder, meddelande.json.jobId);
  expect(jobb.json.status).toBe('done');
  expect(jobb.json.events.map((e: { type: string }) => e.type)).toEqual(['status', 'files', 'check', 'done']);

  const forhand = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}/open`), { query: { target: 'preview' } });
  expect(forhand.status).toBe(200);

  // Publiceringen går via granskningen: ägaren begär, en administratör läser koden och godkänner.
  // Det är den enda vägen ut — ägaren publicerar inte själv.
  await publiceraViaGranskning(m.builder, appId);
  const publishedUrl = `https://${appId}.example.org/`;
  const efterGranskning = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
  expect(efterGranskning.json.review.state).toBe('godkand');
  expect(efterGranskning.json.publishedUrl).toBe(publishedUrl);

  const dela = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'van@example.org' } });
  expect(dela.status).toBe(200);
  expect(dela.json).toEqual({ shared: true });
  expect(m.inbjudningar.inbjudna).toEqual([
    { email: 'van@example.org', role: 'viewer', invitedBy: ANNA, app: { name: 'En todo-lista', url: publishedUrl } },
  ]);

  const detalj = await anropa(m.builder, ANNA, 'GET', api(`/apps/${appId}`));
  expect(detalj.json).toMatchObject({ appId, name: 'En todo-lista', hasDraft: true, published: true, publishedUrl });
});
