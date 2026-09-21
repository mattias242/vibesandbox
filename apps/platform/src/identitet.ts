/**
 * Inloggningen, satt ihop efter konfigurationen. Här avgörs tre saker som hänger ihop med vilket
 * inloggningssätt som gäller:
 *
 *   - leverantören gatewayn frågar (`test` eller `email-otp`)
 *   - inbjudningarna byggverktyget gör när en app delas
 *   - adressen "öppna" ger: i testläge en testinloggningsadress på målvärden; med e-postinloggning
 *     en engångslänk på målvärden (en minut, same-site) som loggar in där utan ny kod
 */
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { DataApiError } from '@vibesandbox/contracts';
import type { AppMailer, AuthRequest, Identity, IdentityProvider, InvitationService, Role } from '@vibesandbox/contracts';
import { createTestIdentityProvider, testLoginPath } from '@vibesandbox/gateway';
import {
  countUsersByRole,
  createEmailOtpProvider,
  createMailgunSender,
  createOutboxSender,
  emailsByUserIds,
  identityDataDirectory,
  listUsers,
  normalizeEmail,
  openIdentityDatabase,
  setUserRole,
  upsertUser,
} from '@vibesandbox/identity';
import type { AddedUser, IdentityDatabase, MailSender, UserListing } from '@vibesandbox/identity';
import type { BuilderUser, BuilderUserDirectory, FeedbackMailer } from '@vibesandbox/builder';
import type { MailConfig, PlatformConfig } from './config.ts';
import type { PlatformLogger } from './logg.ts';

/** En testinloggningsadress är en inloggning i sig; den ska inte leva längre än en arbetsstund. */
const TEST_OPEN_LIFETIME_SECONDS = 15 * 60;

/** Binder id-härledningen till just det här ändamålet (samma hemlighet signerar testinloggningar). */
const TEST_USER_ID_CONTEXT = 'vibesandbox-test-user-id.v1.';

/**
 * Användar-id:t för en adress i testläge. Testinloggningen har inget användarregister — id:t i en
 * testinloggning är vad den som signerar skriver dit — så inbjudan HÄRLEDER ett id i stället:
 * `test-` + HMAC-SHA256(testhemligheten, adressen), 128 bitar i base64url. Samma adress (efter
 * normalisering) och hemlighet ger alltid samma id; utan hemligheten går det inte att räkna fram
 * ur adressen (samma princip som den riktiga tjänstens slumpade id). Den som vill logga in som
 * den inbjudna i testläge signerar en testidentitet med just detta id.
 * KASTAR `DataApiError('invalid_request')` för en ogiltig adress.
 */
export function testUserIdFor(email: string, testSecret: string): string {
  const normalized = normalizeEmail(email);
  if (normalized === null) throw new DataApiError('invalid_request', 'E-postadressen är ogiltig.');
  const digest = createHmac('sha256', testSecret).update(`${TEST_USER_ID_CONTEXT}${normalized}`).digest();
  return `test-${digest.subarray(0, 16).toString('base64url')}`;
}

export interface PlatformIdentity {
  readonly provider: IdentityProvider;
  readonly invitations: InvitationService;
  readonly openUrl: (identity: Identity, targetUrl: string) => string;
  /** Kontrollrummets väg till användarregistret. Finns i BÅDA inloggningslägena. */
  readonly users: BuilderUserDirectory;
  addUser(email: string, role: Role): Promise<AddedUser>;
  close(): Promise<void>;
}

/**
 * REGISTRET ÄR AUKTORITATIVT FÖR ROLLEN. Inloggningen säger VEM du är; registret säger vad du
 * FÅR GÖRA — när registret känner dig. En användare som registret inte känner behåller
 * inloggningens roller.
 *
 * Det senare är en möjlighet som bara testinloggningen har: i drift slås varje session upp mot
 * en användarrad, och identiteten byggs UR den raden (leverantor.ts, `sessionOnHost`) — rollen
 * kommer alltså redan därifrån vid varje förfrågan, och e-postinloggningen behöver ingen
 * omslagning. Testinloggningen bär i stället rollen i en signerad token, och utan det här
 * steget skulle en roll som sänks i registret inte märkas förrän tokenen gick ut.
 *
 * Följden är att en sänkning gäller DIREKT, i båda lägena, för en session som redan är inloggad.
 */
function withRegisteredRoles(provider: IdentityProvider, db: IdentityDatabase): IdentityProvider {
  return {
    name: provider.name,
    async authenticate(request: AuthRequest): Promise<Identity | null> {
      const who = await provider.authenticate(request);
      if (who === null) return null;
      const role = registeredRole(db, who.userId);
      return role === null ? who : { ...who, roles: [role] };
    },
    ...(provider.handleAuthRoute === undefined ? {} : { handleAuthRoute: (request) => provider.handleAuthRoute?.(request) ?? Promise.resolve(null) }),
    ...(provider.loginPath === undefined ? {} : { loginPath: provider.loginPath }),
  };
}

