import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { chooseProvider, fetchProviders, PROVIDER_EVENT, selectedProvider, type ProviderId, type ProviderOption } from '../services/llmClient';

/** «claude-opus-5-5» → «Claude Opus 5.5», «gemini-3.5-flash-lite» → «Gemini 3.5 Flash Lite». */
export function prettyModel(model: string): string {
  const claude = model.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? '.' + claude[3] : ''}`;
  if (/^gemini-/i.test(model)) return model.split('-').map((part) => (/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1))).join(' ');
  return model;
}

/** The AI models the server offers and the one in use (the person's choice, or the server default). */
export function useProviders() {
  const [options, setOptions] = useState<ProviderOption[]>([]);
  const [fallback, setFallback] = useState<string>('');
  const [chosen, setChosen] = useState<ProviderId | null>(selectedProvider());
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchProviders().then((info) => { if (active && info) { setOptions(info.options); setFallback(info.default); } if (active) setLoaded(true); });
    const onChange = (event: Event) => setChosen((event as CustomEvent<ProviderId | null>).detail);
    window.addEventListener(PROVIDER_EVENT, onChange);
    return () => { active = false; window.removeEventListener(PROVIDER_EVENT, onChange); };
  }, []);
  const current = chosen ?? (fallback === 'anthropic' || fallback === 'gemini' ? fallback : null);
  return { options, current, loaded, choose: chooseProvider };
}

/** Ajustes: one option per model, with what it costs and where the data goes. */
export function ModelChoice() {
  const { options, current, loaded, choose } = useProviders();
  if (!loaded) return <p className="model-choice-empty">Consultando los modelos disponibles…</p>;
  if (!options.length) return <p className="model-choice-empty">No se pudo consultar el servidor. Comprueba que INICIAR_SERVIDOR.cmd está abierto.</p>;
  return <div className="model-choice" role="radiogroup" aria-label="Modelo de IA">
    {options.map((option) => (
      <label key={option.id} className={`model-option${current === option.id ? ' selected' : ''}${option.configured ? '' : ' disabled'}`}>
        <input type="radio" name="nexomail-model" value={option.id} checked={current === option.id} disabled={!option.configured} onChange={() => choose(option.id)} />
        <span className="model-option-text">
          <strong>{prettyModel(option.model)} <span>· {option.label}</span></strong>
          <small>{option.configured ? option.note : 'Sin clave en backend/.env: añádela y reinicia el servidor para poder elegirlo.'}</small>
        </span>
      </label>
    ))}
  </div>;
}

/** Chat footer: the model in use; a click opens the same choice as a small menu. */
export function ModelMenu({ label, title, ready }: { label: string; title: string; ready: boolean }) {
  const { options, current, choose } = useProviders();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return <div className="model-menu" ref={box}>
    <button type="button" className="chat-meta-engine model-menu-button" title={`${title} · Pulsa para cambiar de modelo`} aria-haspopup="menu" aria-expanded={open} disabled={!options.length} onClick={() => setOpen((value) => !value)}>
      <span className={`status-dot ${ready ? 'active' : 'warning'}`} />
      {label}
      {options.length > 0 && <ChevronDown aria-hidden="true" className="model-menu-chevron" />}
    </button>
    {open && <div className="model-menu-list" role="menu" aria-label="Elegir modelo de IA">
      {options.map((option) => (
        <button key={option.id} type="button" role="menuitemradio" aria-checked={current === option.id} disabled={!option.configured}
          onClick={() => { choose(option.id); setOpen(false); }}>
          <span className="model-menu-check" aria-hidden="true">{current === option.id && <Check />}</span>
          <span><strong>{prettyModel(option.model)}</strong><small>{option.configured ? option.label : 'Sin clave en el servidor'}</small></span>
        </button>
      ))}
    </div>}
  </div>;
}
