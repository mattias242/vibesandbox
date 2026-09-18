/**
 * Sätter ihop plattformen: lagring (data-api) + appregister och appfiler (control) + gateway,
 * bakom EN `node:http`-server.
 *
 * Här fattas inga säkerhetsbeslut — de ligger i gatewayn. Den här filens ansvar är att inget av
 * dem kringgås vid ihopsättningen:
 *
 *   - servern skapas med `RECOMMENDED_SERVER_OPTIONS` och `clientError` kopplas till
 *     `handleClientError`. Annars svarar Node självt på trasiga förfrågningar, utan skyddsreglerna.
 *   - gatewayn är den ENDA hanteraren. Det finns ingen hälsokontroll, statussida eller annan
 *     rutt bredvid den som kunde nås utan värdnamnskontroll och inloggning.
 *
 * Datakatalogens layout:
 *
 *   <DATA_DIR>/control/    appregistret (SQLite)               — @vibesandbox/control
 *   <DATA_DIR>/versions/   apparnas byggda filer, per hash     — @vibesandbox/control
 *   <DATA_DIR>/tenants/    en katalog med databas per app      — @vibesandbox/data-api
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { createControl } from '@vibesandbox/control';
import { createTenantStore } from '@vibesandbox/data-api';
import {
  RECOMMENDED_SERVER_OPTIONS,
  createGateway,
  createTestIdentityProvider,
  handleClientError,
} from '@vibesandbox/gateway';
import type { PlatformConfig } from './config.ts';

export interface ListenInfo {
  readonly host: string;
  /** Den port servern FAKTISKT fick — skiljer sig från konfigurationen när den är 0. */
  readonly port: number;
}

export interface Platform {
  readonly server: Server;
  /** Börjar lyssna på konfigurationens adress och port. */
  listen(): Promise<ListenInfo>;
  /** Ordnad nedstängning. Går att anropa flera gånger; alla anrop väntar in samma nedstängning. */
  close(): Promise<void>;
}

/** Så länge får pågående förfrågningar på sig att bli klara innan anslutningarna bryts. */
const SHUTDOWN_GRACE_MS = 10_000;

const TENANT_DIRECTORY = 'tenants';

export function createPlatform(config: PlatformConfig): Platform {
  // Ordningen är vald så att ett fel lämnar så lite som möjligt öppet: det som kan kasta utan
  // att ha öppnat något kommer först. Det som ändå hunnit öppnas stängs i `catch`.
  const identityProvider = createTestIdentityProvider({ secret: config.identity.testSecret });

  const control = createControl({ dataDir: config.dataDir });
  let store;
  let handler;
  try {
    store = createTenantStore({
      dataDir: join(config.dataDir, TENANT_DIRECTORY),
      ...(config.limits === undefined ? {} : { limits: config.limits }),
    });
    handler = createGateway({
      appDomain: config.appDomain,
      // ADR 0002: förhandsvisningar av ogranskade utkast ligger på samma site som byggverktyget.
      previewDomain: config.baseDomain,
      identityProvider,
      registry: control.registry,
      files: control.files,
      store,
      ...(config.logger === undefined ? {} : { logger: config.logger }),
    });
  } catch (error) {
    void store?.close();
    void control.close();
    throw error;
  }
  const openStore = store;

  const server = createServer(RECOMMENDED_SERVER_OPTIONS, handler);
  server.on('clientError', handleClientError);

  let closing: Promise<void> | undefined;

  async function shutDown(): Promise<void> {
    // 1. Sluta ta emot nya anslutningar. Pågående förfrågningar får bli klara.
    const stopped = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    // Overksamma keep-alive-anslutningar väntar på ingenting; de stängs genast.
    server.closeIdleConnections();
    const grace = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
    try {
      await stopped;
    } finally {
      clearTimeout(grace);
    }

    // 2. Först NU stängs databaserna — ingen förfrågan kan längre vara på väg att använda dem.
    //    Båda stängs även om den ena misslyckas.
    const results = await Promise.allSettled([openStore.close(), control.close()]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
  }

  return {
    server,

    listen() {
      return new Promise<ListenInfo>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(config.port, config.listenHost, () => {
          server.off('error', onError);
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('Serverns adress gick inte att läsa ut.'));
            return;
          }
          resolve({ host: address.address, port: address.port });
        });
      });
    },

    close() {
      closing ??= shutDown();
      return closing;
    },
  };
}
