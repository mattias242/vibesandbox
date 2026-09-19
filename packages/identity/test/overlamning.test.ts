/**
 * Överlämning till förhandsvisningen — ingen ny inloggning i förhandsfönstret.
 *
 *   Givet Anna, inloggad byggare i byggverktyget
 *   När byggverktyget öppnar förhandsvisningen av hennes app
 *   Så är hon inloggad där direkt — utan kod och utan mejl
 *   Och bara på just den värden
 *
 *   Givet en överlämningslänk
 *   När den används en andra gång, på en annan värd, efter en minut, eller från en annan webbplats
 *   Så släpps ingen in — webbläsaren får den vanliga inloggningssidan i stället
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Identity } from '@vibesandbox/contracts';
import { VARD_A, VARD_B, Webblasare, loggaIn, skapaUppsattning, stadaAllt } from './hjalp.ts';
import type { Svar, Uppsattning } from './hjalp.ts';

const ANNA = 'anna@example.org';
const BYGG = 'bygg.localtest.me';

describe('överlämning till förhandsvisningen', () => {
  let u: Uppsattning;
  let byggfliken: Webblasare;
  let anna: Identity;

  beforeEach(async () => {
    u = await skapaUppsattning();
    await u.leverantor.addUser(ANNA, 'builder');
    byggfliken = new Webblasare(u.leverantor);
    await loggaIn(byggfliken, u.utkorg, BYGG, ANNA);
    const vem = await byggfliken.vem(BYGG);
    if (vem === null) throw new Error('Anna kom inte in i byggverktyget.');
    anna = vem;
  });
  afterEach(stadaAllt);

  /** Förhandsfönstret öppnar länken som en navigering från byggverktyget (same-site). `null` = inget Sec-Fetch-Site alls. */
  async function oppna(fonster: Webblasare, lank: string, secFetchSite: string | null = 'same-site'): Promise<Svar | null> {
    const url = new URL(lank);
    return fonster.skicka(url.host, {
      method: 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { cookie: fonster.kakhuvud(url.host), ...(secFetchSite === null ? {} : { 'sec-fetch-site': secFetchSite }) },
    });
  }

  it('ger en länk på förhandsvisningens egen värd, som bär med sig sökvägen', () => {
    const lank = new URL(u.leverantor.handoffUrl(anna, `https://${VARD_A}/lista?x=1`));
    expect(lank.origin).toBe(`https://${VARD_A}`);
    expect(lank.pathname).toBe('/_auth/handoff');
    expect(lank.searchParams.get('t')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('loggar in på förhandsvisningens värd utan kod och utan mejl, och skickar vidare', async () => {
    const mejlFore = u.utkorg.messages.length;
    const forhandsfonster = new Webblasare(u.leverantor);
    const svar = await oppna(forhandsfonster, u.leverantor.handoffUrl(anna, `https://${VARD_A}/lista?x=1`));
    expect(svar?.status).toBe(303);
    expect(svar?.headers['Location']).toBe('/lista?x=1');
    expect((await forhandsfonster.vem(VARD_A))?.email).toBe(ANNA);
    expect(u.utkorg.messages.length).toBe(mejlFore);
  });

  it('gäller bara på den värden länken gjordes för', async () => {
    const lank = new URL(u.leverantor.handoffUrl(anna, `https://${VARD_A}/`));
    const fonster = new Webblasare(u.leverantor);
    const svar = await oppna(fonster, `https://${VARD_B}${lank.pathname}${lank.search}`);
    expect(svar?.status).toBe(303);
    expect(svar?.headers['Location']).toBe('/_auth/login');
    expect(svar?.kakor.some((k) => k.includes('session') && !k.includes('Max-Age=0'))).toBe(false);
    expect(await fonster.vem(VARD_B)).toBeNull();
    // …och sessionen på A gäller aldrig på B.
    await oppna(fonster, u.leverantor.handoffUrl(anna, `https://${VARD_A}/`));
    expect(await fonster.vem(VARD_A)).not.toBeNull();
    expect(await fonster.vem(VARD_B)).toBeNull();
  });

  it('kan bara användas en gång', async () => {
    const lank = u.leverantor.handoffUrl(anna, `https://${VARD_A}/`);
    expect((await oppna(new Webblasare(u.leverantor), lank))?.status).toBe(303);
    const andra = new Webblasare(u.leverantor);
    const svar = await oppna(andra, lank);
    expect(svar?.headers['Location']).toBe('/_auth/login');
    expect(await andra.vem(VARD_A)).toBeNull();
  });

  it('en förbrukad eller gammal länk i en webbläsare som redan är inloggad där leder till appen, inte till inloggningen', async () => {
    // Förhandsfönstret laddas om med samma adress, eller man backar i historiken.
    const fonster = new Webblasare(u.leverantor);
    const lank = u.leverantor.handoffUrl(anna, `https://${VARD_A}/lista`);
    await oppna(fonster, lank);
    const igen = await oppna(fonster, lank);
    expect(igen?.status).toBe(303);
    expect(igen?.headers['Location']).toBe('/');
    expect(igen?.kakor).toEqual([]);
    const gammal = u.leverantor.handoffUrl(anna, `https://${VARD_A}/`);
    u.klocka.flytta(61_000);
    expect((await oppna(fonster, gammal))?.headers['Location']).toBe('/');
  });

  it('gäller i en minut, inte längre', async () => {
    const lank = u.leverantor.handoffUrl(anna, `https://${VARD_A}/`);
    u.klocka.flytta(61_000);
    const fonster = new Webblasare(u.leverantor);
    expect((await oppna(fonster, lank))?.headers['Location']).toBe('/_auth/login');
    expect(await fonster.vem(VARD_A)).toBeNull();
  });

  it('nekas när den öppnas från en annan webbplats, eller utan Sec-Fetch-Site', async () => {
    // En angripare som lurar någon att öppna SIN länk skulle annars logga in offret som angriparen.
    for (const site of ['cross-site', 'none', null]) {
      const fonster = new Webblasare(u.leverantor);
      const svar = await oppna(fonster, u.leverantor.handoffUrl(anna, `https://${VARD_A}/`), site);
      expect(svar?.headers['Location']).toBe('/_auth/login');
      expect(await fonster.vem(VARD_A)).toBeNull();
    }
  });

  it('godtar same-origin (sidan laddas om) och same-site (från byggverktyget)', async () => {
    for (const site of ['same-origin', 'same-site']) {
      const fonster = new Webblasare(u.leverantor);
      await oppna(fonster, u.leverantor.handoffUrl(anna, `https://${VARD_A}/`), site);
      expect(await fonster.vem(VARD_A)).not.toBeNull();
    }
  });

  it('en användare som inte finns får ingen länk, och en annans länk ger ingen annan identitet', async () => {
    const lank = u.leverantor.handoffUrl(anna, `https://${VARD_A}/`);
    const annanAnna: Identity = { ...anna, userId: 'finns-inte-alls-0000' };
    const fonster = new Webblasare(u.leverantor);
    expect(() => u.leverantor.handoffUrl(annanAnna, `https://${VARD_A}/`)).toThrow();
    await oppna(fonster, lank);
    expect((await fonster.vem(VARD_A))?.userId).toBe(anna.userId);
  });

  it('vägrar mål som inte är en vanlig adress med samma schema', () => {
    for (const mal of ['javascript:alert(1)', `http://${VARD_A}/`, `https://anna:x@${VARD_A}/`, 'inte en adress', `https://${VARD_A}/_auth/login`]) {
      expect(() => u.leverantor.handoffUrl(anna, mal)).toThrow();
    }
  });

  it('bara GET — ett formulär som postar till överlämningen avvisas', async () => {
    const svar = await byggfliken.post(VARD_A, '/_auth/handoff', {});
    expect(svar?.status).toBe(405);
  });

  it('loggar överlämningen utan länken', async () => {
    const lank = u.leverantor.handoffUrl(anna, `https://${VARD_A}/`);
    await oppna(new Webblasare(u.leverantor), lank);
    const t = new URL(lank).searchParams.get('t') ?? '';
    expect(u.logg.some((p) => p.event === 'handoff_succeeded')).toBe(true);
    expect(JSON.stringify(u.logg)).not.toContain(t);
  });
});
