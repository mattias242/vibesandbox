/**
 * Före och efter varje scenario: starta en riktig plattform, och städa ALLTID efteråt — även när
 * scenariot fallerar, och även när själva starten gick snett halvvägs.
 */
import { After, Before, setDefaultTimeout } from '@cucumber/cucumber';
import { LITEN_KVOT } from './stod/varld.ts';
import type { Varld } from './stod/varld.ts';

// Standard är 5 s. Scenariot med 250 dokument gör 250 riktiga HTTP-anrop mot en riktig databas.
setDefaultTimeout(30_000);

Before(async function (this: Varld, { pickle }) {
  // Kvoten är plattformens konfiguration och måste vara satt INNAN servern startar. Scenarierna
  // om en full app känns igen på sitt Givet-steg; alla andra kör med de riktiga standardgränserna.
  if (pickle.steps.some((steg) => steg.text.includes('har nått sin lagringsgräns'))) this.kvot = LITEN_KVOT;
  try {
    await this.starta();
  } catch (fel) {
    await this.stada();
    throw fel;
  }
});

After(async function (this: Varld, { result }) {
  if (result?.status === 'FAILED') {
    // Status och kropp räcker för felsökning. Förfrågans huvuden — med inloggningen — bifogas aldrig.
    const sammanfattning = this.svar.map((svar) => `${svar.status} ${svar.kropp.slice(0, 300)}`).join('\n');
    this.attach(`Senaste svar:\n${sammanfattning}`, 'text/plain');
  }
  await this.stada();
});
