/**
 * Påståendena i "Trygghet och kontroll" måste vara sanna. Testet låser vad som sägs och
 * fäller på sådant plattformen INTE gör (mänsklig granskning, klassning, att namn tas bort).
 */
import { describe, expect, it } from 'vitest';
import { SAFETY_POINTS, SUGGESTIONS } from '../src/texts.ts';

const all = SAFETY_POINTS.join('\n');

describe('Trygghet och kontroll', () => {
  it('säger det som gäller', () => {
    expect(all).toMatch(/plattformens egen server/);
    expect(all).toMatch(/kan inte skicka uppgifter vidare till andra adresser på internet/);
    expect(all).toMatch(/AI-modell hos en svensk leverantör/);
    expect(all).toMatch(/[Pp]ersonnummer, telefonnummer, e-postadresser, kortnummer och IBAN/);
    expect(all).toMatch(/[Nn]amn tas inte bort/);
    expect(all).toMatch(/skriv inte in personuppgifter/i);
    expect(all).toMatch(/kontrolleras automatiskt innan den byggs/);
    expect(all).toMatch(/egen lagring som andra appar inte kommer åt/);
    expect(all).toMatch(/[Bb]ara du ser din app tills du publicerar den/);
    expect(all).toMatch(/de du delar den med, efter att de loggat in/);
  });

  // Appen är bara din, men återkopplingen på byggverktyget är det inte: säger du att
  // byggverktyget inte hjälpte mejlas hela konversationen vidare. Står det inte här blir
  // punkten ovan om att "bara du ser din app" missvisande.
  it('säger vad som händer när man lämnar återkoppling på byggverktyget', () => {
    expect(all).toMatch(/[Bb]yggverktyget inte hjälpte/);
    expect(all).toMatch(/hela er konversation om appen/);
    expect(all).toMatch(/till den som driver plattformen/);
    expect(all).toMatch(/[Tt]ummen upp räknas bara/);
  });

  it('påstår inte mer än så', () => {
    expect(all).not.toMatch(/människa|manuell|granskas av|granskar/i);
    expect(all).not.toMatch(/klassa|klassning|klassific/i);
    expect(all).not.toMatch(/namn tas bort|anonymiser/i);
    expect(all).not.toMatch(/helt säker|100 ?%|garanter/i);
  });
});

describe('förslagen', () => {
  it('finns och innehåller todo-listan', () => {
    expect(SUGGESTIONS).toContain('En todo-lista för vårt team');
    expect(SUGGESTIONS.length).toBeGreaterThanOrEqual(3);
  });
});
