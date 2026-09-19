/**
 * Givet-steg: appar, inloggade personer och data som ska finnas innan något händer.
 * Ett fel här är ett fel i testet eller plattformen — aldrig något scenariot förväntar sig.
 */
import assert from 'node:assert/strict';
import { Given } from '@cucumber/cucumber';
import { jsonKropp } from './stod/http.ts';
import { SIDA_MED_EGNA_REGLER } from './stod/fixtur.ts';
import { somJsonObjekt } from './stod/json.ts';
import { LITEN_KVOT, LITET_DOKUMENT, dokumentlista } from './stod/varld.ts';
import type { Varld } from './stod/varld.ts';

Given(/^att appen "([^"]+)" är publicerad$/, async function (this: Varld, app: string) {
  await this.publicera(app);
});

// En inloggad person i isoleringsscenarierna har fått de publicerade apparna delade med sig
// (Anna som ägare) — se `Varld.publicera`.
Given(/^att (Anna|Bertil) är inloggad$/, async function (this: Varld, namn: string) {
  this.loggaIn(namn);
  await this.gePubliceradeAppar(namn);
});

Given(/^att (Anna|Bertil) är inloggad med adressen "([^"]+)"$/, async function (this: Varld, namn: string, epost: string) {
  this.loggaIn(namn, epost);
  await this.gePubliceradeAppar(namn);
});

Given(
  /^att (Anna|Bertil) har sparat dokumentet (\{.*\}) i (den personliga kollektionen|kollektionen) "([^"]+)" i appen "([^"]+)"$/,
  async function (this: Varld, namn: string, data: string, sort: string, kollektion: string, app: string) {
    await this.sparaDokument(namn, app, kollektion, sort === 'den personliga kollektionen', somJsonObjekt(data));
  },
);

Given(/^att appen "([^"]+)" innehåller (\d+) dokument i kollektionen "([^"]+)"$/, async function (this: Varld, app: string, antal: string, kollektion: string) {
  const person = this.senastInloggad;
  assert.ok(person !== undefined, 'Steget förutsätter att någon är inloggad.');
  // Tio åt gången: snabbare än ett i taget, utan att dränka servern i samtidiga anslutningar.
  const kvar = Array.from({ length: Number(antal) }, (_, nummer) => nummer + 1);
  while (kvar.length > 0) {
    await Promise.all(kvar.splice(0, 10).map((nummer) => this.sparaDokument(person, app, kollektion, false, { nummer })));
  }
});

Given(/^att appen "([^"]+)" har nått sin lagringsgräns$/, async function (this: Varld, app: string) {
  // Skydd mot att steget används i ett scenario som kroken i krokar.ts inte känner igen — då
  // skulle det försöka fylla den riktiga kvoten på 50 MB.
  assert.deepEqual(this.kvot, LITEN_KVOT, 'Scenariot körs inte med den lilla kvoten.');
  const person = this.senastInloggad;
  assert.ok(person !== undefined, 'Steget förutsätter att någon är inloggad.');

  // "Full" ska betyda full även för det MINSTA dokumentet — annars säger nästa steg ingenting.
  // Först stora dokument så att det går fort, sedan allt mindre tills inte ens det dokument som
  // När-steget sparar får plats.
  const fyllningar: readonly unknown[] = [
    { data: { fyllnad: 'x'.repeat(4000) } },
    { data: { fyllnad: 'x'.repeat(1000) } },
    { data: { fyllnad: 'x'.repeat(250) } },
    LITET_DOKUMENT,
  ];
  let anrop = 0;
  for (const json of fyllningar) {
    for (;;) {
      anrop += 1;
      assert.ok(anrop <= 500, 'Appen blev aldrig full.');
      const svar = await this.anropaApp({ app, person, metod: 'POST', sokvag: dokumentlista('poster'), json });
      if (svar.status === 507) break;
      assert.equal(svar.status, 201, `Oväntat svar medan appen fylldes: ${svar.status} ${svar.kropp.slice(0, 200)}`);
      const id = (jsonKropp(svar) as { id: string }).id;
      this.dokumentIApp.set(app, [...(this.dokumentIApp.get(app) ?? []), id]);
    }
  }
  assert.ok((this.dokumentIApp.get(app) ?? []).length > 0, 'Appen blev full innan ett enda dokument fick plats.');
});

Given(/^att appens filer innehåller en sida som försöker sätta egna skyddsregler via en meta-tagg$/, async function (this: Varld) {
  await this.publicera(this.endaAppen(), { medSidaSomSatterEgnaRegler: true });
  this.sida = SIDA_MED_EGNA_REGLER;
});
