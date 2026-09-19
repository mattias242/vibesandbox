/**
 * @vibesandbox/builder — byggverktygets backend.
 *
 * Gatewayn lämnar varje förfrågan på `bygg.<BASE_DOMAIN>` (utom `/_auth/…`) till `handle`, efter
 * inloggning och CSRF-kontroll. Här avgörs sedan:
 *
 *   - `/_api/builder/…` → HTTP-gränssnittet (api.ts): appar, samtal, jobb, publicering, delning.
 *   - övriga `/_api/…`  → 404 som JSON. Namnrymden tillhör plattformen, inte webbgränssnittet.
 *   - allt annat         → byggverktygets egna statiska filer (statiskt.ts).
 *
 * Paketet bygger enbart mot kontrakten: agenten, byggkedjan, control och inbjudningarna kommer in
 * som gränssnitt, och kopplas ihop av `apps/platform`.
 */
import { resolve } from 'node:path';
import { API_PREFIX } from '@vibesandbox/contracts';
import type { Agent, BuilderHandler, Identity, InvitationService, PlatformRequest, SourceFiles } from '@vibesandbox/contracts';
import { createApi } from './api.ts';
import { grantOwnersOnStartup } from './atkomst.ts';
import type { BuilderUrls } from './api.ts';
import type { BuilderControl } from './control.ts';
import { openBuilderDatabase } from './databas.ts';
import { DEFAULT_JOB_TIMEOUT_MS, createJobRunner, failInterruptedJobs } from './ko.ts';
import { createStorage } from './lagring.ts';
import { safeLogger, silentLogger } from './logg.ts';
import type { BuilderLogger } from './logg.ts';
import { createStaticSite } from './statiskt.ts';
import { internal, notFound, problemResponse } from './svar.ts';

export type { BuilderUrls } from './api.ts';
export { MAX_SHARES_PER_HOUR } from './api.ts';
export type { BuilderAccessEntry, BuilderControl } from './control.ts';
export type { BuilderLogEntry, BuilderLogEvent, BuilderLogger } from './logg.ts';

export interface BuilderOptions {
  /** Katalog för byggverktygets egen databas, `builder.sqlite`. */
  readonly dataDir: string;
  readonly control: BuilderControl;
  readonly agent: Agent;
  /** Källfilerna en ny app börjar från — mallens startpunkt för agenten. */
  readonly starterFiles: SourceFiles;
  readonly invitations: InvitationService;
  /** Byggverktygets byggda webbgränssnitt. Läses in en gång, vid start. */
  readonly ui: { readonly directory: string };
  readonly urls: BuilderUrls;
  /**
   * Adressen som loggar in webbläsaren på målvärden och landar på `targetUrl`. Plattformen avgör:
   * i testläge en testinloggningsadress, med riktig inloggning helt enkelt `targetUrl`.
   */
  readonly openUrl: (identity: Identity, targetUrl: string) => string;
  readonly logger?: BuilderLogger;
  readonly clock?: () => Date;
  /** Hur länge en tur får pågå innan den avbryts och kön går vidare. Standard 20 minuter. */
  readonly jobTimeoutMs?: number;
}

export interface Builder extends BuilderHandler {
  /** Avbryter pågående tur, väntar (en stund) på att den avslutas och stänger databasen. */
  close(): Promise<void>;
}

export function createBuilder(options: BuilderOptions): Builder {
  if (typeof options.dataDir !== 'string' || options.dataDir.length === 0) {
    throw new TypeError('dataDir måste anges.');
  }
  const log = safeLogger(options.logger ?? silentLogger);
  const now = options.clock ?? (() => new Date());
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  if (!Number.isSafeInteger(jobTimeoutMs) || jobTimeoutMs <= 0) throw new TypeError('jobTimeoutMs måste vara ett positivt heltal.');

  const db = openBuilderDatabase(resolve(options.dataDir));
  let storage;
  try {
    storage = createStorage(db);
    failInterruptedJobs(storage, now, log);
  } catch (error) {
    db.close();
    throw error;
  }

  const runner = createJobRunner({
    storage,
    control: options.control,
    agent: options.agent,
    starterFiles: options.starterFiles,
    log,
    now,
    jobTimeoutMs,
  });
  const api = createApi({
    storage,
    runner,
    control: options.control,
    invitations: options.invitations,
    urls: options.urls,
    openUrl: options.openUrl,
    log,
    now,
  });
  const site = createStaticSite(options.ui.directory, log);
  // Körs i bakgrunden från start; API-anropen väntar in den (den avvisar aldrig — se atkomst.ts),
  // så att ingen åtkomstlista läses eller ändras innan ägarna finns i control.
  const ownersGranted = grantOwnersOnStartup(storage, options.control, log);

  let closed = false;
  let closing: Promise<void> | null = null;

  return {
    async handle(request: PlatformRequest) {
      if (closed || closing !== null) return problemResponse(internal());
      const path = request.path;
      if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
        await ownersGranted;
        return api.handle(request);
      }
      if (path.startsWith('/_api')) return problemResponse(notFound());
      return site.handle(request.method, path);
    },

    close() {
      closing ??= (async () => {
        await ownersGranted;
        await runner.close();
        closed = true;
        db.close();
      })();
      return closing;
    },
  };
}
