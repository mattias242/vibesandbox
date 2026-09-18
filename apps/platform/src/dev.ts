/**
 * Lokal utveckling i ett kommando:
 *
 *   npm run dev -w @vibesandbox/platform
 *
 * Bygger appmallen, ser till att det finns en app i den lokala datakatalogen, publicerar bygget
 * och startar plattformen. Skriver sedan ut appens adress och ett färdigt `Authorization`-värde
 * för testinloggningen, så att det går att prova med curl direkt.
 *
 * Allt går genom samma `loadConfig` som i drift — även här vägrar plattformen alltså starta med
 * testinloggningen om NODE_ENV=production. Hemligheten slumpas fram vid varje start om ingen är
 * satt; det finns inget inbyggt standardvärde som kunde följa med till en riktig server.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createControl } from '@vibesandbox/control';
import { signTestIdentity } from '@vibesandbox/gateway';
import { loadConfig } from './config.ts';
import { exitWithStartupError, startPlatform } from './start.ts';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const TEMPLATE_DIST = join(REPO_ROOT, 'packages', 'app-template', 'dist');

/** `localtest.me` och alla dess underdomäner pekar på 127.0.0.1 — ingen ändring i hosts-filen behövs. */
const DEV_DOMAIN = 'localtest.me';

const DEV_IDENTITY = { userId: 'dev-anna', email: 'anna@example.org', roles: ['builder'] } as const;
const DEV_LOGIN_LIFETIME_SECONDS = 12 * 60 * 60;

try {
  const config = loadConfig({
    BASE_DOMAIN: DEV_DOMAIN,
    APP_DOMAIN: DEV_DOMAIN,
    DATA_DIR: join(PACKAGE_ROOT, 'data', 'dev'),
    PORT: '8787',
    IDENTITY_PROVIDER: 'test',
    TEST_IDENTITY_SECRET: randomBytes(48).toString('base64url'),
    // Det som är satt i miljön vinner över utvecklingsvärdena ovan.
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined && value !== '')),
  });

  // Bygget körs som ett vanligt npm-skript. Dess utskrift går till standard fel, så att
  // standard ut bara innehåller plattformens loggrader och adressen nedan.
  const build = spawnSync('npm', ['run', 'build', '-w', '@vibesandbox/app-template'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', process.stderr, process.stderr],
  });
  if (build.status !== 0) throw new Error('Appmallen gick inte att bygga. Har du kört "npm install --ignore-scripts"?');

  const control = createControl({ dataDir: config.dataDir });
  let appId;
  try {
    // Samma app återanvänds mellan körningarna, så att adressen — och appens data — finns kvar.
    appId = (await control.listApps())[0]?.appId ?? (await control.createApp());
    await control.publish(appId, await control.importVersion(appId, TEMPLATE_DIST));
  } finally {
    await control.close();
  }

  const { listening } = await startPlatform(config);

  const address = `http://${appId}.${config.appDomain}:${listening.port}/`;
  const authorization = signTestIdentity(DEV_IDENTITY, config.identity.testSecret, {
    expiresInSeconds: DEV_LOGIN_LIFETIME_SECONDS,
  });
  console.error(
    [
      '',
      'Exempelappen är publicerad.',
      `  Adress:         ${address}`,
      `  Authorization:  ${authorization}`,
      '',
      'Prova:',
      `  curl -H 'Authorization: ${authorization}' ${address}`,
      '',
      'Testinloggningen gäller i tolv timmar och bara för den här körningen. En webbläsare kan inte',
      'skicka huvudet av sig själv; det blir möjligt att öppna appen där när e-postinloggningen finns.',
      '',
    ].join('\n'),
  );
} catch (error) {
  exitWithStartupError(error);
}
