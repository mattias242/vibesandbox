/**
 * XML-läsaren. Den läser ALDRIG något utanför dokumentet: en dokumenttypsdeklaration (som är
 * enda vägen till en extern entitet, XXE) gör att filen vägras i stället för att tolkas.
 */
import { describe, expect, it } from 'vitest';
import { XmlError, decodeEntities, parseXml } from '../src/xml.ts';

function texter(källa: string): string[] {
  const ut: string[] = [];
  parseXml(källa, (händelse) => {
    if (händelse.kind === 'text') ut.push(händelse.text);
  });
  return ut;
}

describe('parseXml', () => {
  it('ger element, attribut och text i ordning', () => {
    const händelser: string[] = [];
    parseXml('<a x="1"><b>hej</b><c/></a>', (h) => {
      if (h.kind === 'open') händelser.push(`öppna ${h.tag.name} ${JSON.stringify(h.tag.attributes)} ${h.tag.selfClosing}`);
      if (h.kind === 'close') händelser.push(`stäng ${h.name}`);
      if (h.kind === 'text') händelser.push(`text ${h.text}`);
    });
    expect(händelser).toEqual(['öppna a {"x":"1"} false', 'öppna b {} false', 'text hej', 'stäng b', 'öppna c {} true', 'stäng c', 'stäng a']);
  });

  it('hoppar över deklaration och kommentar, och läser CDATA som text', () => {
    expect(texter('<?xml version="1.0"?><a><!-- göm -->ett<![CDATA[<två>]]></a>')).toEqual(['ett', '<två>']);
  });

  it('avkodar entiteter i text och attribut', () => {
    expect(texter('<a>ett &amp; två &lt;tre&gt; &#65; &#x44; &quot;fyra&quot; &apos;fem&apos;</a>')).toEqual([
      'ett & två <tre> A D "fyra" \'fem\'',
    ]);
    const attribut: Record<string, string>[] = [];
    parseXml('<c r="A&amp;1" t="s"/>', (h) => {
      if (h.kind === 'open') attribut.push({ ...h.tag.attributes });
    });
    expect(attribut).toEqual([{ r: 'A&1', t: 's' }]);
  });

  it('vägrar en dokumenttyp — det är där externa entiteter skulle komma in', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE fel [<!ENTITY hemlis SYSTEM "file:///etc/passwd">]><a>&hemlis;</a>';
    expect(() => parseXml(xxe, () => {})).toThrow(XmlError);
  });

  it('en okänd entitet slås aldrig upp, den blir bara text', () => {
    expect(texter('<a>&hemlis; &okänd;</a>')).toEqual(['&hemlis; &okänd;']);
  });

  it('vägrar trasig XML i stället för att gissa', () => {
    for (const trasig of ['<a><b>', '<a href="öppen>text</a>', '<!-- aldrig stängd', '<![CDATA[aldrig stängd', '<a></b></a>']) {
      expect(() => parseXml(trasig, () => {}), trasig).toThrow(XmlError);
    }
  });

  it('läsaren kan avbrytas inifrån', () => {
    let antal = 0;
    expect(() =>
      parseXml('<a><b>1</b><b>2</b><b>3</b></a>', () => {
        antal += 1;
        if (antal === 3) throw new Error('nog nu');
      }),
    ).toThrow('nog nu');
  });
});

describe('decodeEntities', () => {
  it('lämnar text utan entiteter orörd', () => {
    expect(decodeEntities('Ärende 2026-114 & inget mer')).toBe('Ärende 2026-114 & inget mer');
  });

  it('avkodar inte ogiltiga teckennummer', () => {
    expect(decodeEntities('&#xD800; &#1114112; &#x0;')).toBe('&#xD800; &#1114112; &#x0;');
  });
});
