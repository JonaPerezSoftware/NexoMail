import { BadgeCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import type { MailInsights } from '@shared/mail/mail-insights';

/** Sender verification first (the most reliable signal), then the warnings and the details of the local analysis. */
export function MailSafety({report}:{report:MailInsights}) {
  const sender=report.sender;
  return <section className={`mail-safety ${report.level}`} aria-label="Análisis de seguridad del correo">
    {sender && <p className={`mail-sender mail-sender-${sender.status}`}>
      {sender.status==='verified'?<BadgeCheck aria-hidden="true"/>:sender.status==='failed'?<ShieldAlert aria-hidden="true"/>:<ShieldQuestion aria-hidden="true"/>}
      <span><strong>{sender.status==='verified'?`Remitente verificado: ${sender.domain}`:sender.status==='failed'?`Remitente NO verificado: ${sender.domain}`:`Remitente sin verificar: ${sender.domain}`}</strong>
        <small>{sender.detail}</small></span>
    </p>}
    <strong>{report.label}</strong>
    {report.reasons.filter(reason=>reason!==sender?.detail).length>0 && <ul>{report.reasons.filter(reason=>reason!==sender?.detail).map(reason=><li key={reason}>{reason}</li>)}</ul>}
    {report.notes.filter(note=>note!==sender?.detail).length>0 && <ul className="mail-notes">{report.notes.filter(note=>note!==sender?.detail).map(note=><li key={note}>{note}</li>)}</ul>}
    {report.level==='high' && <p>No introduzcas contraseñas ni códigos desde este mensaje. Comprueba la solicitud por otro canal.</p>}
    <details><summary>Detalles del análisis local{report.partial?' · Contenido parcial':''}</summary>
      <p>La verificación del remitente (SPF, DKIM y DMARC) la hizo tu servicio de correo al recibir el mensaje; NexoMail la lee y la explica. El resto se revisa en tu equipo: señales del texto, destinos de los enlaces y tu historial de remitentes. No se visitan los enlaces ni se analizan virus en los archivos. La ausencia de indicios no garantiza seguridad.</p>
      {report.partial && <p>Solo se pudo revisar parte del mensaje o faltan enlaces del cuerpo completo.</p>}
      {report.hasAttachments && <p>Contiene adjuntos. Solo se revisan los nombres disponibles; su contenido no ha sido analizado.</p>}
      {report.links.length>0 && <ul>{report.links.map((link,index)=><li key={index}><code>{link.domain}</code>{link.reasons.length===0?' · Destino sin verificar':''}</li>)}</ul>}
      <p>Categorías automáticas: {report.categories.join(', ') || 'Sin clasificar'}.</p>
      {report.specificLabels.length>0 && <p>Descriptores automáticos específicos: {report.specificLabels.join('; ')}.</p>}
      {report.classificationReasons.map(reason=><p key={reason}>{reason}</p>)}
    </details>
  </section>;
}
