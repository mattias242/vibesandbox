/**
 * Data-API:ts rutter (se `API_PREFIX` i kontraktet). Hit kommer en förfrågan först när
 * hyresgäst, inloggning och CSRF-skydd redan är avgjorda; `tenant` och `identity` är de enda
 * uppgifterna om VEM och VILKEN APP, och ingen av dem kan påverkas härifrån.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_REQUEST_BODY_BYTES } from '@vibesandbox/contracts';
import type { CollectionScope, Identity, TenantContext, TenantStore, WhoAmIResponse } from '@vibesandbox/contracts';
import { invalidRequest, methodNotAllowed, notFound } from './fel.ts';
import { assertJsonContentType, parseDocumentBody, readBody } from './kropp.ts';
import { sendJson, sendNoContent } from './svar.ts';

export interface ApiRequest {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  /** Segmenten EFTER `_api`, redan normaliserade av sokvag.ts. */
  readonly segments: readonly string[];
  readonly query: string;
  readonly tenant: TenantContext;
  readonly identity: Identity;
  readonly store: TenantStore;
}

/**
 * Grov formkontroll av kollektionsnamn och dokument-id. De exakta reglerna äger data-API:t
 * (`COLLECTION_NAME_PATTERN`, `DOCUMENT_ID_PATTERN`); här stoppas bara sådant som aldrig kan
 * vara giltigt, så att lagret aldrig ser punkter, blanktecken eller överlånga värden.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const MAX_CURSOR_LENGTH = 512;

function assertName(value: string, what: string): void {
  if (!NAME_PATTERN.test(value)) throw invalidRequest(`Ogiltigt ${what}.`);
}

/** En parameter som anges flera gånger nekas — vi väljer aldrig tyst den första eller sista. */
function singleParam(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw invalidRequest(`Parametern "${name}" får bara anges en gång.`);
  return values[0];
}

function parseScope(params: URLSearchParams): CollectionScope {
  const value = singleParam(params, 'scope');
  if (value === undefined) return 'app';
  if (value === 'app' || value === 'user') return value;
  throw invalidRequest('Parametern "scope" måste vara "app" eller "user".');
}

function parseListOptions(params: URLSearchParams): { limit?: number; cursor?: string } {
  const options: { limit?: number; cursor?: string } = {};
  const limit = singleParam(params, 'limit');
  if (limit !== undefined) {
    // Bara ett positivt heltal i decimalform. Övre gräns sätter data-API:t (`maxPageSize`).
    if (!/^[1-9][0-9]{0,5}$/.test(limit)) throw invalidRequest('Parametern "limit" måste vara ett positivt heltal.');
    options.limit = Number(limit);
  }
  const cursor = singleParam(params, 'cursor');
  if (cursor !== undefined) {
    // Markören är ogenomskinlig för gatewayn och skickas vidare som sträng; data-API:t validerar den.
    if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) throw invalidRequest('Ogiltig parameter "cursor".');
    options.cursor = cursor;
  }
  return options;
}

async function readDocumentData(request: IncomingMessage) {
  assertJsonContentType(request);
  return parseDocumentBody(await readBody(request, MAX_REQUEST_BODY_BYTES));
}

function whoAmI(identity: Identity): WhoAmIResponse {
  // Bara den lokala delen av adressen, aldrig domänen: appen behöver ett namn att visa, inte en
  // kontaktuppgift. Saknas `@` på en rimlig plats visas ett neutralt namn hellre än hela värdet.
  const at = identity.email.lastIndexOf('@');
  return { userId: identity.userId, displayName: at > 0 ? identity.email.slice(0, at) : 'Användare' };
}

export async function handleApi(api: ApiRequest): Promise<void> {
  const { method, segments, response, tenant, identity, store } = api;

  if (segments.length === 1 && segments[0] === 'whoami') {
    if (method !== 'GET') throw methodNotAllowed(['GET']);
    sendJson(response, 200, whoAmI(identity));
    return;
  }

  const isCollectionRoute = segments[0] === 'collections' && segments[2] === 'docs';
  const collection = segments[1];

  if (isCollectionRoute && collection !== undefined && segments.length === 3) {
    assertName(collection, 'kollektionsnamn');
    const params = new URLSearchParams(api.query);
    if (method === 'GET') {
      const page = await store.listDocuments(tenant, identity, collection, parseScope(params), parseListOptions(params));
      sendJson(response, 200, page);
      return;
    }
    if (method === 'POST') {
      const scope = parseScope(params);
      const data = await readDocumentData(api.request);
      sendJson(response, 201, await store.createDocument(tenant, identity, collection, scope, data));
      return;
    }
    throw methodNotAllowed(['GET', 'POST']);
  }

  const id = segments[3];
  if (isCollectionRoute && collection !== undefined && id !== undefined && segments.length === 4) {
    assertName(collection, 'kollektionsnamn');
    assertName(id, 'dokument-id');
    if (method === 'GET') {
      sendJson(response, 200, await store.getDocument(tenant, identity, collection, id));
      return;
    }
    if (method === 'PUT') {
      const data = await readDocumentData(api.request);
      sendJson(response, 200, await store.replaceDocument(tenant, identity, collection, id, data));
      return;
    }
    if (method === 'DELETE') {
      await store.deleteDocument(tenant, identity, collection, id);
      sendNoContent(response);
      return;
    }
    throw methodNotAllowed(['GET', 'PUT', 'DELETE']);
  }

  throw notFound();
}
