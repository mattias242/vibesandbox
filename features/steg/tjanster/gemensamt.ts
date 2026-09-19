/**
 * Steg som flera tjänsters scenarier använder. Ett steg får bara definieras på ETT ställe —
 * cucumber vägrar köra ett scenario där två definitioner matchar samma text.
 */
import { Given } from '@cucumber/cucumber';
import type { Varld } from '../stod/varld.ts';

Given(/^att appen "([^"]+)" har ett utkast$/, async function (this: Varld, app: string) {
  await this.sattUtkast(app);
});
