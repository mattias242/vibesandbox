/**
 * Kopplingen mellan guidens knapp "Använd" och chattrutan som syns just nu (startsidans eller
 * arbetsytans). Chattrutan registrerar sig när den visas; guiden behöver inte veta vilken det är.
 * Texten klistras bara in — den skickas aldrig härifrån.
 */

type Receiver = (text: string) => void;

const receivers: Receiver[] = [];

/** Den senast registrerade chattrutan får texten. Ger en funktion som avregistrerar den. */
export function registerChatInput(receiver: Receiver): () => void {
  receivers.push(receiver);
  return () => {
    const index = receivers.lastIndexOf(receiver);
    if (index !== -1) receivers.splice(index, 1);
  };
}

/** Om det finns en chattruta att klistra in i just nu — guiden döljer annars knappen "Använd". */
export function hasChatInput(): boolean {
  return receivers.length > 0;
}

/** Falskt om ingen chattruta visas. */
export function insertIntoChat(text: string): boolean {
  const receiver = receivers.at(-1);
  if (receiver === undefined) return false;
  receiver(text);
  return true;
}

/** Det du redan skrivit behålls; exemplet läggs på en ny rad efter. */
export function appendToChat(current: string, text: string): string {
  const kept = current.trimEnd();
  return kept === '' ? text : `${kept}\n${text}`;
}
