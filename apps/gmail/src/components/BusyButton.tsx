import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  /** The work the button starts. While it runs the button is disabled, so it cannot be pressed twice. */
  onClick: () => unknown | Promise<unknown>;
  /** What the person sees meanwhile, such as "Enviando…". */
  busyLabel: string;
  /** Lets the parent keep the button busy (for example while a dialog it opened is still working). */
  busy?: boolean;
  children: ReactNode;
}

export function BusyButton({ onClick, busyLabel, busy: external = false, disabled, children, ...rest }: Props) {
  const [running, setRunning] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const busy = running || external;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy}
      onClick={async () => {
        if (busy) return;
        setRunning(true);
        try { await onClick(); } finally { if (mounted.current) setRunning(false); }
      }}
    >
      {busy ? <><Loader2 aria-hidden="true" className="spin" />{busyLabel}</> : children}
    </button>
  );
}
