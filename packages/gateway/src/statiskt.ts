/**
 * Appens byggda, statiska filer. Sökvägen som når `AppFiles.read` byggs ALLTID ur de redan
 * godkända segmenten från sokvag.ts — aldrig ur den råa förfrågan — och kan därför inte
 * innehålla `..`, NUL, bakåtstreck eller procentkodning.
 */
import type { ServerResponse } from 'node:http';
import type { AppFiles, TenantContext } from '@vibesandbox/contracts';
import { methodNotAllowed, notFound } from './fel.ts';
import { sendFile } from './svar.ts';

const INDEX_PATH = '/index.html';

export interface StaticRequest {
  readonly response: ServerResponse;
  readonly method: string;
  readonly segments: readonly string[];
  readonly tenant: TenantContext;
  readonly files: AppFiles;
}

export async function handleStatic(request: StaticRequest): Promise<void> {
  const { method, segments, tenant, files, response } = request;
  if (method !== 'GET' && method !== 'HEAD') throw methodNotAllowed(['GET', 'HEAD']);

  if (segments.length === 0) {
    const index = await files.read(tenant, INDEX_PATH);
    if (index === null) throw notFound();
    sendFile(response, index);
    return;
  }

  const file = await files.read(tenant, `/${segments.join('/')}`);
  if (file !== null) {
    sendFile(response, file);
    return;
  }

  // SPA-fallback: adresser som `/installningar/konto` är sidor i appen, inte filer. Bara sökvägar
  // UTAN filändelse faller tillbaka — en saknad `bild.png` ska ge 404, inte en HTML-sida som
  // webbläsaren sedan försöker tolka som bild.
  const lastSegment = segments[segments.length - 1] ?? '';
  if (lastSegment.includes('.')) throw notFound();

  const index = await files.read(tenant, INDEX_PATH);
  if (index === null) throw notFound();
  sendFile(response, index);
}
