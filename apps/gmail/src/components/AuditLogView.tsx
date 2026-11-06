import { useMemo, useState } from 'react';
import { CalendarDays, Download, FileText, History, Info, Mail, Search, Tag, Trash2, Undo2, type LucideIcon } from 'lucide-react';
import { dayKey, dayLabel, parseStamp, timeLabel } from '../services/dates';
import type { ActionType, AuditLog } from '../types/email';

type Filter = 'all' | 'changes' | 'rejected' | 'failed';
type Range = 'any' | 'today' | 'week' | 'month' | 'custom';

const RANGES: { id: Range; label: string }[] = [
  { id: 'any', label: 'Cualquier fecha' },
  { id: 'today', label: 'Hoy' },
  { id: 'week', label: 'Últimos 7 días' },
  { id: 'month', label: 'Últimos 30 días' },
  { id: 'custom', label: 'Elegir fechas…' },
];

/** First and last day (yyyy-mm-dd, inclusive) of the chosen range; null means no limit. */
function rangeBounds(range: Range, from: string, to: string): [string | null, string | null] {
  const today = new Date();
  const back = (days: number) => { const d = new Date(); d.setDate(today.getDate() - days); return dayKey(d); };
  if (range === 'today') return [dayKey(today), dayKey(today)];
  if (range === 'week') return [back(6), dayKey(today)];
  if (range === 'month') return [back(29), dayKey(today)];
  if (range === 'custom') return [from || null, to || null];
  return [null, null];
}

const ACTIONS: Partial<Record<ActionType, { label: string; icon: LucideIcon }>> = {
  LIST_EMAILS: { label: 'Consulta de correos', icon: Search },
  SUMMARIZE_THREAD: { label: 'Lectura de un correo', icon: FileText },
  SEND_EMAIL: { label: 'Envío de correo', icon: Mail },
  DRAFT_REPLY: { label: 'Borrador de respuesta', icon: Mail },
  DELETE_EMAIL: { label: 'Mover a la papelera', icon: Trash2 },
  BULK_CLEANUP: { label: 'Limpieza de correos', icon: Trash2 },
  LABEL_EMAIL: { label: 'Etiquetado', icon: Tag },
  MARK_READ: { label: 'Marcar como leído', icon: Mail },
  RESTORE_EMAIL: { label: 'Recuperación de la papelera', icon: Undo2 },
};

const STATUS: Record<AuditLog['executionStatus'], { label: string; tone: string }> = {
  AUTO_EXECUTED: { label: 'Completada', tone: 'done' },
  HUMAN_APPROVED: { label: 'Aprobada', tone: 'approved' },
  HUMAN_REJECTED: { label: 'Rechazada', tone: 'rejected' },
  FAILED: { label: 'Error', tone: 'failed' },
};

/** A draft is logged when the agent prepares it, before anyone approves it. */
function statusOf(log: AuditLog) {
  if (log.actionType === 'SEND_EMAIL' && log.executionStatus === 'HUMAN_APPROVED' && log.details.startsWith('Borrador de envío')) {
    return { label: 'Propuesta', tone: 'proposed' };
  }
  return STATUS[log.executionStatus] ?? { label: log.executionStatus, tone: 'done' };
}

/** Day heading and time for an entry. Very old entries saved only the time and are grouped as "Sin fecha". */
function stampOf(value: string): { key: string; day: string; time: string } {
  const date = parseStamp(value);
  if (date) return { key: dayKey(date), day: dayLabel(date), time: timeLabel(date) };
  return { key: 'sin-fecha', day: 'Sin fecha', time: value.slice(0, 5) };
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'changes', label: 'Cambios' },
  { id: 'rejected', label: 'Rechazadas' },
  { id: 'failed', label: 'Errores' },
];

/** Same export as Outlook: the session's history as a JSON file. */
function exportLogs(logs: AuditLog[]) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'auditoria-sesion.json'; link.click();
  URL.revokeObjectURL(url);
}

