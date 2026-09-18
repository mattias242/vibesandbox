/**
 * Tolk för Server-Sent Events (text/event-stream), bara det som behövs för strömmande
 * chattsvar: `data:`-fält, flera `data:`-rader i en händelse, kommentarer (`:`), CRLF/CR/LF
 * och bitar som delas var som helst — även mitt i ett CRLF-par.
 *
 * Tar emot redan avkodad text; avkodningen av bytes (med `TextDecoder` i strömläge) sköts av
 * anroparen så att multibytetecken som delas mellan nätverksbitar blir rätt.
 */

export interface SseParser {
  /** Matar in nästa textbit och ger datat för varje händelse som blev klar. */
  push(chunk: string): string[];
  /** Strömmen är slut: ger en eventuell sista händelse som saknade avslutande tomrad. */
  end(): string[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let data: string[] = [];
  let hasData = false;

  function dispatch(out: string[]): void {
    if (hasData) out.push(data.join('\n'));
    data = [];
    hasData = false;
  }

  function line(text: string, out: string[]): void {
    if (text === '') {
      dispatch(out);
      return;
    }
    if (text.startsWith(':')) return; // kommentar, t.ex. keep-alive
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    if (field !== 'data') return; // event, id, retry — används inte här
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
    hasData = true;
  }

  function drain(out: string[], final: boolean): void {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (match === null) break;
      // Ett ensamt CR sist i bufferten kan vara första halvan av ett CRLF som delats.
      if (match[0] === '\r' && match.index === buffer.length - 1 && !final) break;
      line(buffer.slice(0, match.index), out);
      buffer = buffer.slice(match.index + match[0].length);
    }
  }

  return {
    push(chunk) {
      const out: string[] = [];
      buffer += chunk;
      drain(out, false);
      return out;
    },
    end() {
      const out: string[] = [];
      drain(out, true);
      if (buffer !== '') line(buffer, out);
      buffer = '';
      dispatch(out);
      return out;
    },
  };
}
