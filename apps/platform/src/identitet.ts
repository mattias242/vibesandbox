/**
 * Inloggningen, satt ihop efter konfigurationen. Här avgörs tre saker som hänger ihop med vilket
 * inloggningssätt som gäller:
 *
 *   - leverantören gatewayn frågar (`test` eller `email-otp`)
 *   - inbjudningarna byggverktyget gör när en app delas
 *   - adressen "öppna" ger: i testläge en testinloggningsadress på målvärden; med e-postinloggning
 *     en engångslänk på målvärden (en minut, same-site) som loggar in där utan ny kod
 */
import { DataApiError } from '@vibesandbox/contracts';
import type { Identity, IdentityProvider, InvitationService, Role } from '@vibesandbox/contracts';
import { createTestIdentityProvider, testLoginPath } from '@vibesandbox/gateway';
import {
  createEmailOtpProvider,
  createMailgunSender,
  createOutboxSender,
  identityDataDirectory,
  normalizeEmail,
} from '@vibesandbox/identity';
import type { AddedUser, MailSender } from '@vibesandbox/identity';
import type { MailConfig, PlatformConfig } from './config.ts';
import type { PlatformLogger } from './logg.ts';

/** En testinloggningsadress är en inloggning i sig; den ska inte leva längre än en arbetsstund. */
const TEST_OPEN_LIFETIME_SECONDS = 15 * 60;

export interface PlatformIdentity {
  readonly provider: IdentityProvider;
  readonly invitations: InvitationService;
  readonly openUrl: (identity: Identity, targetUrl: string) => string;
  addUser(email: string, role: Role): Promise<AddedUser>;
  close(): Promise<void>;
}

function mailSender(mail: MailConfig): MailSender {
  if (mail.kind === 'outbox') return createOutboxSender({ directory: mail.directory });
  return createMailgunSender({ apiKey: mail.apiKey, domain: mail.domain, from: mail.from, region: 'eu' });
}

export function createPlatformIdentity(config: PlatformConfig, log: PlatformLogger): PlatformIdentity {
  const identity = config.identity;

  if (identity.provider === 'test') {
    const secret = identity.testSecret;
    return {
      provider: createTestIdentityProvider({ secret }),
      invitations: {
        async invite(request) {
          // Samma krav på adressen som den riktiga tjänsten, så att byggverktyget beter sig likadant.
          if (normalizeEmail(request.email) === null) throw new DataApiError('invalid_request', 'E-postadressen är ogiltig.');
          // Det finns ingen mejltjänst i testläge. Inbjudan noteras — utan adressen.
          log({ source: 'platform', level: 'info', event: 'invitation_noted', userId: request.invitedBy.userId, role: request.role });
        },
      },
      openUrl: (who, targetUrl) =>
        `${new URL(targetUrl).origin}${testLoginPath(who, secret, { expiresInSeconds: TEST_OPEN_LIFETIME_SECONDS })}`,
      addUser: () => Promise.reject(new Error('Testinloggningen har inga användare att lägga till.')),
      close: () => Promise.resolve(),
    };
  }

  const provider = createEmailOtpProvider({
    dataDirectory: identityDataDirectory(config.dataDir),
    secret: identity.secret,
    publicScheme: config.publicScheme,
    ...(config.publicPort === undefined ? {} : { publicPort: config.publicPort }),
    mailSender: mailSender(identity.mail),
    logger: (entry) => log({ source: 'identity', ...entry }),
    // Ingen `clientAddress`: bakom den omvända proxyn är TCP-motparten alltid proxyn, och en gräns
    // "per klient" skulle då bli en gräns för hela plattformen. Gränserna per adress och totalt gäller.
  });
  return {
    provider,
    invitations: provider,
    // En engångslänk som loggar in på målets värd utan ny kod (förhandsvisningen i byggverktyget).
    openUrl: (who, targetUrl) => provider.handoffUrl(who, targetUrl),
    addUser: (email, role) => provider.addUser(email, role),
    close: () => provider.close(),
  };
}
