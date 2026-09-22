/**
 * Från validerat värdnamn till `TenantContext`.
 *
 * DETTA ÄR DET ENDA STÄLLET I HELA PLATTFORMEN som anropar `unsafeCreateTenantContext`. Två
 * funktioner gör det, och båda bor här just för att en granskare ska hitta hela ytan på ett
 * ställe: `resolveTenant` för vanliga förfrågningar, och `tenantForLifecycle` för avveckling och
 * export. Kommer det någonsin en tredje ska den också stå här.
 * Ett kontext skapas först när (1) värdnamnet matchat allowlisten i vardnamn.ts — enda vägen
 * till ett `ParsedHost` — (2) registret bekräftat att appen finns och har just den version
 * värdnamnet pekar på, och (3) registret bekräftat att den inloggade har en roll i appen som
 * räcker för den versionen (features/delning/appatkomst.feature). Ingenting ur sökväg, fråga,
 * kropp eller andra huvuden når den här filen.
 *
 * Hanteraren anropar detta EFTER autentiseringen: en oinloggad ska varken kunna avgöra om ett
 * app-id finns eller kosta plattformen ett registeruppslag.
 */
import { unsafeCreateTenantContext } from '@vibesandbox/contracts';
import type { AppAccessRole, AppId, AppRegistry, TenantContext, TenantKind } from '@vibesandbox/contracts';
import { appNotFound } from './fel.ts';
import { describeError } from './logg.ts';
import type { GatewayLogger } from './logg.ts';
import type { ParsedHost } from './vardnamn.ts';

/**
 * Vilka roller som når vilken version. Utkastet är ägarens arbetsmaterial; den publicerade appen
 * når alla som fått den delad med sig. Plattformsroller (`Identity.roles`, även `admin`) ingår
 * medvetet inte här: de ger ingen genväg förbi delningen.
 */
const ROLES_ALLOWED: Readonly<Record<TenantKind, readonly AppAccessRole[]>> = {
  published: ['owner', 'user'],
  draft: ['owner'],
};

/**
 * Frågar registret om användarens roll — vid VARJE förfrågan, utan cache, så att en borttagen
 * åtkomst gäller direkt även för en pågående session. Kastar registret blir det "ingen åtkomst"
 * (osäkerhet ⇒ neka), aldrig 500: ett 500 skulle både skilja sig från "appen finns inte" och
 * avslöja att just den här appen fick registret att fallera. Felet göms inte för driften.
 */
async function roleOf(
  registry: AppRegistry,
  appId: AppId,
  userId: string,
  log: GatewayLogger,
): Promise<AppAccessRole | null> {
  try {
    return await registry.accessFor(appId, userId);
  } catch (error) {
    log({ level: 'error', event: 'app_registry_failed', ...describeError(error) });
    return null;
  }
}

/**
 * `userId` är den autentiserade identitetens — den enda uppgift om VEM som når hit. Vilken app
 * det gäller kommer bara ur `parsed`, dvs. värdnamnet.
 */
export async function resolveTenant(
  parsed: ParsedHost,
  registry: AppRegistry,
  userId: string,
  log: GatewayLogger,
): Promise<{ readonly tenant: TenantContext; readonly access: AppAccessRole }> {
  const app = await registry.find(parsed.appId);

  // Samma svar för "appen finns inte" och "appen saknar den här versionen", så att svaret inte
  // röjer att ett utkast eller en publicering existerar. Jämförelsen av app-id är ett skydd mot
  // ett register som av misstag svarar med en annan app än den vi frågade efter.
  if (app === null || app.appId !== parsed.appId) throw appNotFound();
  const versionExists = parsed.kind === 'published' ? app.published === true : app.draft === true;
  if (!versionExists) throw appNotFound();

  // Åtkomst. Saknad åtkomst ger EXAKT samma fel som en app som inte finns: samma kod, text,
  // status och huvuden — annars kan vem som helst som är inloggad kartlägga vilka app-id som
  // finns. Rollen jämförs mot en allowlist; ett värde registret inte borde kunna ge (fel
  // skiftläge, `admin`, ett objekt) är ingen roll.
  const role = await roleOf(registry, parsed.appId, userId, log);
  if (role === null || !ROLES_ALLOWED[parsed.kind].includes(role)) {
    log({ level: 'warn', event: 'app_access_denied' });
    throw appNotFound();
  }

  return { tenant: unsafeCreateTenantContext(parsed.appId, parsed.kind), access: role };
}

/**
 * Hyresgästerna för en apps LIVSCYKEL — export och avveckling. Ingen förfrågan till appen går
 * genom den här vägen; den finns för att en app ska gå att tömma och ta bort.
 *
 * Här finns inget värdnamn att gå på, och det är precis vad som gör funktionen känslig: app-id:t
 * kommer ur en sökväg, vilket `resolveTenant` aldrig tillåter. Därför står kravet i stället på
 * ÄGARSKAP, och det prövas mot registret HÄR — inte bara hos den som ringer. Den som bara fått
 * appen delad med sig är `user` och kommer inte förbi. En plattformsroll spelar ingen roll: en
 * administratör har enligt kontraktet ingen åtkomst till någon apps data, och det gäller också
 * när appen ska bort.
 *
 * Båda versionerna lämnas tillbaka. En avveckling som bara tömde den publicerade hade lämnat
 * utkastets databas kvar på disken, och det är just sådant som gör ett gallringsbevis osant.
 */
export async function tenantForLifecycle(
  registry: AppRegistry,
  appId: AppId,
  userId: string,
  log: GatewayLogger,
): Promise<{ readonly published: TenantContext; readonly draft: TenantContext }> {
  const app = await registry.find(appId);
  if (app === null || app.appId !== appId) throw appNotFound();
  const role = await roleOf(registry, appId, userId, log);
  if (role !== 'owner') {
    log({ level: 'warn', event: 'app_access_denied' });
    throw appNotFound();
  }
  return {
    published: unsafeCreateTenantContext(appId, 'published'),
    draft: unsafeCreateTenantContext(appId, 'draft'),
  };
}
