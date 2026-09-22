/**
 * Åtkomst per app (features/delning/appatkomst.feature), byggverktygets del:
 *
 *   - den som skapar en app blir dess ägare i control,
 *   - appar från före åtkomstlistan får sin ägare när byggverktyget startar,
 *   - att dela ger adressens användare rollen `user`,
 *   - ägaren listar och tar bort åtkomst; för alla andra "finns" appen inte.
 *
 * CSRF-kravet för DELETE ligger i gatewayn (byggverktyg.ts, `WRITING_METHODS`) — det här lagret
 * nås aldrig av en skrivande förfrågan utan skyddshuvud och `Origin`, och kontrollerar det inte själv.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAM, ANNA, BERTIL, VERA, anropa, api, nyApp, publiceraViaGranskning, skapaMiljo, skicka, vantaPaJobb } from './hjalp.ts';
import type { Miljo } from './hjalp.ts';

let m: Miljo;
beforeEach(async () => {
  m = await skapaMiljo();
});
afterEach(async () => {
  await m.stada();
});

async function publiceradApp(): Promise<string> {
  const appId = await nyApp(m.builder);
  await vantaPaJobb(m.builder, await skicka(m.builder, appId, 'En todo-lista'));
  // Hela vägen ut: ägaren begär, en administratör godkänner. Ingen genväg förbi granskaren.
  await publiceraViaGranskning(m.builder, appId);
  return appId;
}

async function dela(appId: string, email: string): Promise<void> {
  const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email } });
  expect(svar.status).toBe(200);
}

const medlemmar = (appId: string) => api(`/apps/${appId}/members`);
const medlem = (appId: string, memberId: string) => api(`/apps/${appId}/members/${memberId}`);

describe('ägaren', () => {
  it('den som skapar en app blir dess ägare i control, med sin adress', async () => {
    const appId = await nyApp(m.builder);
    expect(m.control.atkomst.get(appId)).toEqual([{ userId: 'u-anna', role: 'owner', email: 'anna@example.org' }]);
  });

  it('går det inte att sätta ägaren skapas ingen app i byggverktyget, och svaret röjer inget', async () => {
    m.control.grantAccess = async () => {
      throw new Error('/srv/control: databasen är låst');
    };
    const svar = await anropa(m.builder, ANNA, 'POST', api('/apps'), { body: {} });
    expect(svar.status).toBe(500);
    expect(svar.text).not.toContain('/srv');
    const lista = await anropa(m.builder, ANNA, 'GET', api('/apps'));
    expect(lista.json.apps).toEqual([]);
  });

  it('appar från före åtkomstlistan får sin ägare när byggverktyget startar — loggen har antal, inga adresser', async () => {
    const forsta = await nyApp(m.builder, ANNA);
    const andra = await nyApp(m.builder, BERTIL);
    // Som före ändringen: control känner apparna men har ingen åtkomstlista.
    m.control.atkomst.clear();
    await m.builder.close();
    m.logg.length = 0;
    m.builder = m.starta();

    // Första förfrågan väntar in tilldelningen.
    const svar = await anropa(m.builder, ANNA, 'GET', medlemmar(forsta));
    expect(svar.status).toBe(200);
    expect(m.control.atkomst.get(forsta)).toEqual([{ userId: 'u-anna', role: 'owner', email: null }]);
    expect(m.control.atkomst.get(andra)).toEqual([{ userId: 'u-bertil', role: 'owner', email: null }]);

    const post = m.logg.find((rad) => rad.event === 'owners_granted_on_startup');
    expect(post).toMatchObject({ level: 'info', count: 2 });
    expect(JSON.stringify(m.logg)).not.toContain('@');
  });

  it('starten är idempotent: befintliga ägare och användare rörs inte', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'bertil@example.org');
    const fore = structuredClone(m.control.atkomst.get(appId));
    await m.builder.close();
    m.builder = m.starta();
    await anropa(m.builder, ANNA, 'GET', medlemmar(appId));
    expect(m.control.atkomst.get(appId)).toEqual(fore);
  });

  it('en app som control inte känner stoppar inte starten; felet loggas utan app-id', async () => {
    const trasig = await nyApp(m.builder);
    const hel = await nyApp(m.builder);
    m.control.atkomst.clear();
    m.control.appar.delete(trasig);
    await m.builder.close();
    m.logg.length = 0;
    m.builder = m.starta();

    const svar = await anropa(m.builder, ANNA, 'GET', medlemmar(hel));
    expect(svar.status).toBe(200);
    expect(m.control.atkomst.get(hel)).toEqual([{ userId: 'u-anna', role: 'owner', email: null }]);
    expect(m.logg.find((rad) => rad.event === 'owner_grant_failed')).toMatchObject({
      level: 'error',
      appIdPrefix: trasig.slice(0, 8),
    });
    expect(m.logg.find((rad) => rad.event === 'owners_granted_on_startup')).toMatchObject({ count: 1 });
    expect(JSON.stringify(m.logg)).not.toContain(trasig);
  });

  it('har control en annan ägare för appen byts den inte ut; felet loggas och starten fortsätter', async () => {
    const oense = await nyApp(m.builder);
    const hel = await nyApp(m.builder);
    m.control.atkomst.clear();
    m.control.atkomst.set(oense, [{ userId: 'u-nagon-annan', role: 'owner', email: null }]);
    await m.builder.close();
    m.logg.length = 0;
    m.builder = m.starta();

    expect((await anropa(m.builder, ANNA, 'GET', medlemmar(hel))).status).toBe(200);
    expect(m.control.atkomst.get(oense)).toEqual([{ userId: 'u-nagon-annan', role: 'owner', email: null }]);
    expect(m.logg.find((rad) => rad.event === 'owner_grant_failed')).toMatchObject({
      appIdPrefix: oense.slice(0, 8),
      errorName: 'ControlError',
    });
    expect(m.logg.find((rad) => rad.event === 'owners_granted_on_startup')).toMatchObject({ count: 1 });
  });
});

describe('dela ger åtkomst', () => {
  it('adressens användare får rollen user med den normaliserade adressen', async () => {
    const appId = await publiceradApp();
    await dela(appId, '  Bertil@Example.org ');
    expect(m.control.atkomst.get(appId)).toEqual([
      { userId: 'u-anna', role: 'owner', email: 'anna@example.org' },
      { userId: 'u-bertil', role: 'user', email: 'bertil@example.org' },
    ]);
  });

  it('delar ägaren med sig själv ⇒ samma svar, och ägaren förblir ägare', async () => {
    const appId = await publiceradApp();
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'anna@example.org' } });
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ shared: true });
    expect(m.control.atkomst.get(appId)).toEqual([{ userId: 'u-anna', role: 'owner', email: 'anna@example.org' }]);
  });

  it('går åtkomsten inte att ge ⇒ 500 utan detaljer, och delningen räknas inte som gjord', async () => {
    const appId = await publiceradApp();
    m.control.grantAccess = async () => {
      throw new Error('bertil@example.org: /srv/control låst');
    };
    const svar = await anropa(m.builder, ANNA, 'POST', api(`/apps/${appId}/share`), { body: { email: 'bertil@example.org' } });
    expect(svar.status).toBe(500);
    expect(svar.text).not.toContain('bertil');
    expect(svar.text).not.toContain('/srv');
    expect(m.logg.find((rad) => rad.event === 'share_failed')).toBeDefined();
  });

  it('den som fått appen delad med sig kan inte dela den vidare ⇒ 404', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'bertil@example.org');
    const svar = await anropa(m.builder, BERTIL, 'POST', api(`/apps/${appId}/share`), { body: { email: 'cecilia@example.org' } });
    expect(svar.status).toBe(404);
    expect(m.inbjudningar.inbjudna.map((inbjudan) => inbjudan.email)).toEqual(['bertil@example.org']);
  });
});

describe('åtkomstlistan', () => {
  it('ägaren ser sig själv först och sedan dem appen delats med', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'bertil@example.org');
    await dela(appId, 'cecilia@example.org');
    const cecilia = m.inbjudningar.anvandare.get('cecilia@example.org');
    const svar = await anropa(m.builder, ANNA, 'GET', medlemmar(appId));
    expect(svar.status).toBe(200);
    expect(svar.headers['Cache-Control']).toBe('no-store');
    expect(svar.json).toEqual({
      members: [
        { memberId: 'u-anna', email: 'anna@example.org', role: 'owner' },
        { memberId: 'u-bertil', email: 'bertil@example.org', role: 'user' },
        { memberId: cecilia, email: 'cecilia@example.org', role: 'user' },
      ],
    });
  });

  it('saknar control ägarens adress visas ägarens egen adress', async () => {
    const appId = await nyApp(m.builder);
    m.control.atkomst.set(appId, [{ userId: 'u-anna', role: 'owner', email: null }]);
    const svar = await anropa(m.builder, ANNA, 'GET', medlemmar(appId));
    expect(svar.json.members).toEqual([{ memberId: 'u-anna', email: 'anna@example.org', role: 'owner' }]);
  });

  it('ägaren kommer först även om control skulle lista annorlunda', async () => {
    const appId = await nyApp(m.builder);
    m.control.listAccess = async () => [
      { userId: 'u-bertil', role: 'user', email: 'bertil@example.org', addedAt: '2026-09-19T08:00:00.000Z' },
      { userId: 'u-anna', role: 'owner', email: 'anna@example.org', addedAt: '2026-09-19T08:00:00.000Z' },
    ];
    const svar = await anropa(m.builder, ANNA, 'GET', medlemmar(appId));
    expect(svar.json.members.map((rad: { memberId: string }) => rad.memberId)).toEqual(['u-anna', 'u-bertil']);
  });

  it('den som fått appen delad med sig, en annan byggare och en administratör får 404', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'bertil@example.org');
    for (const person of [BERTIL, ADAM]) {
      const svar = await anropa(m.builder, person, 'GET', medlemmar(appId));
      expect(svar.status, person.userId).toBe(404);
      expect(svar.text).not.toContain('bertil@');
    }
  });

  it('okänd och felformad app ⇒ samma 404', async () => {
    const okand = await anropa(m.builder, ANNA, 'GET', medlemmar('0000000000000000000000000a'));
    const felformad = await anropa(m.builder, ANNA, 'GET', medlemmar('..'));
    expect(okand.status).toBe(404);
    expect(felformad.text).toBe(okand.text);
  });

  it('bara GET på listan, bara DELETE på en rad', async () => {
    const appId = await nyApp(m.builder);
    expect((await anropa(m.builder, ANNA, 'POST', medlemmar(appId), { body: {} })).status).toBe(405);
    expect((await anropa(m.builder, ANNA, 'DELETE', medlemmar(appId))).status).toBe(405);
    expect((await anropa(m.builder, ANNA, 'GET', medlem(appId, 'u-bertil'))).status).toBe(405);
    expect((await anropa(m.builder, ANNA, 'PUT', medlem(appId, 'u-bertil'), { body: {} })).status).toBe(405);
  });

  it('control fallerar ⇒ 500 utan detaljer', async () => {
    const appId = await nyApp(m.builder);
    m.control.listAccess = async () => {
      throw new Error('/srv/control: bertil@example.org');
    };
    const svar = await anropa(m.builder, ANNA, 'GET', medlemmar(appId));
    expect(svar.status).toBe(500);
    expect(svar.text).not.toContain('/srv');
    expect(svar.text).not.toContain('bertil');
  });
});

describe('ta bort åtkomst', () => {
  it('ägaren tar bort en användare och raden försvinner direkt', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'bertil@example.org');
    const svar = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, 'u-bertil'));
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ removed: true });
    expect(m.control.atkomst.get(appId)).toEqual([{ userId: 'u-anna', role: 'owner', email: 'anna@example.org' }]);
    const lista = await anropa(m.builder, ANNA, 'GET', medlemmar(appId));
    expect(lista.json.members).toHaveLength(1);
    expect(m.logg.find((rad) => rad.event === 'access_revoked')).toMatchObject({
      level: 'info',
      appIdPrefix: appId.slice(0, 8),
      userId: 'u-anna',
    });
  });

  it('ett riktigt användar-id (22 tecken base64url) går att ta bort', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'cecilia@example.org');
    const cecilia = m.inbjudningar.anvandare.get('cecilia@example.org')!;
    expect(cecilia).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const svar = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, cecilia));
    expect(svar.status).toBe(200);
    expect(m.control.atkomst.get(appId)?.map((rad) => rad.userId)).toEqual(['u-anna']);
  });

  it('DELETE med kroppen {} (som klienten skickar) och testlägets id-format fungerar', async () => {
    const appId = await publiceradApp();
    const testId = `test-${'A'.repeat(22)}`;
    m.inbjudningar.anvandare.set('test@example.org', testId);
    await dela(appId, 'test@example.org');
    const svar = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, testId), { body: {} });
    expect(svar.status).toBe(200);
    expect(svar.json).toEqual({ removed: true });
    expect(m.control.atkomst.get(appId)?.map((rad) => rad.userId)).toEqual(['u-anna']);
  });

  it('vägrar control (ägaren enligt control) ⇒ 400, inte 500', async () => {
    const appId = await publiceradApp();
    m.control.atkomst.set(appId, [{ userId: 'u-nagon-annan', role: 'owner', email: null }]);
    const svar = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, 'u-nagon-annan'));
    expect(svar.status).toBe(400);
    expect(svar.json.error.code).toBe('invalid_request');
  });

  it('okänd medlem ⇒ samma svar (idempotent), även andra gången', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'bertil@example.org');
    const forsta = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, 'u-bertil'));
    const andra = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, 'u-bertil'));
    const okand = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, 'u-finns-inte'));
    expect(andra.text).toBe(forsta.text);
    expect(okand.status).toBe(200);
    expect(okand.text).toBe(forsta.text);
  });

  it('ägaren kan inte ta bort sin egen åtkomst ⇒ 400, och är fortfarande ägare', async () => {
    const appId = await publiceradApp();
    const svar = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, 'u-anna'));
    expect(svar.status).toBe(400);
    expect(svar.json.error.code).toBe('invalid_request');
    expect(svar.json.error.message.length).toBeGreaterThan(5);
    expect(m.control.atkomst.get(appId)).toEqual([{ userId: 'u-anna', role: 'owner', email: 'anna@example.org' }]);
  });

  it('den som fått appen delad med sig kan inte ta bort någon — inte ens sig själv eller ägaren', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'bertil@example.org');
    for (const memberId of ['u-anna', 'u-bertil']) {
      const svar = await anropa(m.builder, BERTIL, 'DELETE', medlem(appId, memberId));
      expect(svar.status, memberId).toBe(404);
    }
    const annanByggare = await anropa(m.builder, ADAM, 'DELETE', medlem(appId, 'u-bertil'));
    expect(annanByggare.status).toBe(404);
    expect(m.control.atkomst.get(appId)?.map((rad) => rad.userId)).toEqual(['u-anna', 'u-bertil']);
  });

  it('fientliga medlems-id avvisas innan control tillfrågas', async () => {
    const appId = await publiceradApp();
    await dela(appId, 'bertil@example.org');
    let anrop = 0;
    const riktig = m.control.revokeAccess;
    m.control.revokeAccess = async (...args) => {
      anrop += 1;
      return riktig(...args);
    };
    const fientliga = ['..', '.', 'u-bertil\u0000', 'u bertil', 'u%2Fbertil', 'u-bertil;', 'ö', 'x'.repeat(65), 'u-bertil\n'];
    for (const memberId of fientliga) {
      const svar = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, memberId));
      expect([400, 404], JSON.stringify(memberId)).toContain(svar.status);
    }
    // Fler segment eller tomt segment är inte ens en rutt.
    for (const path of [api(`/apps/${appId}/members/../u-bertil`), api(`/apps/${appId}/members/`), api(`/apps/${appId}/members/u-bertil/x`)]) {
      const svar = await anropa(m.builder, ANNA, 'DELETE', path);
      expect(svar.status, path).toBe(404);
    }
    expect(anrop).toBe(0);
    expect(m.control.atkomst.get(appId)?.map((rad) => rad.userId)).toEqual(['u-anna', 'u-bertil']);
  });

  it('ett felformat medlems-id ger samma 400 oavsett om appen finns', async () => {
    const appId = await nyApp(m.builder);
    const finns = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, '..'));
    const finnsInte = await anropa(m.builder, ANNA, 'DELETE', medlem('0000000000000000000000000a', '..'));
    expect(finns.status).toBe(400);
    expect(finnsInte.text).toBe(finns.text);
  });

  it('control fallerar ⇒ 500 utan detaljer', async () => {
    const appId = await publiceradApp();
    m.control.revokeAccess = async () => {
      throw new Error('/srv/control låst');
    };
    const svar = await anropa(m.builder, ANNA, 'DELETE', medlem(appId, 'u-bertil'));
    expect(svar.status).toBe(500);
    expect(svar.text).not.toContain('/srv');
  });

  it('läsaren utan byggroll får 403 på både lista och borttagning', async () => {
    const appId = await nyApp(m.builder);
    expect((await anropa(m.builder, VERA, 'GET', medlemmar(appId))).status).toBe(403);
    expect((await anropa(m.builder, VERA, 'DELETE', medlem(appId, 'u-anna'))).status).toBe(403);
  });
});
