/**
 * Återkoppling på BYGGVERKTYGET — inte på appen, och aldrig till språkmodellen.
 *
 * Den som bygger möter ibland ett svar som inte hjälper. Då ska hon kunna säga det, och det ska
 * nå den som driver plattformen. Byggverktyget formulerar mejlet men känner inte ägarens adress:
 * vägen dit och adressen hör hemma i plattformens konfiguration, precis som inbjudningarna
 * (`InvitationService`). Därför tar byggverktyget emot en `FeedbackMailer` och inget annat.
 *
 * Mejlet innehåller hela konversationen om appen, så att den som läser förstår sammanhanget.
 * Den som bygger får veta det INNAN hon skickar (rutan i gränssnittet säger det rakt ut).
 */
import type { BuilderMessage, Identity } from '@vibesandbox/contracts';

export interface FeedbackMail {
  /** Fast text. Ett ämne som byggs av indata kan bära en radbrytning och bli ett extra mejlhuvud. */
  readonly subject: string;
  readonly text: string;
}

export interface FeedbackMailer {
  /** Skickar återkopplingen till plattformens ägare. Kastar om den inte gick fram. */
  send(mail: FeedbackMail): Promise<void>;
}

export interface FeedbackReport {
  /** Den som lämnade återkopplingen. Adressen följer med, så att ägaren kan svara henne. */
  readonly from: Identity;
  readonly appName: string;
  /** Första tecknen av app-id:t. Hela id:t är den hemliga länken till appen och sprids inte. */
  readonly appIdPrefix: string;
  readonly text: string;
  readonly conversation: readonly BuilderMessage[];
  readonly at: string;
}

export const FEEDBACK_SUBJECT = 'Återkoppling på byggverktyget';

const ROLE_LABELS: Readonly<Record<BuilderMessage['role'], string>> = {
  user: 'Den som bygger',
  assistant: 'Byggverktyget',
};

export function composeFeedbackMail(report: FeedbackReport): FeedbackMail {
  const conversation =
    report.conversation.length === 0
      ? '(Konversationen är tom.)'
      : report.conversation.map((message) => `${ROLE_LABELS[message.role]} (${message.createdAt}):\n${message.text}`).join('\n\n');

  const text = [
    'Någon som bygger en app tycker inte att byggverktyget hjälpte.',
    '',
    `Från: ${report.from.email}`,
    `App: ${report.appName} (${report.appIdPrefix}…)`,
    `Tid: ${report.at}`,
    '',
    'Återkopplingen:',
    report.text,
    '',
    'Hela konversationen om appen:',
    conversation,
    '',
  ].join('\n');

  return { subject: FEEDBACK_SUBJECT, text };
}