/**
 * Rollen registret har för ett användar-id, eller `null` när registret inte känner användaren.
 *
 * En linjär sökning i hela listan, eftersom identitetspaketet i dag inte lämnar ut någon
 * uppslagning på id. Den är billig här av ett skäl som är värt att skriva ut: vägen hit går bara
 * genom testinloggningen (se ovan), och den körs aldrig i drift — testinloggningen vägrar starta
 * när `NODE_ENV=production`. Lämnar identiteten någon gång ut en uppslagning på id blir det här
 * en fråga i stället för en lista.
 */
function registeredRole(db: IdentityDatabase, userId: string): Role | null {
  for (const user of listUsers(db)) {
    if (user.userId === userId) return user.role;
  }
  return null;
}

/**
 * Bryggan byggverktygets kontrollrum får: identitetspaketets fyra funktioner, bundna till ett
 * handtag mot identitetsdatabasen. Byggverktyget känner varken SQL:en eller schemat — det ser
 * bara `BuilderUserDirectory` (se packages/builder/src/anvandare.ts).
 *
 * Handtaget är ett EGET, vid sidan av inloggningsleverantörens: kontrollrummet läser och ändrar
 * användare utan att gå genom inloggningsflödet, och identitetspaketet lämnar därför ut
 * `openIdentityDatabase`. Samma fil, WAL-läge och `busy_timeout` — SQLite ordnar turordningen
 * mellan de två handtagen.
 */
function userDirectory(db: IdentityDatabase, addUser: (email: string, role: Role, now: number) => Promise<AddedUser>): BuilderUserDirectory {
  return {
    list: () => listUsers(db).map(listed),
    countByRole: () => countUsersByRole(db),
    emails: (userIds) => emailsByUserIds(db, userIds),
    /**
     * Inbjudan går samma väg som plattformens egen `addUser` — `upsertUser` i botten, alltså
     * lägg till eller HÖJ, aldrig sänk, och inget mejl. Med e-postinloggning går den genom
     * leverantören, som dessutom för in händelsen `user_added` i identitetens logg: att någon
     * fick rätt att logga in ska gå att se i efterhand, precis som `role_changed` när en roll
     * sänks. Därför är den asynkron.
     *
     * Adressen normaliseras här för att kunna GES TILLBAKA i svaret — `addUser` lämnar bara
     * användar-id och roll, och det är samma normalisering som avgör vilken rad som träffas.
     * En ogiltig adress stannar här, med identitetens eget felslag.
     */
    invite: async (email, role, now) => {
      const normalized = normalizeEmail(email);
      if (normalized === null) throw new DataApiError('invalid_request', 'E-postadressen är ogiltig.');
      const added = await addUser(normalized, role, now);
      // Tidpunkten kommer ur listningen; `addUser` lämnar bara id och roll. `null` betyder
      // "vet inte" — aldrig en gissad tidpunkt, och aldrig ett tomt fält som ser ut som ett svar.
      return { userId: added.userId, email: normalized, role: added.role, createdAt: null };
    },
    // `setUserRole` är den enda vägen att SÄNKA en roll, och skriver `role_changed` själv.
    setRole: (userId, role, now) => ({ ...record(setUserRole(db, userId, role, now)), createdAt: null }),
  };
}

/** En rad ur registret som kontrollrummet kan visa. */
function record(user: { readonly userId: string; readonly email: string; readonly role: Role }): Omit<BuilderUser, 'createdAt'> {
  return { userId: user.userId, email: user.email, role: user.role };
}

/**
 * Tidpunkten lagras som millisekunder sedan epoken; kontrollrummet visar ISO 8601. En rad utan
 * läsbar tidpunkt (i praktiken en skadad databas — kolumnen är `NOT NULL`) tas med ändå, med
 * `null` i stället för datum: en osynlig behörighet vore farligare än ett saknat datum, och en
 * gissad tidpunkt vore en lögn.
 */
function listed(user: UserListing): BuilderUser {
  return { ...record(user), createdAt: user.createdAt === null ? null : new Date(user.createdAt).toISOString() };
}

function mailSender(mail: MailConfig): MailSender {
  if (mail.kind === 'outbox') return createOutboxSender({ directory: mail.directory });
  return createMailgunSender({ apiKey: mail.apiKey, domain: mail.domain, from: mail.from, region: 'eu' });
}

/**
 * Mejl för plattformstjänsterna (aviseringar): samma väg som inloggningskoderna. I testläge finns
 * inget mejl — då saknas tjänsternas `mailer`, och en tjänst som kräver den vägrar starta.
 */
export function platformMailer(config: PlatformConfig): AppMailer | undefined {
  return config.identity.provider === 'test' ? undefined : mailSender(config.identity.mail);
}

/** Katalogen återkopplingen hamnar i när det inte finns någon adress att mejla den till. */
const FEEDBACK_OUTBOX_DIRECTORY = 'aterkoppling';

