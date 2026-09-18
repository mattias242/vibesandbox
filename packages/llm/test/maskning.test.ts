import { describe, expect, it } from 'vitest';
import { maskPersonalData } from '@vibesandbox/llm';

// Alla nummer nedan är påhittade. Kontrollsiffrorna är uträknade för att klara Luhn/mod-97,
// och kortnumret är ett välkänt testkortnummer som inte hör till något riktigt konto.

describe('maskPersonalData: personnummer och samordningsnummer', () => {
  it.each([
    ['10 siffror med bindestreck', 'Eleven har 900101-1239 i registret.'],
    ['10 siffror utan skiljetecken', 'Eleven har 9001011239 i registret.'],
    ['12 siffror', 'Eleven har 199001011239 i registret.'],
    ['12 siffror med bindestreck', 'Eleven har 19900101-1239 i registret.'],
    ['plustecken för den som fyllt 100', 'Eleven har 121212+1212 i registret.'],
  ])('maskar %s', (_namn, text) => {
    const resultat = maskPersonalData(text);
    expect(resultat.text).toBe('Eleven har [PERSONNUMMER] i registret.');
    expect(resultat.found).toEqual(['personnummer']);
  });

  it('maskar samordningsnummer (dag + 60)', () => {
    expect(maskPersonalData('Samordningsnummer 701063-2383.').text).toBe('Samordningsnummer [PERSONNUMMER].');
    expect(maskPersonalData('Samordningsnummer 197010632383.').text).toBe('Samordningsnummer [PERSONNUMMER].');
  });

  it('maskar flera nummer i samma text', () => {
    const resultat = maskPersonalData('Anna 811218-9876 och Bertil 850709-9870');
    expect(resultat.text).toBe('Anna [PERSONNUMMER] och Bertil [PERSONNUMMER]');
    expect(resultat.found).toEqual(['personnummer', 'personnummer']);
  });

  it('maskar INTE tio siffror i följd med fel kontrollsiffra', () => {
    // Utan skiljetecken är tio siffror ofta något annat (ett ärendenummer); Luhn avgör.
    expect(maskPersonalData('Ärende 9001011234').text).toBe('Ärende 9001011234');
  });

  it('maskar ÄNDÅ formen ÅÅMMDD-NNNN med fel kontrollsiffra när datumet är giltigt', () => {
    // Bindestrecket gör formen entydig: det är ett personnummer, bara felskrivet eller påhittat
    // (som i scenariot "Personnummer lämnar aldrig servern"). Det är rätt håll att fela åt.
    expect(maskPersonalData('En lista över elever, till exempel 900101-1234').text).toBe(
      'En lista över elever, till exempel [PERSONNUMMER]',
    );
  });

  it('maskar inte ett omöjligt datum', () => {
    expect(maskPersonalData('Kod 901301-1234').text).toBe('Kod 901301-1234');
    expect(maskPersonalData('Kod 900100-1234').text).toBe('Kod 900100-1234');
  });

  it('maskar inte siffror som är del av en längre sifferföljd', () => {
    expect(maskPersonalData('Serienummer 99001011239999').found).not.toContain('personnummer');
  });

  it('lämnar vanliga datum och belopp i fred', () => {
    const text = 'Mötet är 2026-10-01 kl 09:30 och kostar 1 250 kr. Rum 412.';
    expect(maskPersonalData(text)).toEqual({ text, found: [] });
  });
});

describe('maskPersonalData: telefonnummer', () => {
  it.each([
    'Ring 070-123 45 67 i morgon.',
    'Ring 0701234567 i morgon.',
    'Ring +46 70 123 45 67 i morgon.',
    'Ring +46701234567 i morgon.',
    'Ring 0046 70 123 45 67 i morgon.',
    'Ring 08-123 456 78 i morgon.',
    'Ring 031-12 34 56 i morgon.',
    'Ring +46 (0)8 123 456 78 i morgon.',
  ])('maskar %s', (text) => {
    const resultat = maskPersonalData(text);
    expect(resultat.text).toBe('Ring [TELEFON] i morgon.');
    expect(resultat.found).toHaveLength(1);
  });

  it('maskar inte ett postnummer eller ett årtal', () => {
    const text = 'Adress 431 30 Västerås, byggt 1998.';
    expect(maskPersonalData(text).text).toBe(text);
  });
});

describe('maskPersonalData: e-post', () => {
  it('maskar vanliga adresser, även med plus och underdomän', () => {
    expect(maskPersonalData('Skriv till anna.svensson+bokning@post.exempel.se nu').text).toBe(
      'Skriv till [E-POST] nu',
    );
  });

  it('maskar adresser med å, ä och ö', () => {
    expect(maskPersonalData('Mejla åsa.öberg@exempel.se').text).toBe('Mejla [E-POST]');
  });
});

describe('maskPersonalData: kortnummer', () => {
  it.each(['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '5555 5555 5555 4444'])(
    'maskar %s',
    (kort) => {
      expect(maskPersonalData(`Kort: ${kort}.`).text).toBe('Kort: [KORTNUMMER].');
    },
  );

  it('maskar inte ett kortliknande nummer med fel kontrollsiffra', () => {
    expect(maskPersonalData('Kort: 4111 1111 1111 1112.').found).not.toContain('kortnummer');
  });

  it('maskar ett ordernummer som råkar klara Luhn — med avsikt', () => {
    // Vi kan inte skilja ett kortnummer från ett ordernummer med samma form. Att maska ett
    // ordernummer i onödan kostar lite (modellen ser en platshållare); att släppa igenom ett
    // kortnummer går inte att ta tillbaka. Därför felar vi åt det hållet.
    expect(maskPersonalData('Order 1000000000009').text).toBe('Order [KORTNUMMER]');
  });
});

describe('maskPersonalData: IBAN', () => {
  it('maskar ett svenskt IBAN med och utan mellanslag', () => {
    expect(maskPersonalData('Betala till SE45 5000 0000 0583 9825 7466 senast fredag').text).toBe(
      'Betala till [IBAN] senast fredag',
    );
    expect(maskPersonalData('IBAN SE4550000000058398257466.').text).toBe('IBAN [IBAN].');
  });

  it('maskar ett utländskt IBAN', () => {
    expect(maskPersonalData('DE89 3704 0044 0532 0130 00').text).toBe('[IBAN]');
  });

  it('maskar inte ett IBAN med fel kontrollsiffror', () => {
    expect(maskPersonalData('SE46 5000 0000 0583 9825 7466').found).not.toContain('iban');
  });
});

describe('maskPersonalData: det som INTE maskas', () => {
  it('namn och adresser maskas inte (se README)', () => {
    const text = 'Anna Svensson bor på Storgatan 1.';
    expect(maskPersonalData(text)).toEqual({ text, found: [] });
  });

  it('found innehåller bara typer, aldrig själva värdena', () => {
    const resultat = maskPersonalData('900101-1239 anna@exempel.se');
    expect(JSON.stringify(resultat.found)).not.toMatch(/900101|anna/);
  });

  it('klarar stora texter utan katastrofal backtracking', () => {
    const text = '1 '.repeat(50_000) + 'a'.repeat(50_000) + '@'.repeat(1000);
    const start = performance.now();
    maskPersonalData(text);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
