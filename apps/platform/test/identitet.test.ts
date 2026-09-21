/**
 * Inbjudningar i testläge: byggverktyget behöver den inbjudnas användar-id för att ge åtkomst
 * till en delad app, även när det inte finns någon riktig identitetstjänst.
 *
 *   Givet testinloggningen
 *   När en ägare delar en app med en adress
 *   Så får byggverktyget ett användar-id och den normaliserade adressen tillbaka
 *   Och samma adress ger alltid samma id, olika adresser olika id
 *   Och id:t är det som en testinloggning för adressen bär (`testUserIdFor`)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Identity } from '@vibesandbox/contracts';
import { createPlatformIdentity, testUserIdFor } from '../src/identitet.ts';
import type { PlatformConfig } from '../src/config.ts';
import type { PlatformLogEntry } from '../src/logg.ts';
import { TESTHEMLIGHET } from './stod/plattform.ts';

const ANNA: Identity = { userId: 'anv-anna', email: 'anna@example.org', roles: ['builder'] };

/**
 * Varje plattform får en egen datakatalog. Testläget rör numera disk: användarregistret öppnas
 * också här, eftersom rollerna bor i ETT register oavsett hur man loggade in. Inbjudans id är
 * ändå härlett ur adressen och kommer inte ur registret — det är just det som prövas nedan.
 */
const oppnade: { close(): Promise<void>; dataDir: string }[] = [];

afterEach(async () => {
  for (const { close, dataDir } of oppnade.splice(0)) {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function testidentitet(hemlighet = TESTHEMLIGHET): { invite: ReturnType<typeof createPlatformIdentity>['invitations']['invite']; logg: PlatformLogEntry[] } {
  const logg: PlatformLogEntry[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'vibesandbox-testidentitet-'));
  const config = { identity: { provider: 'test', testSecret: hemlighet }, dataDir } as unknown as PlatformConfig;
  const identitet = createPlatformIdentity(config, (entry) => logg.push(entry));
  oppnade.push({ close: () => identitet.close(), dataDir });
  return { invite: (request) => identitet.invitations.invite(request), logg };
}

describe('inbjudan i testläge', () => {
  it('svarar med ett användar-id och den normaliserade adressen', async () => {
    const { invite } = testidentitet();
    const svar = await invite({ email: ' Bertil@Example.ORG ', role: 'viewer', invitedBy: ANNA });
    expect(Object.keys(svar).sort()).toEqual(['email', 'userId']);
    expect(svar.email).toBe('bertil@example.org');
    expect(svar.userId).toMatch(/^test-[A-Za-z0-9_-]{22}$/);
  });

  it('ger samma adress samma id — oavsett skiftläge, blanktecken och om den bjudits in förut', async () => {
    const { invite } = testidentitet();
    const forst = await invite({ email: 'bertil@example.org', role: 'viewer', invitedBy: ANNA });
    const igen = await invite({ email: '  BERTIL@example.org', role: 'builder', invitedBy: ANNA });
    expect(igen).toEqual(forst);
    // Även en ny plattform med samma hemlighet: id:t är härlett, inte sparat.
    expect(await testidentitet().invite({ email: 'bertil@example.org', role: 'viewer', invitedBy: ANNA })).toEqual(forst);
  });

  it('ger olika adresser olika id', async () => {
    const { invite } = testidentitet();
    const a = await invite({ email: 'a@example.org', role: 'viewer', invitedBy: ANNA });
    const b = await invite({ email: 'b@example.org', role: 'viewer', invitedBy: ANNA });
    expect(a.userId).not.toBe(b.userId);
  });

  it('är nycklat med testhemligheten: id:t går inte att räkna fram ur adressen ensam', async () => {
    const a = await testidentitet().invite({ email: 'bertil@example.org', role: 'viewer', invitedBy: ANNA });
    const b = await testidentitet(`${TESTHEMLIGHET}-en-annan`).invite({ email: 'bertil@example.org', role: 'viewer', invitedBy: ANNA });
    expect(a.userId).not.toBe(b.userId);
    expect(a.userId).not.toContain('bertil');
  });

  it('är samma id som testUserIdFor ger — det en testinloggning för adressen ska bära', async () => {
    const { invite } = testidentitet();
    const svar = await invite({ email: 'Bertil@example.org', role: 'viewer', invitedBy: ANNA });
    expect(testUserIdFor('bertil@example.org', TESTHEMLIGHET)).toBe(svar.userId);
    expect(testUserIdFor(' BERTIL@example.org ', TESTHEMLIGHET)).toBe(svar.userId);
    expect(() => testUserIdFor('inte en adress', TESTHEMLIGHET)).toThrow();
  });

  it('nekar en ogiltig adress med invalid_request, och noterar inbjudan utan adressen', async () => {
    const { invite, logg } = testidentitet();
    await expect(invite({ email: 'inte en adress', role: 'viewer', invitedBy: ANNA })).rejects.toMatchObject({ code: 'invalid_request' });
    await invite({ email: 'bertil@example.org', role: 'viewer', invitedBy: ANNA });
    expect(logg).toContainEqual(expect.objectContaining({ event: 'invitation_noted', userId: 'anv-anna', role: 'viewer' }));
    expect(JSON.stringify(logg)).not.toContain('bertil');
  });
});