/**
 * Vägen för återkoppling PÅ BYGGVERKTYGET till plattformens ägare — samma mejlväg som
 * inloggningskoderna, men till en människa: `PLATFORM_OWNER_EMAIL`.
 *
 * Finns ingen mejltjänst (testläge) eller ingen ägaradress skrivs mejlen som filer under
 * datakatalogen i stället. Återkoppling som ingen får läsa är borta för alltid, och det är ett
 * sämre utfall än en fil på en disk som bara plattformen kommer åt.
 */
export function platformFeedback(config: PlatformConfig): FeedbackMailer {
  const to = config.ownerEmail;
  const sender = config.identity.provider === 'test' ? undefined : mailSender(config.identity.mail);
  if (to !== undefined && sender !== undefined) {
    return { send: (mail) => sender.send({ to, subject: mail.subject, text: mail.text }) };
  }
  const outbox = createOutboxSender({ directory: join(config.dataDir, FEEDBACK_OUTBOX_DIRECTORY) });
  const recipient = to ?? `agare@${config.baseDomain}`;
  return { send: (mail) => outbox.send({ to: recipient, subject: mail.subject, text: mail.text }) };
}

export function createPlatformIdentity(config: PlatformConfig, log: PlatformLogger): PlatformIdentity {
  const identity = config.identity;

  const directory = identityDataDirectory(config.dataDir);

  if (identity.provider === 'test') {
    const secret = identity.testSecret;
    // Användarregistret öppnas också här. Testinloggningen har inget eget register — men rollerna
    // bor i ett och samma register oavsett hur man loggade in, och kontrollrummet ska gå att
    // pröva: att sänka sin egen roll, och att en sänkning gäller direkt, går inte att visa mot
    // ett register som inte finns.
    const db = openIdentityDatabase(directory);
    const addUser = async (email: string, role: Role, now = Date.now()): Promise<AddedUser> => {
      const user = upsertUser(db, email, role, now);
      return { userId: user.userId, role: user.role };
    };
    return {
      provider: withRegisteredRoles(createTestIdentityProvider({ secret }), db),
      invitations: {
        async invite(request) {
          // Samma krav på adressen som den riktiga tjänsten, så att byggverktyget beter sig likadant.
          const email = normalizeEmail(request.email);
          if (email === null) throw new DataApiError('invalid_request', 'E-postadressen är ogiltig.');
          // Det finns ingen mejltjänst i testläge. Inbjudan noteras — utan adressen.
          log({ source: 'platform', level: 'info', event: 'invitation_noted', userId: request.invitedBy.userId, role: request.role });
          // Id:t HÄRLEDS ur adressen (se testUserIdFor) och kommer inte ur registret: den som vill
          // logga in som den inbjudna i testläge signerar en testidentitet med just det id:t.
          return { userId: testUserIdFor(email, secret), email };
        },
      },
      openUrl: (who, targetUrl) =>
        `${new URL(targetUrl).origin}${testLoginPath(who, secret, { expiresInSeconds: TEST_OPEN_LIFETIME_SECONDS })}`,
      users: userDirectory(db, addUser),
      addUser: (email, role) => addUser(email, role),
      close: () => {
        db.close();
        return Promise.resolve();
      },
    };
  }

  const provider = createEmailOtpProvider({
    dataDirectory: directory,
    secret: identity.secret,
    publicScheme: config.publicScheme,
    ...(config.publicPort === undefined ? {} : { publicPort: config.publicPort }),
    mailSender: mailSender(identity.mail),
    logger: (entry) => log({ source: 'identity', ...entry }),
    // Ingen `clientAddress`: bakom den omvända proxyn är TCP-motparten alltid proxyn, och en gräns
    // "per klient" skulle då bli en gräns för hela plattformen. Gränserna per adress och totalt gäller.
  });
  // Efter leverantören: den prövar hemligheten och migrerar databasen. Går det här handtaget
  // inte att öppna stängs leverantören igen, så att inget ligger kvar öppet efter ett startfel.
  let db: IdentityDatabase;
  try {
    db = openIdentityDatabase(directory);
  } catch (error) {
    void provider.close().catch(() => {});
    throw error;
  }
  return {
    provider,
    invitations: provider,
    // En engångslänk som loggar in på målets värd utan ny kod (förhandsvisningen i byggverktyget).
    openUrl: (who, targetUrl) => provider.handoffUrl(who, targetUrl),
    // Samma väg som plattformens `addUser`: leverantörens, som också skriver `user_added`.
    users: userDirectory(db, (email, role) => provider.addUser(email, role)),
    addUser: (email, role) => provider.addUser(email, role),
    // Leverantören först: den väntar in mejl som är på väg. Kontrollrummets handtag stängs
    // efteråt, och alltid — även om leverantören fallerar.
    close: async () => {
      try {
        await provider.close();
      } finally {
        db.close();
      }
    },
  };
}
