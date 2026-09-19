/**
 * Det agenten vet om plattformen, läst från repot EN gång vid start: SDK:ts referens (dess README,
 * ordagrant), och ur mallen exempelappen och startfilerna en ny app börjar från
 * (`readTemplateKnowledge` — samma mall som bygger apparna).
 *
 * Läses från disk i stället för att skrivas in här, så att det modellen får se alltid är samma
 * text som människor läser och samma kod som mallen faktiskt bygger.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentKnowledge } from '@vibesandbox/agent';
import { APP_SERVICE_NAMES } from '@vibesandbox/contracts';
import { readTemplateKnowledge } from '@vibesandbox/build';
import { TEMPLATE_DIRECTORY } from './byggkedja.ts';

const SDK_README = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'sdk', 'README.md');
/** En fil per plattformstjänst: `<namn>.md`. Tom fil = tjänsten har ännu inget att visa. */
const SERVICE_DOCS = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'sdk', 'tjanster');

/**
 * Dokumentationen för de PÅSLAGNA tjänsterna, i plattformens ordning. En avslagen tjänst nämns
 * inte: agenten skulle annars skriva appar som anropar något som svarar 404.
 */
export async function serviceReference(enabled: readonly string[], directory: string = SERVICE_DOCS): Promise<string> {
  const on = new Set(enabled);
  const parts: string[] = [];
  for (const name of APP_SERVICE_NAMES) {
    if (!on.has(name)) continue;
    const text = (await readFile(resolve(directory, `${name}.md`), 'utf8').catch(() => '')).trim();
    if (text !== '') parts.push(text);
  }
  return parts.length === 0 ? '' : `\n\n# Plattformstjänster\n\n${parts.join('\n\n')}\n`;
}

export async function loadAgentKnowledge(
  templateDirectory: string = TEMPLATE_DIRECTORY,
  enabledServices: readonly string[] = [],
): Promise<AgentKnowledge> {
  const [sdkReadme, services, template] = await Promise.all([
    readFile(SDK_README, 'utf8'),
    serviceReference(enabledServices),
    readTemplateKnowledge(templateDirectory),
  ]);
  return { sdkReference: sdkReadme + services, exampleFiles: template.exampleFiles, starterFiles: template.starterFiles };
}
