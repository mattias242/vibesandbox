/**
 * CLI för användare, så att den första byggaren kan läggas in på servern:
 *
 *   DATA_DIR=/srv/vibesandbox npm run anvandare -w @vibesandbox/identity -- lagg-till anna@example.org builder
 *
 * Kräver ingen hemlighet och skickar inget mejl: det enda som behövs är databasen. Adressen
 * skrivs aldrig ut — bara användar-id och roll.
 */
import { isAbsolute, join } from 'node:path';
import { DataApiError } from '@vibesandbox/contracts';
import { normalizeEmail } from './adress.ts';
import { findUserByEmail, isRole, setUserRole, upsertUser } from './anvandare.ts';
import { openIdentityDatabase } from './databas.ts';

/** Var identitetsdatabasen ligger under plattformens datakatalog. Plattformen ska använda samma. */
export function identityDataDirectory(dataDir: string): string {
  return join(dataDir, 'identity');
}

export interface CliOutput {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  'Användning: anvandare lagg-till <e-postadress> <admin|builder|viewer>',
  '            anvandare satt-roll <e-postadress> <admin|builder|viewer>',
  'Miljö: DATA_DIR (absolut sökväg till plattformens datakatalog).',
  'lagg-till lägger till adressen, eller höjer dess roll. En roll sänks aldrig.',
  'satt-roll sätter rollen rakt av på en adress som redan finns — även nedåt.',
];

/** 0 = klart, 1 = fel under körningen, 2 = fel användning. */
export async function runIdentityCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: CliOutput,
): Promise<0 | 1 | 2> {
  const usage = (problem: string): 2 => {
    output.err(problem);
    for (const line of USAGE) output.err(line);
    return 2;
  };

  const [command, email, role, ...rest] = argv;
  if ((command !== 'lagg-till' && command !== 'satt-roll') || email === undefined || role === undefined || rest.length > 0) {
    return usage('Okänt kommando eller fel antal argument.');
  }
  if (!isRole(role)) return usage('Rollen ska vara admin, builder eller viewer.');
  const address = normalizeEmail(email);
  if (address === null) return usage('E-postadressen är ogiltig.');

  const dataDir = env['DATA_DIR'];
  if (dataDir === undefined || !isAbsolute(dataDir) || dataDir.includes(String.fromCharCode(0))) {
    return usage('DATA_DIR saknas eller är inte en absolut sökväg.');
  }

  let db;
  try {
    db = openIdentityDatabase(identityDataDirectory(dataDir));
    if (command === 'satt-roll') {
      // satt-roll skapar aldrig en användare: en felstavad adress ska bli ett fel, inte ett konto.
      const existing = findUserByEmail(db, address);
      if (existing === null) {
        output.err('Det finns ingen användare med den adressen.');
        return 1;
      }
      const user = setUserRole(db, existing.userId, role, Date.now());
      output.out(`Användaren ${user.userId} har nu rollen ${user.role}.`);
      return 0;
    }
    const user = upsertUser(db, email, role, Date.now());
    output.out(
      user.created
        ? `Lade till användaren ${user.userId} med rollen ${user.role}.`
        : `Användaren ${user.userId} fanns redan och har nu rollen ${user.role}.`,
    );
    return 0;
  } catch (error) {
    output.err(error instanceof DataApiError ? error.message : 'Kunde inte spara användaren.');
    return 1;
  } finally {
    db?.close();
  }
}
