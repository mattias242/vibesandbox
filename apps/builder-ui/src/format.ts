/**
 * Stora tal i svensk form, med mellanrum mellan tusentalen: 1 234 567. Kontrollrummet visar
 * tal som annars blir en obegriplig sifferrad. Ett tal som inte är ett tal blir ett streck —
 * "NaN" säger ingenting för den som läser.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '–';
  return value.toLocaleString('sv-SE');
}

/** Hur "senast ändrad" visas: "i dag 09:05", "i går 23:59", "3 mars", "24 dec. 2025". */
export function formatUpdated(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const time = date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (date.getTime() >= startOfToday && date.getTime() < startOfToday + dayMs) return `i dag ${time}`;
  if (date.getTime() >= startOfToday - dayMs && date.getTime() < startOfToday) return `i går ${time}`;

  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return date.toLocaleDateString('sv-SE', options);
}
