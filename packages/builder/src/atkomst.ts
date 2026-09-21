/**
 * Ägare i control för appar som skapades innan control hade en åtkomstlista.
 *
 * Utan en ägarrad skulle gatewayn neka ägaren hens egen app. Byggverktygets databas är facit för
 * vem som skapade appen, så vid varje start ges varje apps ägare rollen `owner` i control.
 * `grantAccess` är idempotent och nedgraderar aldrig, så det är ofarligt att göra om — en app som
 * redan har sin ägare påverkas inte. Adressen är okänd här (byggverktyget sparar den inte), och
 * `null` skriver aldrig över en adress som control redan har.
 *
 * En app som inte går att ge sin ägare (okänd i control, eller control har en ANNAN ägare) loggas
 * och hoppas över: ägaren förblir utelåst från just den appen, men starten stoppas inte och ingen
 * ägare byts ut i tysthet.
 *
 * VALT MEDVETET: adressen skrivs INTE in här, trots att bryggan till identiteten (anvandare.ts)
 * gör den känd vid start och `grantAccess` gärna hade tagit emot den. Kontrollrummet slår i
 * stället upp den vid varje visning. Skälen, i den ordning de vägde:
 *
 *  1. Adressen är en personuppgift. En skrivning hit ger en ANDRA kopia, i en annan databas, som
 *     ingen längre håller aktuell: byter någon adress i identiteten — eller tas hen bort — ligger
 *     den gamla kvar i control:s åtkomstlista. Uppslagningen är alltid färsk, och identiteten
 *     förblir det enda stället adresserna bor.
 *  2. Det vore en skrivning på befintliga rader vid VARJE start, för varje app, för att fylla i
 *     något bara kontrollrummet läser — och kontrollrummet öppnas sällan.
 *
 * Priset är en uppslagning per visning av applistan. Den är ett anrop för hela listan mot en
 * SQLite-fil på samma maskin (se admin.ts), alltså billigare än skrivningarna den ersätter.
 */
import { storedAppId } from './control.ts';
import type { BuilderControl } from './control.ts';
import type { Storage } from './lagring.ts';
import { appIdPrefix, describeError } from './logg.ts';
import type { BuilderLogger } from './logg.ts';

export async function grantOwnersOnStartup(storage: Storage, control: BuilderControl, log: BuilderLogger): Promise<void> {
  let apps: { appId: string; owner: string }[];
  try {
    apps = storage.listAppOwners();
  } catch (error) {
    log({ level: 'error', event: 'owner_grant_failed', ...describeError(error) });
    return;
  }
  let granted = 0;
  for (const { appId, owner } of apps) {
    try {
      await control.grantAccess(storedAppId(appId), owner, 'owner', null);
      granted += 1;
    } catch (error) {
      log({ level: 'error', event: 'owner_grant_failed', appIdPrefix: appIdPrefix(appId), ...describeError(error) });
    }
  }
  log({ level: 'info', event: 'owners_granted_on_startup', count: granted });
}
