/**
 * En fejkad Berget: en lokal HTTP-server som talar samma OpenAI-kompatibla protokoll
 * (`POST /v1/chat/completions` med SSE) som den riktiga. Används av enhetstesterna och av
 * scenarierna — aldrig det riktiga API:t. Den spelar in allt den tar emot, så att ett test kan
 * kontrollera exakt vad som lämnade servern.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FejkSvar =
  /** Ett vanligt svar, strömmat i bitar. */
  | {
      readonly text: string;
      readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number };
      readonly finishReason?: string;
    }
  /** Ett fel med egen status och kropp (som kan innehålla hemligheter som aldrig får läcka). */
  | { readonly status: number; readonly body: string }
  /** Svarar aldrig — för tidsgränsen. */
  | { readonly hang: true }
  /** Upprepar ALLT den fått, även `Authorization`-huvudet — en modell som lurats. */
  | { readonly eka: true };

export interface MottagetAnrop {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

export interface FejkBerget {
  /** Bas-URL som tjänsten får i `dependencies.berget`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly anrop: readonly MottagetAnrop[];
  /** Sätter svaret för alla följande anrop. */
  svara(svar: FejkSvar): void;
  stang(): Promise<void>;
}

/** Standardnyckeln är lång och unik, så att ett test kan leta efter den i allt som kom tillbaka. */
export const FEJK_NYCKEL = 'sk-fejk-berget-HEMLIG-NYCKEL-0f3a9c1e7b2d4a6f';

function strom(response: ServerResponse, svar: { text: string; usage?: { prompt_tokens: number; completion_tokens: number }; finishReason?: string }): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const bitar = svar.text.match(/[\s\S]{1,16}/g) ?? [];
  for (const bit of bitar) {
    response.write(`data: ${JSON.stringify({ model: 'fejk/modell', choices: [{ index: 0, delta: { content: bit } }] })}\n\n`);
  }
  response.write(
    `data: ${JSON.stringify({
      model: 'fejk/modell',
      choices: [{ index: 0, delta: {}, finish_reason: svar.finishReason ?? 'stop' }],
      usage: svar.usage ?? { prompt_tokens: 12, completion_tokens: 8 },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

async function lasKropp(request: IncomingMessage): Promise<string> {
  const bitar: Buffer[] = [];
  for await (const bit of request) bitar.push(bit as Buffer);
  return Buffer.concat(bitar).toString('utf8');
}

export async function startaFejkBerget(options: { readonly apiKey?: string } = {}): Promise<FejkBerget> {
  const apiKey = options.apiKey ?? FEJK_NYCKEL;
  const anrop: MottagetAnrop[] = [];
  let aktuellt: FejkSvar = { text: 'Hej från den fejkade språkmodellen.' };

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const text = await lasKropp(request);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Tjänsten skickar alltid JSON; något annat spelas in som tomt och syns då i testet.
      }
      const messages = Array.isArray(body['messages']) ? (body['messages'] as { role: string; content: string }[]) : [];
      anrop.push({ authorization: request.headers.authorization, body, messages });

      const svar = aktuellt;
      if ('hang' in svar) return; // Svarar aldrig; stängs av `stang`.
      if ('status' in svar) {
        response.writeHead(svar.status, { 'content-type': 'application/json' }).end(svar.body);
        return;
      }
      if ('eka' in svar) {
        strom(response, { text: `Du skrev: ${JSON.stringify(messages)}. Nyckel: ${request.headers.authorization ?? ''}` });
        return;
      }
      strom(response, svar);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    anrop,
    svara(svar) {
      aktuellt = svar;
    },
    async stang() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