export function AuditLogView({ logs }: { logs: AuditLog[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [range, setRange] = useState<Range>('any');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const groups = useMemo(() => {
    const text = query.trim().toLowerCase();
    const visible = logs.filter((log) => {
      if (filter === 'changes' && log.executionStatus === 'AUTO_EXECUTED') return false;
      if (filter === 'rejected' && log.executionStatus !== 'HUMAN_REJECTED') return false;
      if (filter === 'failed' && log.executionStatus !== 'FAILED') return false;
      const [start, end] = rangeBounds(range, from, to);
      if (start || end) {
        const key = stampOf(log.timestamp).key;
        if (key === 'sin-fecha' || (start && key < start) || (end && key > end)) return false;
      }
      if (!text) return true;
      const action = ACTIONS[log.actionType]?.label ?? log.actionType;
      return `${action} ${log.actionType} ${log.prompt} ${log.details} ${statusOf(log).label}`.toLowerCase().includes(text);
    });
    const byDay = new Map<string, { day: string; items: AuditLog[] }>();
    for (const log of visible) {
      const { key, day } = stampOf(log.timestamp);
      const group = byDay.get(key) ?? { day, items: [] };
      group.items.push(log);
      byDay.set(key, group);
    }
    // Newest day first; entries without a date go last.
    const days = [...byDay.entries()].sort(([a], [b]) => a === 'sin-fecha' ? 1 : b === 'sin-fecha' ? -1 : b.localeCompare(a));
    return { total: visible.length, days };
  }, [logs, query, filter, range, from, to]);

  return (
    <>
      <div className="workspace-section-heading">
        <History size={21} />
        <h2>Historial</h2>
        <span className="workspace-count">{logs.length}</span>
      </div>
      <p className="pa-intro">Todo lo que el asistente consultó, propuso y ejecutó en esta sesión.</p>

      <div className="hx-tools">
        <label className="hx-search">
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar en el historial"
            aria-label="Buscar en el historial"
          />
        </label>
        <div className="hx-filters" role="group" aria-label="Filtrar el historial">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="hx-filter"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="hx-date">
          <CalendarDays aria-hidden="true" />
          <select value={range} onChange={(event) => setRange(event.target.value as Range)} aria-label="Filtrar por fecha">
            {RANGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        {range === 'custom' && (
          <div className="hx-range" role="group" aria-label="Rango de fechas">
            <label>Desde<input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>Hasta<input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
        )}
        <button type="button" className="pa-btn pa-btn-secondary" onClick={() => exportLogs(logs)} disabled={!logs.length}><Download aria-hidden="true" />Exportar</button>
      </div>

      {groups.total === 0 ? (
        <div className="pa-empty">
          <History aria-hidden="true" />
          <h3>Sin resultados</h3>
          <p>{logs.length ? 'Ningún evento coincide con la búsqueda, el filtro o las fechas.' : 'Aún no hay actividad en esta sesión.'}</p>
        </div>
      ) : (
        <div className="hx-list">
          {groups.days.map(([key, { day, items }]) => (
            <section key={key} className="hx-day" aria-label={day}>
              <h3 className="hx-day-title">{day}</h3>
              <ol className="hx-events">
                {items.map((log) => {
                  const action = ACTIONS[log.actionType] ?? { label: log.actionType, icon: Info };
                  const Icon = action.icon;
                  const status = statusOf(log);
                  return (
                    <li key={log.id} className="hx-event">
                      <span className={`hx-icon hx-${status.tone}`} aria-hidden="true"><Icon /></span>
                      <div className="hx-body">
                        <div className="hx-line">
                          <strong>{action.label}</strong>
                          <span className={`hx-status hx-${status.tone}`}>{status.label}</span>
                        </div>
                        {log.prompt && <p className="hx-prompt">{log.prompt}</p>}
                        {log.details && <p className="hx-details">{log.details}</p>}
                      </div>
                      <time className="hx-time">{stampOf(log.timestamp).time}</time>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
