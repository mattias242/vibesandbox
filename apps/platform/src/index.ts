/**
 * Paketets publika yta. Används av BDD-stegen, som startar en riktig plattform per scenario.
 * Startpunkterna `main.ts`, `dev.ts` och `cli.ts` körs direkt och exporteras inte.
 */
export { ConfigError, DEFAULT_BUILDER_UI_DIR, loadConfig, platformAddresses } from './config.ts';
export type { BuilderConfig, Environment, IdentityConfig, MailConfig, PlatformAddresses, PlatformConfig } from './config.ts';
export { BUILT_IN_STARTER_FILES, loadAgentKnowledge } from './kunskap.ts';
export type { PlatformLogEntry, PlatformLogger } from './logg.ts';
export { createPlatform } from './server.ts';
export type { ListenInfo, Platform, PlatformDependencies } from './server.ts';
