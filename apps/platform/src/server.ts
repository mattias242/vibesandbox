/**
 * Sätter ihop plattformen: lagring (data-api) + appregister och appfiler (control) + inloggning
 * (identity) + byggverktyget (builder, med agent och språkmodell) + gateway, bakom EN
 * `node:http`-server.
 *
 * Här fattas inga säkerhetsbeslut — de ligger i gatewayn, identitetsleverantören och byggverktyget.
 * Den här filens ansvar är att inget av dem kringgås vid ihopsättningen:
 *
 *   - servern skapas med `RECOMMENDED_SERVER_OPTIONS` och `clientError` kopplas till
 *     `handleClientError`. Annars svarar Node självt på trasiga förfrågningar, utan skyddsreglerna.
 *   - gatewayn är den ENDA hanteraren. Det finns ingen hälsokontroll, statussida eller annan
 *     rutt bredvid den som kunde nås utan värdnamnskontroll och inloggning. Byggverktyget nås
 *     bara GENOM gatewayn, som ger det sin exakta origin för CSRF-kontrollen.
 *   - språkmodellen får alltid maskningen framför sig: den läggs på här, oavsett vilken
 *     leverantör som skickas in.
 *
 * Datakatalogens layout:
 *
 *   <DATA_DIR>/control/    appregistret (SQLite)               — @vibesandbox/control
 *   <DATA_DIR>/versions/   apparnas byggda filer, per hash     — @vibesandbox/control
 *   <DATA_DIR>/tenants/    en katalog med databas per app      — @vibesandbox/data-api
 *   <DATA_DIR>/identity/   användare, koder och sessioner      — @vibesandbox/identity
 *   <DATA_DIR>/builder/    byggverktygets appar, samtal, jobb  — @vibesandbox/builder
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { createAgent } from '@vibesandbox/agent';
import { createBuilder } from '@vibesandbox/builder';
import type { Builder } from '@vibesandbox/builder';
import type { AgentKnowledge } from '@vibesandbox/agent';
import type { AppMailer, AppServiceFactory, AppServiceName, BuildRunner, LlmProvider, Role } from '@vibesandbox/contracts';
import { createControl } from '@vibesandbox/control';
import { createTenantStore } from '@vibesandbox/data-api';
import { RECOMMENDED_SERVER_OPTIONS, createGateway, handleClientError } from '@vibesandbox/gateway';
import type { RequestHandler } from '@vibesandbox/gateway';
import type { AddedUser } from '@vibesandbox/identity';
import { createMaskingProvider, createOpenAiCompatibleProvider } from '@vibesandbox/llm';
import { ConfigError, platformAddresses } from './config.ts';
import type { BuilderConfig, PlatformConfig } from './config.ts';
import { createPlatformIdentity, platformFeedback, platformMailer } from './identitet.ts';
import { APP_SERVICE_FACTORIES, createAppServices } from './tjanster.ts';
import type { PlatformIdentity } from './identitet.ts';
import type { PlatformLogEntry, PlatformLogger } from './logg.ts';

/**
 * Det som inte kommer ur konfigurationen utan kopplas in av den som startar plattformen.
 *
 * Byggkedjan och agentens kunskap injiceras: `main.ts` och `dev.ts` skapar dem med
 * `createBuilderDependencies` (byggkedja.ts, kunskap.ts), testerna kan skicka en fejkad byggkedja.
 */
export interface PlatformDependencies {
  /** Krävs när byggverktyget är påslaget. */
  readonly buildRunner?: BuildRunner;
  /** Krävs när byggverktyget är påslaget: SDK-referensen, exempelappen och startfilerna (kunskap.ts). */
  readonly knowledge?: AgentKnowledge;
  /**
   * Språkmodellen FÖRE maskning. Standard: en OpenAI-kompatibel leverantör enligt konfigurationen.
   * Maskningen av personuppgifter läggs alltid på av plattformen, även på en insänd leverantör.
   */
  readonly llmProvider?: LlmProvider;
  /**
   * Plattformstjänsternas fabriker. Standard: de byggda paketen (`APP_SERVICE_FACTORIES`).
   * Tester skickar egna. Vilka som SKAPAS avgör ändå konfigurationens `appServices`.
   */
  readonly appServiceFactories?: Readonly<Partial<Record<AppServiceName, AppServiceFactory>>>;
  /** Tester: mejl och Berget för tjänsterna, i stället för konfigurationens. */
  readonly appServiceOverrides?: {
    readonly mailer?: AppMailer;
    readonly berget?: { readonly baseUrl: string; readonly apiKey: string };
  };
}

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
  /**
   * Administrativt: lägger till en inbjuden adress eller höjer dess roll, utan mejl. Bara med
   * e-postinloggning; i testläge avvisas anropet. (I drift görs det med identitetens CLI.)
   */
  addUser(email: string, role: Role): Promise<AddedUser>;
}

