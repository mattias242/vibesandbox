/**
 * Tjänsten `extract` för appar (`/_api/extract`): texten ur en fil som laddats upp med `files`.
 * Anropar tjänsten bara genom `callService` i ./anrop.ts. Dokumentationen för byggagenten står
 * i packages/sdk/tjanster/extract.md och visas bara när tjänsten är påslagen.
 */
import { SdkError } from '../errors.ts';
import { callService } from './anrop.ts';
import type { ServiceFetch } from './anrop.ts';

/** Vilken sorts fil texten kom ur. Avgörs av filens innehåll, aldrig av namnet. */
export type ExtractKind = 'docx' | 'xlsx' | 'pptx' | 'pdf';

export interface ExtractResult {
  /** Texten ur filen. Tom när det inte fanns någon text att hämta. */
  readonly text: string;
  readonly kind: ExtractKind;
  /** Sant när filen innehöll mer text än som ryms i ett svar. */
  readonly truncated: boolean;
  /** Antal sidor (PDF) eller bilder (PowerPoint). `0` när filen inte är uppdelad så. */
  readonly pages: number;
  /** Falskt när filen inte innehöll någon text att hämta — t.ex. en inskannad PDF. */
  readonly hasText: boolean;
  /** En mening i klarspråk att visa när `hasText` är falskt. */
  readonly message?: string;
}

export interface ExtractReadOptions {
  /** Bara för tester. */
  readonly fetch?: ServiceFetch;
}

/** Samma regel som tjänsten: fil-id från `files`, aldrig något som kan bli en sökväg. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const KINDS: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx', 'pdf']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Hämtar texten ur filen `fileId` (ett id från `files.upload`). */
export async function read(fileId: string, options: ExtractReadOptions = {}): Promise<ExtractResult> {
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) throw new SdkError('invalid_request');

  const body = await callService('extract', 'POST', '', {
    json: { fileId },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (!isRecord(body) || typeof body['text'] !== 'string') throw new SdkError('internal');
  const kind = body['kind'];
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw new SdkError('internal');
  const truncated = body['truncated'];
  if (truncated !== undefined && typeof truncated !== 'boolean') throw new SdkError('internal');
  const pages = body['pages'];
  if (pages !== undefined && !Number.isSafeInteger(pages)) throw new SdkError('internal');
  const hasText = body['hasText'];
  if (hasText !== undefined && typeof hasText !== 'boolean') throw new SdkError('internal');
  const message = body['message'];
  if (message !== undefined && typeof message !== 'string') throw new SdkError('internal');

  return {
    text: body['text'],
    kind: kind as ExtractKind,
    truncated: truncated === true,
    pages: (pages as number | undefined) ?? 0,
    hasText: hasText ?? body['text'] !== '',
    ...(message === undefined ? {} : { message }),
  };
}
