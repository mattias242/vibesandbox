/**
 * Ett giltigt app-id som INTE finns i registret — för scenariot om en adress utan app.
 * Samma form som plattformens egna (26 tecken Crockford-base32), slumpat så att det inte kan
 * råka sammanfalla med en app som scenariot har skapat.
 */
import { randomBytes } from 'node:crypto';
import { isAppId } from '@vibesandbox/contracts';
import type { AppId } from '@vibesandbox/contracts';

const ALFABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newAppId(): AppId {
  let id = '';
  for (const byte of randomBytes(26)) id += ALFABET.charAt(byte & 31);
  if (!isAppId(id)) throw new Error('Det genererade app-id:t matchar inte kontraktets mönster.');
  return id;
}
