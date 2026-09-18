/**
 * De enda tre sätten gatewayn skriver ett svar på. Säkerhetshuvudena är redan satta av
 * hanteraren innan någon av dessa anropas (se huvuden.ts).
 *
 * För `HEAD` utelämnar Node kroppen själv; `Content-Length` beskriver då vad `GET` hade gett.
 */
import type { ServerResponse } from 'node:http';
import type { AppFile } from '@vibesandbox/contracts';
import type { Failure } from './fel.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.statusCode = status;
  response.setHeader('Content-Type', JSON_CONTENT_TYPE);
  response.setHeader('Content-Length', payload.length);
  response.end(payload);
}

export function sendNoContent(response: ServerResponse): void {
  response.statusCode = 204;
  response.end();
}

/** `Content-Type` tas från plattformens filregister — gatewayn gissar aldrig en egen. */
export function sendFile(response: ServerResponse, file: AppFile): void {
  const payload = Buffer.from(file.body.buffer, file.body.byteOffset, file.body.byteLength);
  response.statusCode = 200;
  response.setHeader('Content-Type', file.contentType);
  response.setHeader('Content-Length', payload.length);
  response.end(payload);
}

export function sendFailure(response: ServerResponse, failure: Failure): void {
  for (const [name, value] of Object.entries(failure.headers)) response.setHeader(name, value);
  if (failure.closeConnection) response.setHeader('Connection', 'close');
  sendJson(response, failure.status, failure.body);
}
