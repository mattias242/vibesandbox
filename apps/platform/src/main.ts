/**
 * Plattformens startpunkt i drift.
 *
 *   npm start -w @vibesandbox/platform
 *
 * Läser konfigurationen ur miljön (och ur `.env` bredvid paketet, om den finns), vägrar starta om
 * något är fel, och lyssnar sedan tills processen får SIGTERM eller SIGINT.
 */
import { loadConfig } from './config.ts';
import { exitWithStartupError, startPlatform } from './start.ts';

try {
  await startPlatform(loadConfig(process.env));
} catch (error) {
  exitWithStartupError(error);
}
