import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AppFiles,
  AppRegistry,
  Identity,
  IdentityProvider,
  TenantStore,
} from '@vibesandbox/contracts';

export interface GatewayOptions {
  /** Publicerade appar nås på `<appId>.<appDomain>`. */
  readonly appDomain: string;
  /** Förhandsvisningar (utkast) nås på `p-<appId>.<previewDomain>`. */
  readonly previewDomain: string;
  readonly identityProvider: IdentityProvider;
  readonly registry: AppRegistry;
  readonly files: AppFiles;
  readonly store: TenantStore;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

/** Hela gatewayn som en vanlig `node:http`-hanterare. */
export function createGateway(_options: GatewayOptions): RequestHandler {
  throw new Error('inte implementerat');
}

export interface TestIdentityProviderOptions {
  /** Delad hemlighet för HMAC-signering av testinloggningar. */
  readonly secret: string;
}

/**
 * Inloggning för tester och lokal utveckling: `Authorization: Test <payload>.<signatur>`.
 * Ska vägra skapas när `NODE_ENV=production`.
 */
export function createTestIdentityProvider(_options: TestIdentityProviderOptions): IdentityProvider {
  throw new Error('inte implementerat');
}

/** Skapar värdet till `Authorization`-huvudet för en testidentitet. */
export function signTestIdentity(_identity: Identity, _secret: string): string {
  throw new Error('inte implementerat');
}
