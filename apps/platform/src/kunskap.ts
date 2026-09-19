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
import { readTemplateKnowledge } from '@vibesandbox/build';
import { TEMPLATE_DIRECTORY } from './byggkedja.ts';

const SDK_README = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'sdk', 'README.md');

export async function loadAgentKnowledge(templateDirectory: string = TEMPLATE_DIRECTORY): Promise<AgentKnowledge> {
  const [sdkReference, template] = await Promise.all([readFile(SDK_README, 'utf8'), readTemplateKnowledge(templateDirectory)]);
  return { sdkReference, exampleFiles: template.exampleFiles, starterFiles: template.starterFiles };
}
