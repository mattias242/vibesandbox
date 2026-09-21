/**
 * @vibesandbox/identity — inloggning med engångskod via mejl för uttryckligen inbjudna adresser,
 * och inbjudningar. Se leverantor.ts för flödet och säkerhetsbesluten.
 */
export { createEmailOtpProvider, DEFAULT_IDENTITY_LIMITS, MIN_SECRET_BYTES } from './leverantor.ts';
export type { AddedUser, EmailOtpProvider, EmailOtpProviderOptions, IdentityLimits } from './leverantor.ts';
export { createMailgunSender, createOutboxSender } from './mejl.ts';
export type { MailMessage, MailSender, MailgunOptions, OutboxOptions, OutboxSender } from './mejl.ts';
// `upsertUser` lägger till eller HÖJER en roll; `setUserRole` är enda vägen att sänka. Båda
// behövs utifrån: plattformen skriver registerrader också med testinloggningen, så att en
// testsession kan bära samma användar-id som registret.
export { countUsersByRole, emailsByUserIds, listUsers, setUserRole, upsertUser } from './anvandare.ts';
export type { UserListing, UserRecord } from './anvandare.ts';
// Kontrollrummet läser och ändrar användare utan att gå via inloggningsflödet, och behöver
// därför ett eget handtag till identitetsdatabasen.
export { openIdentityDatabase } from './databas.ts';
export type { IdentityDatabase } from './databas.ts';
export { normalizeEmail } from './adress.ts';
export { safeNext } from './nasta.ts';
export { identityDataDirectory, runIdentityCli } from './kommando.ts';
export type { CliOutput } from './kommando.ts';
export type { IdentityEvent, IdentityLogEntry, IdentityLogger, LoginFailure } from './logg.ts';
