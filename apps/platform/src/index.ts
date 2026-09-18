/**
 * Paketets publika yta. Används av BDD-stegen, som startar en riktig plattform per scenario.
 * Startpunkterna `main.ts`, `dev.ts` och `cli.ts` körs direkt och exporteras inte.
 */
export { ConfigError, loadConfig } from './config.ts';
export type { Environment, PlatformConfig } from './config.ts';
export { createPlatform } from './server.ts';
export type { ListenInfo, Platform } from './server.ts';
