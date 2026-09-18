import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/sse.ts';

function all(chunks: string[]): string[] {
  const parser = createSseParser();
  const out: string[] = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  out.push(...parser.end());
  return out;
}

describe('SSE-tolken', () => {
  it('ger datat i varje händelse', () => {
    expect(all(['data: a\n\ndata: b\n\n'])).toEqual(['a', 'b']);
  });

  it('klarar rader som delas mitt i en bit', () => {
    expect(all(['da', 'ta: {"x"', ':1}\n', '\nda', 'ta: 2\n\n'])).toEqual(['{"x":1}', '2']);
  });

  it('klarar CRLF och ensamma CR', () => {
    expect(all(['data: a\r\n\r\ndata: b\r\r'])).toEqual(['a', 'b']);
  });

  it('klarar CRLF som delas mellan två bitar', () => {
    expect(all(['data: a\r', '\n\r', '\ndata: b\n\n'])).toEqual(['a', 'b']);
  });

  it('slår ihop flerradiga händelser med radbrytning', () => {
    expect(all(['data: rad1\ndata: rad2\n\n'])).toEqual(['rad1\nrad2']);
  });

  it('hoppar över kommentarsrader och andra fält', () => {
    expect(all([': keep-alive\n\nevent: x\nid: 3\ndata: a\n\n'])).toEqual(['a']);
  });

  it('tar bara bort ETT inledande blanksteg efter kolon', () => {
    expect(all(['data:a\n\ndata:  b\n\n'])).toEqual(['a', ' b']);
  });

  it('ger en sista händelse utan avslutande tomrad', () => {
    expect(all(['data: sist'])).toEqual(['sist']);
  });

  it('ger inga tomma händelser', () => {
    expect(all(['\n\n\n: x\n\n'])).toEqual([]);
  });
});