/** Så länge får pågående förfrågningar på sig att bli klara innan anslutningarna bryts. */
const SHUTDOWN_GRACE_MS = 10_000;

const TENANT_DIRECTORY = 'tenants';
const BUILDER_DIRECTORY = 'builder';

/** Tak för ett anrop till språkmodellen, inklusive strömmen. En tur har flera anrop. */
const LLM_TIMEOUT_MS = 5 * 60 * 1000;

const silentLogger: PlatformLogger = () => {};

/** En loggare som aldrig kastar: loggning är inte värd att fälla en förfrågan för. */
function safeLogger(logger: PlatformLogger | undefined): PlatformLogger {
  if (logger === undefined) return silentLogger;
  return (entry: PlatformLogEntry) => {
    try {
      logger(entry);
    } catch {
      // Medvetet tomt.
    }
  };
}

function languageModel(config: BuilderConfig, injected: LlmProvider | undefined): LlmProvider {
  const inner =
    injected ??
    createOpenAiCompatibleProvider({
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      reasoningEffort: config.llm.reasoningEffort,
      timeoutMs: LLM_TIMEOUT_MS,
    });
  // FAIL-CLOSED: går maskningen inte att genomföra lämnar ingenting servern.
  return createMaskingProvider(inner);
}

export function createPlatform(config: PlatformConfig, deps: PlatformDependencies = {}): Platform {
  const log = safeLogger(config.logger);

  // Innan något öppnas: ett påslaget byggverktyg utan byggkedja är ett startfel, inte ett
  // byggverktyg där varje önskemål misslyckas.
  const builderConfig = config.builder;
  const buildRunner = deps.buildRunner;
  const knowledge = deps.knowledge;
  if (builderConfig !== undefined && buildRunner === undefined) {
    throw new ConfigError([
      'Byggverktyget är påslaget (LLM_MODEL är satt), men byggkedjan är inte installerad. ' +
        'Ta bort LLM_MODEL för att köra utan byggverktyget, eller installera @vibesandbox/build.',
    ]);
  }
  if (builderConfig !== undefined && knowledge === undefined) {
    throw new ConfigError(['Byggverktyget är påslaget, men agentens kunskap om mallen och SDK:t är inte inläst.']);
  }
  const addresses = platformAddresses(config);
  const mailer = deps.appServiceOverrides?.mailer ?? platformMailer(config);
  const berget =
    deps.appServiceOverrides?.berget ??
    config.berget ??
    (config.builder === undefined ? undefined : { baseUrl: config.builder.llm.baseUrl, apiKey: config.builder.llm.apiKey });

  // Ordningen är vald så att ett fel lämnar så lite som möjligt öppet: det som kan kasta utan
  // att ha öppnat något kommer först. Det som ändå hunnit öppnas stängs i `catch`, i omvänd ordning.
  const opened: Array<() => Promise<void>> = [];
  /** Stänger i omvänd ordning, en i taget (ordningen spelar roll), och allt även om något fallerar. */
  const closeOpened = async (): Promise<void> => {
    let firstError: unknown;
    let failed = false;
    for (const close of opened.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    if (failed) throw firstError;
  };

  let identity: PlatformIdentity;
  let builder: Builder | undefined;
  let handler: RequestHandler;
  try {
    const openControl = createControl({ dataDir: config.dataDir });
    opened.push(() => openControl.close());

    const openStore = createTenantStore({
      dataDir: join(config.dataDir, TENANT_DIRECTORY),
      ...(config.limits === undefined ? {} : { limits: config.limits }),
      ...(config.appServices?.enabled.includes('history') ? { history: { retentionDays: config.appServices.env['SVC_HISTORY_RETENTION_DAYS'] } } : {}),
    });
    opened.push(() => openStore.close());

    identity = createPlatformIdentity(config, log);
    const openIdentity = identity;
    opened.push(() => openIdentity.close());

    if (builderConfig !== undefined && buildRunner !== undefined && knowledge !== undefined) {
      const agent = createAgent({ provider: languageModel(builderConfig, deps.llmProvider), buildRunner, knowledge });
      builder = createBuilder({
        dataDir: join(config.dataDir, BUILDER_DIRECTORY),
        control: openControl,
        agent,
        starterFiles: knowledge.starterFiles,
        invitations: identity.invitations,
        feedback: platformFeedback(config),
        ui: { directory: builderConfig.uiDirectory },
        urls: { preview: addresses.preview, published: addresses.published },
        openUrl: identity.openUrl,
        services: config.appServices?.enabled ?? [],
        ...(config.version === undefined ? {} : { version: config.version }),
        logger: (entry) => log({ source: 'builder', ...entry }),
      });
      const openBuilder = builder;
      // Byggverktyget stängs FÖRE control: en pågående tur kan vara på väg att spara ett utkast.
      opened.push(() => openBuilder.close());
    }

    // Plattformstjänsterna: bara de påslagna skapas, och efter lagring, register och inloggning,
    // så att de kan få medlemslistan och lagret. De stängs före dem (ordningen i `opened`).
    const services = createAppServices({
      enabled: config.appServices?.enabled ?? [],
      env: config.appServices?.env ?? {},
      factories: deps.appServiceFactories ?? APP_SERVICE_FACTORIES,
      dataDir: config.dataDir,
      log,
      members: { members: (appId) => openControl.listAccess(appId) },
      store: openStore,
      publishedUrl: (appId) => addresses.published(appId),
      ...(berget === undefined ? {} : { berget }),
      ...(mailer === undefined ? {} : { mailer }),
    });
    for (const service of services) {
      if (service.close !== undefined) opened.push(() => service.close?.() ?? Promise.resolve());
    }

    handler = createGateway({
      appDomain: config.appDomain,
      // ADR 0002: förhandsvisningar av ogranskade utkast ligger på samma site som byggverktyget.
      previewDomain: config.baseDomain,
      identityProvider: identity.provider,
      registry: openControl.registry,
      files: openControl.files,
      store: openStore,
      logger: (entry) => log({ source: 'gateway', ...entry }),
      services,
      ...(builder === undefined ? {} : { builder: { handler: builder, origin: addresses.builderOrigin } }),
    });
  } catch (error) {
    void closeOpened().catch(() => {});
    throw error;
  }
  const platformIdentity = identity;

  const server = createServer(RECOMMENDED_SERVER_OPTIONS, handler);
  server.on('clientError', handleClientError);

  // Plattformen håller själv reda på sina anslutningar och vilka som har en förfrågan på gång.
  // Nodes `closeIdleConnections()` räcker inte: vad som räknas som "overksam" skiljer mellan
  // Node-versioner, och på Node 24 räknas en anslutning som ännu inte skickat något INTE dit —
  // den får då ligga kvar tills `headersTimeout` löper ut. En enda tyst anslutning skulle alltså
  // fördröja varje omstart med tio sekunder.
  const sockets = new Set<Socket>();
  const inFlight = new Map<Socket, number>();
  let shuttingDown = false;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      inFlight.delete(socket);
    });
  });
  server.on('request', (request, response) => {
    const socket = request.socket;
    inFlight.set(socket, (inFlight.get(socket) ?? 0) + 1);
    response.once('close', () => {
      const remaining = (inFlight.get(socket) ?? 1) - 1;
      if (remaining > 0) {
        inFlight.set(socket, remaining);
        return;
      }
      inFlight.delete(socket);
      // Under nedstängning återanvänds ingen anslutning: när svaret är skickat stängs den.
      if (shuttingDown) socket.destroy();
    });
  });

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
    // Anslutningar utan pågående förfrågan väntar på ingenting; de stängs genast — oavsett om de
    // är keep-alive-anslutningar mellan två förfrågningar eller aldrig har skickat något alls.
    shuttingDown = true;
    for (const socket of sockets) {
      if (!inFlight.has(socket)) socket.destroy();
    }
    server.closeIdleConnections();
    const grace = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
    try {
      await stopped;
    } finally {
      clearTimeout(grace);
    }

    // 2. Först NU stängs resten — ingen förfrågan kan längre vara på väg att använda det.
    //    Byggverktyget först (det avbryter en pågående tur), sedan inloggning, lagring och register.
    //    Allt stängs även om något misslyckas.
    await closeOpened();
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

    addUser(email, role) {
      return platformIdentity.addUser(email, role);
    },
  };
}
