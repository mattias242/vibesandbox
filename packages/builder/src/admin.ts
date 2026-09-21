/**
 * Kontrollrummet (adminvyn): `GET /admin/oversikt` och `GET /admin/appar`.
 *
 * Ren läsning — ingenting här ändrar något. Rutterna bryter med flit byggverktygets regel att man
 * bara ser sitt eget, och är den enda platsen som gör det; SQL:en ligger samlad i sql-admin.ts.
 * Grinden sitter i api.ts (`requireAdmin`): plattformsrollen `admin`, inte `builder`.
 *
 * Två saker svaren aldrig får bära, och som är skälet till att formen ser ut som den gör:
 *
 *  - Hela app-id:t ÄR appens hemliga adress. Kontrollrummet lämnar bara ut de första
 *    `ADMIN_APP_ID_PREFIX_LENGTH` tecknen, och aldrig en länk. Rollen `admin` ger enligt kontraktet
 *    ingen åtkomst till någon apps data; insyn i ATT appar finns är inte en väg IN i dem.
 *  - Ägarens adress går i svaret men aldrig i en loggrad — därför loggar den här modulen inget alls.
 */
import { ADMIN_APP_ID_PREFIX_LENGTH, ADMIN_TOKEN_WINDOW_DAYS } from '@vibesandbox/contracts';
import type { AdminApp, AdminOverview, PlatformResponse } from '@vibesandbox/contracts';
import { controlErrorCode, storedAppId } from './control.ts';
import type { BuilderAccessEntry, BuilderControl } from './control.ts';
import type { Storage } from './lagring.ts';
import { json } from './svar.ts';

export interface AdminDependencies {
  readonly storage: Storage;
  readonly control: BuilderControl;
  readonly now: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createAdmin(deps: AdminDependencies): {
  overview(): PlatformResponse;
  apps(): Promise<PlatformResponse>;
} {
  const { storage, control } = deps;

  /** Tidpunkten fönstret börjar vid. Räknas om per förfrågan — det är alltid "de senaste dygnen". */
  function windowStart(): string {
    return new Date(deps.now().getTime() - ADMIN_TOKEN_WINDOW_DAYS * DAY_MS).toISOString();
  }

  /**
   * Åtkomstlistan för en app, ur control. En app som byggverktyget känner men control inte gör
   * (en kvarlämnad rad) ska inte fälla hela listan: då blir ägaren okänd och antalet noll, och
   * resten av kontrollrummet fungerar. Andra fel från control är riktiga fel och kastas vidare.
   */
  async function accessFor(appId: string): Promise<readonly BuilderAccessEntry[]> {
    try {
      return await control.listAccess(storedAppId(appId));
    } catch (error) {
      if (controlErrorCode(error) === 'app_not_found') return [];
      throw error;
    }
  }

  return {
    overview(): PlatformResponse {
      const since = windowStart();
      const counts = storage.countAllApps();
      const totals = storage.jobTotalsSince(since);
      const body: AdminOverview = {
        apps: counts.apps,
        published: counts.published,
        drafts: counts.drafts,
        // Antalet adresser per roll ligger i identitetspaketets databas, som byggverktyget inte
        // når — och att dra en ny beroendekedja dit hör inte hemma i en läsande skiva. Nollor
        // tills en egen, smal väg finns: en tydlig nolla är ärligare än en gissning.
        users: { admin: 0, builder: 0, viewer: 0 },
        tokens: { input: totals.inputTokens, output: totals.outputTokens, jobs: totals.jobs },
        failedJobs: storage.failedJobsSince(since),
      };
      return json(200, body);
    },

    async apps(): Promise<PlatformResponse> {
      const rows = storage.listAllApps();
      const apps: AdminApp[] = [];
      // Ett control-anrop per app. Databasen är en fil på samma maskin och listan är plattformens
      // alla appar — går den någon gång i tusental är det här stället att slå ihop anropen.
      for (const row of rows) {
        const access = await accessFor(row.appId);
        const owner = access.find((entry) => entry.role === 'owner');
        apps.push({
          // Bara prefixet. Resten av id:t lämnar aldrig det här lagret.
          appIdPrefix: row.appId.slice(0, ADMIN_APP_ID_PREFIX_LENGTH),
          name: row.name,
          ownerEmail: owner?.email ?? null,
          updatedAt: row.updatedAt,
          hasDraft: row.hasDraft,
          published: row.published,
          members: access.length,
          tokens: { input: row.inputTokens, output: row.outputTokens },
        });
      }
      return json(200, { apps });
    },
  };
}
