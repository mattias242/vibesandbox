/**
 * Tjänsten `ocr` för appar (`/_api/ocr`): läser texten i en fil som laddats upp med `files`.
 * Anropar tjänsten bara genom `callService` i ./anrop.ts. Dokumentationen för byggagenten står
 * i packages/sdk/tjanster/ocr.md och visas bara när tjänsten är påslagen.
 */
import { SdkError } from '../errors.ts';
import { callService } from './anrop.ts';
import type { ServiceFetch } from './anrop.ts';

export type OcrLanguage = 'sv' | 'en';

export interface OcrPage {
  readonly number: number;
  readonly text: string;
}

export interface OcrResult {
  /** Hela texten. */
  readonly text: string;
  /** Texten per sida. En bild är en sida; en PDF kan sakna uppdelning (tom lista). */
  readonly pages: readonly OcrPage[];
}

export interface OcrReadOptions {
  /** Språket i dokumentet. Standard: svenska. */
  readonly language?: OcrLanguage;
  /** Bara för tester. */
  readonly fetch?: ServiceFetch;
}

/** Samma regel som tjänsten: fil-id från `files`, aldrig något som kan bli en sökväg. */
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPage(value: unknown): value is OcrPage {
  return isRecord(value) && Number.isSafeInteger(value['number']) && typeof value['text'] === 'string';
}

/** Läser texten i filen `fileId` (ett id från `files.upload`). */
export async function read(fileId: string, options: OcrReadOptions = {}): Promise<OcrResult> {
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) throw new SdkError('invalid_request');
  const { language } = options;
  if (language !== undefined && language !== 'sv' && language !== 'en') throw new SdkError('invalid_request');

  const body = await callService('ocr', 'POST', '', {
    json: language === undefined ? { fileId } : { fileId, language },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (!isRecord(body) || typeof body['text'] !== 'string') throw new SdkError('internal');
  const pages = body['pages'];
  if (pages !== undefined && !(Array.isArray(pages) && pages.every(isPage))) throw new SdkError('internal');
  return { text: body['text'], pages: (pages as OcrPage[] | undefined)?.map((p) => ({ number: p.number, text: p.text })) ?? [] };
}
