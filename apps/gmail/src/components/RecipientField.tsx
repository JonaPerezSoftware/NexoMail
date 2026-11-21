import { useMemo, useState } from 'react';
import { findContacts, type Contact } from '../services/contacts';
import { mailProvider } from '../services/mailProvider';

/**
 * Para / Cc / Cco: several addresses separated by commas, as in Gmail. While you type a name or part of an address,
 * people from your contact book are suggested; picking one completes the address you were writing.
 */
export function RecipientField({ id, label, value, onChange, autoFocus, inputRef, trailing }: {
  id: string; label: string; value: string; onChange: (value: string) => void; autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>; trailing?: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const current = value.split(/[;,]/).pop()?.trim() ?? '';
  const suggestions: Contact[] = useMemo(() => {
    if (!focused || current.length < 2) return [];
    let found: Contact[] = [];
    try { found = findContacts(mailProvider.getSessionKey(), current, 6); } catch { found = []; }
    const already = new Set(value.toLowerCase().split(/[;,]/).map((part) => part.trim()));
    return found.filter((contact) => !already.has(contact.address.toLowerCase()));
  }, [focused, current, value]);

  const pick = (contact: Contact) => {
    const parts = value.split(/[;,]/).map((part) => part.trim());
    parts[parts.length - 1] = contact.address;
    onChange(parts.filter(Boolean).join(', ') + ', ');
    setHighlight(0);
  };

  return (
    <div className="rf">
      <label htmlFor={id}>{label}</label>
      <div className="rf-input">
        <input ref={inputRef} id={id} type="text" inputMode="email" autoComplete="off" spellCheck={false} autoFocus={autoFocus} value={value}
          placeholder="nombre@dominio.com, otra@dominio.com"
          role="combobox" aria-expanded={suggestions.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list"
          onChange={(event) => { onChange(event.target.value); setHighlight(0); }}
          onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(event) => {
            if (!suggestions.length) return;
            if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((h) => (h + 1) % suggestions.length); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length); }
            else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(suggestions[highlight]); }
          }} />
        {trailing}
        {suggestions.length > 0 && (
          <ul id={`${id}-list`} className="rf-list" role="listbox" aria-label="Contactos sugeridos">
            {suggestions.map((contact, index) => (
              <li key={contact.address} role="option" aria-selected={index === highlight} className={index === highlight ? 'on' : ''}
                onMouseDown={(event) => { event.preventDefault(); pick(contact); }}>
                <strong>{contact.name || contact.address}</strong>{contact.name && <small>{contact.address}</small>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
