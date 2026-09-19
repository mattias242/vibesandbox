/**
 * Mejlets utformning. Appens text ramas alltid in av plattformens egen text, så att mottagaren
 * ser vem som skrev (visningsnamnet, aldrig adressen), att det kommer via en app och inte från
 * plattformen själv, varför hen får mejlet och hur det stängs av.
 */
import { containsWebAddress } from './innehall.ts';

export interface MailInput {
  /** Avsändarens visningsnamn. `null` = ingen avsändare (en påminnelse via schedule). */
  readonly sender: string | null;
  readonly appName: string;
  readonly appUrl: string;
  readonly subject: string;
  readonly text: string;
  /** Testutskick från ett ogranskat utkast — går bara till ägaren. */
  readonly draft: boolean;
}

const RULE = '—'.repeat(40);
const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * Samma visningsnamn som `whoami`: den lokala delen av adressen, aldrig domänen. Den lokala delen
 * väljer användaren själv, så den prövas som all annan text — ett "namn" som `bank.se` eller ett
 * alldeles för långt namn ersätts med ett neutralt.
 */
export function displayName(email: string, ownUrl: string): string {
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : '';
  if (local.length === 0 || local.length > MAX_DISPLAY_NAME_LENGTH || /[\p{C}\s]/u.test(local) || containsWebAddress(local, ownUrl)) {
    return 'En användare';
  }
  return local;
}

export function composeMail(input: MailInput): { readonly subject: string; readonly text: string } {
  const from = input.sender === null ? `påminnelse från ${input.appName}` : `från ${input.sender} via ${input.appName}`;
  const subject = `${input.draft ? '[Test] ' : ''}${input.subject} – ${from}`;

  const intro = input.draft
    ? [
        'Det här är ett testutskick från förhandsvisningen av din app. Bara du får det, eftersom',
        'utkastet ännu inte är publicerat — när appen är publicerad går aviseringarna till mottagarna.',
      ]
    : input.sender === null
      ? [`Det här är en påminnelse från appen (${input.appName}).`]
      : [`${input.sender} har skickat ett meddelande till dig via ${input.appName}.`];

  const footer = input.draft
    ? []
    : [
        `Öppna appen: ${input.appUrl}`,
        '',
        'Du får det här mejlet eftersom du har tillgång till appen. Din e-postadress visas inte för',
        'appen eller för avsändaren. Vill du inte ha fler aviseringar kan du stänga av dem i appen,',
        'eller be appens ägare ta bort din åtkomst.',
      ];

  const text = [
    ...intro,
    'Texten nedan är skriven i appen, inte av plattformen. Lämna aldrig ut lösenord eller koder.',
    '',
    RULE,
    input.text,
    RULE,
    '',
    ...footer,
  ].join('\n');

  return { subject, text: text.trimEnd() };
}
