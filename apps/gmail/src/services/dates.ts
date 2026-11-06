/** Dates for the chat and the history. New records keep ISO text; older ones were saved as Spanish locale text. */
export function parseStamp(value: string | undefined | null): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) { const date = new Date(value); return isNaN(date.getTime()) ? null : date; }
  // Legacy "5/11/2026, 14:05:28" (day/month/year).
  const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const date = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] ?? 0));
  return isNaN(date.getTime()) ? null : date;
}

/** Local calendar day as yyyy-mm-dd, the value used by date inputs. */
export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function timeLabel(date: Date): string {
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

/** "Hoy", "Ayer" or the full date, for group headings. */
export function dayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return 'Hoy';
  if (dayKey(date) === dayKey(yesterday)) return 'Ayer';
  const text = date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Date and time on every chat message: "5 nov 2026 · 15:02". */
export function messageStamp(date: Date): string {
  return `${date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '')} · ${timeLabel(date)}`;
}
