/**
 * Svar från byggverktygets API: alltid JSON, alltid `Cache-Control: no-store` (svaren innehåller
 * samtal och personliga adresser som inte ska ligga kvar i någon cache).
 *
 * Felkropparna har samma form som kontraktets `ApiErrorBody`. En kod saknas där: `conflict` (409),
 * för "det går inte just nu" — ett jobb pågår, inget utkast finns, appen är inte publicerad.
 */
import type { ApiErrorCode, PlatformResponse } from '@vibesandbox/contracts';

export type BuilderErrorCode = ApiErrorCode | 'conflict';

const STATUS: Readonly<Record<BuilderErrorCode, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  invalid_request: 400,
  scope_mismatch: 409,
  conflict: 409,
  quota_exceeded: 507,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

export function json(status: number, body: unknown): PlatformResponse {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

/** Ett fel med ett meddelande som är tryggt att visa för användaren. */
export class ApiProblem extends Error {
  readonly code: BuilderErrorCode;

  constructor(code: BuilderErrorCode, message: string) {
    super(message);
    this.name = 'ApiProblem';
    this.code = code;
  }
}

export function problemResponse(problem: ApiProblem): PlatformResponse {
  return json(STATUS[problem.code], { error: { code: problem.code, message: problem.message } });
}

export const notFound = (): ApiProblem => new ApiProblem('not_found', 'Det du letar efter finns inte.');
export const invalid = (message: string): ApiProblem => new ApiProblem('invalid_request', message);
export const conflict = (message: string): ApiProblem => new ApiProblem('conflict', message);
export const internal = (): ApiProblem =>
  new ApiProblem('internal', 'Något gick fel hos plattformen. Försök igen om en stund.');
