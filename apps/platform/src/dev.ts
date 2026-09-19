/**
 * Lokal utveckling i ett kommando:
 *
 *   npm run dev -w @vibesandbox/platform
 *
 * Bygger appmallen, ser till att det finns en app i den lokala datakatalogen, publicerar bygget
 * och startar plattformen med testinloggning. Skriver sedan ut appens adress, klickbara
 * inloggningsadresser för webbläsaren (appen och byggverktyget) och ett färdigt
 * `Authorization`-värde, så att det går att prova med curl direkt.
 *
 * Byggverktyget slås på när en nyckel till språkmodellen finns i miljön (`BERGET_API_KEY` eller
 * `LLM_API_KEY`) — skriptet läser projektets `.env` i repots rot om den finns. Då byggs också
 * byggverktygets webbgränssnitt, och Berget används med samma modell som i drift om inget annat
 * anges. Utan nyckel körs plattformen utan byggverktyg, och det sägs.
 *
 * Allt går genom samma `loadConfig` som i drift — även här vägrar plattformen alltså starta med
 * testinloggningen om NODE_ENV=production. Hemligheten slumpas fram vid varje start om ingen är
 * satt; det finns inget inbyggt standardvärde som kunde följa med till en riktig server.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createControl } from '@vibesandbox/control';
import { signTestIdentity, testLoginPath } from '@vibesandbox/gateway';
import { createBuildRunner } from './byggkedja.ts';
import { loadConfig, platformAddresses } from './config.ts';
import type { PlatformConfig } from './config.ts';
import { exitWithStartupError, startPlatform } from './start.ts';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const TEMPLATE_DIST = join(REPO_ROOT, 'packages', 'app-template', 'dist');

/** `localtest.me` och alla dess underdomäner pekar på 127.0.0.1 — ingen ändring i hosts-filen behövs. */
const DEV_DOMAIN = 'localtest.me';
const DEV_PORT = '8787';

/** Samma som driftens standard i deploy/compose.yml. */
const DEV_LLM = {
  LLM_BASE_URL: 'https://api.berget.ai/v1',
  LLM_MODEL: 'zai-org/GLM-5.3-Flash',
  LLM_REASONING_EFFORT: 'low',
  BUILD_DRIVER: 'local',
} as const;

const DEV_IDENTITY = { userId: 'dev-anna', email: 'anna@example.org', roles: ['builder'] } as const;
const DEV_LOGIN_LIFETIME_SECONDS = 12 * 60 * 60;

/** Kör ett npm-skript. Utskriften går till standard fel, så att standard ut bara har loggrader. */
function npmRun(workspace: string, failure: string): void {
  const result = spawnSync('npm', ['run', 'build', '-w', workspace], {
    cwd: REPO_ROOT,
    stdio: ['ignore', process.stderr, process.stderr],
  });
  if (result.status !== 0) throw new Error(failure);
}

try {
  // Det som är satt i miljön vinner över utvecklingsvärdena.
  const fromEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ''),
  ) as Record<string, string>;
  const hasKey = fromEnvironment['LLM_API_KEY'] !== undefined || fromEnvironment['BERGET_API_KEY'] !== undefined;
  const port = fromEnvironment['PORT'] ?? DEV_PORT;

  let config: PlatformConfig = loadConfig({
    BASE_DOMAIN: DEV_DOMAIN,
    APP_DOMAIN: DEV_DOMAIN,
    DATA_DIR: join(PACKAGE_ROOT, 'data', 'dev'),
    PORT: port,
    PUBLIC_SCHEME: 'http',
    PUBLIC_PORT: port,
    IDENTITY_PROVIDER: 'test',
    TEST_IDENTITY_SECRET: randomBytes(48).toString('base64url'),
    ...(hasKey ? DEV_LLM : {}),
    ...fromEnvironment,
  });

  let buildRunner = await createBuildRunner(config);
  let builderNote: string | undefined;
  if (config.builder === undefined) {
    builderNote = 'Byggverktyget är avstängt: det kräver en nyckel till språkmodellen (BERGET_API_KEY i projektets .env).';
  } else if (buildRunner === undefined) {
    // Utvecklingsläget kör hellre som förut än inte alls. (I drift är detta ett startfel.)
    const { builder: _avstangt, ...utan } = config;
    config = utan;
    builderNote = 'Byggverktyget är avstängt: byggkedjan (@vibesandbox/build) är inte installerad än.';
  }

  npmRun('@vibesandbox/app-template', 'Appmallen gick inte att bygga. Har du kört "npm install --ignore-scripts"?');
  if (config.builder !== undefined) {
    npmRun('@vibesandbox/builder-ui', 'Byggverktygets webbgränssnitt gick inte att bygga.');
  }

  const control = createControl({ dataDir: config.dataDir });
  let appId;
  try {
    // Samma app återanvänds mellan körningarna, så att adressen — och appens data — finns kvar.
    appId = (await control.listApps())[0]?.appId ?? (await control.createApp());
    await control.publish(appId, await control.importVersion(appId, TEMPLATE_DIST));
  } finally {
    await control.close();
  }

  await startPlatform(config, buildRunner === undefined ? {} : { buildRunner });

  if (config.identity.provider !== 'test') throw new Error('Utvecklingsläget kräver IDENTITY_PROVIDER=test.');
  const secret = config.identity.testSecret;
  const addresses = platformAddresses(config);
  const address = addresses.published(appId);
  const origin = new URL(address).origin;
  const lifetime = { expiresInSeconds: DEV_LOGIN_LIFETIME_SECONDS };
  const authorization = signTestIdentity(DEV_IDENTITY, secret, lifetime);
  // Adresserna ÄR inloggningar. De skrivs bara till den lokala terminalen (standard fel), aldrig
  // till driftloggen, och hemligheten bakom dem slumpas om vid nästa start.
  const loginAddress = `${origin}${testLoginPath(DEV_IDENTITY, secret, lifetime)}`;
  // Inloggning sker per värd (host-only-kakor), så byggverktyget har en egen inloggningsadress.
  const builderLoginAddress = `${addresses.builderOrigin}${testLoginPath(DEV_IDENTITY, secret, lifetime)}`;
  console.error(
    [
      '',
      'Exempelappen är publicerad.',
      `  Adress:         ${address}`,
      `  Authorization:  ${authorization}`,
      '',
      'Öppna i webbläsaren — adressen loggar in webbläsaren som utvecklingsanvändaren:',
      `  ${loginAddress}`,
      '',
      ...(builderNote === undefined
        ? ['Byggverktyget — adressen loggar in webbläsaren där:', `  ${builderLoginAddress}`]
        : [builderNote]),
      '',
      'Prova med curl:',
      `  curl -H 'Authorization: ${authorization}' ${address}`,
      '',
      'Testinloggningen gäller i tolv timmar och bara för den här körningen.',
      '',
    ].join('\n'),
  );
} catch (error) {
  exitWithStartupError(error);
}
