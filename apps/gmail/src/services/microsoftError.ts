const HINTS: Record<string,string> = {
  AADSTS9002326: 'La dirección está registrada como Web. En Microsoft Entra, muévela a la plataforma SPA.',
  AADSTS50011: 'La dirección de retorno no coincide. Registra como SPA la que aparece en Ajustes → Conexión de Microsoft.',
  AADSTS700016: 'Ese identificador de aplicación no existe. Revísalo en las opciones de la extensión.',
  AADSTS50194: 'La aplicación no admite este tipo de cuenta. Permite cuentas personales y de cualquier organización en Microsoft Entra.',
  AADSTS65001: 'Falta el consentimiento de los permisos. Vuelve a intentarlo y acéptalos, o pide la aprobación a un administrador.',
  AADSTS90094: 'Tu organización exige que un administrador apruebe la aplicación.',
  unauthorized_client: 'La aplicación no admite este tipo de cuenta. Permite cuentas personales y de cualquier organización en Microsoft Entra.',
  interaction_in_progress: 'Quedó una autorización anterior sin terminar. Recarga la pestaña del correo y vuelve a intentarlo.',
  state_mismatch: 'La respuesta no corresponde a esta ventana. Recarga la pestaña del correo y vuelve a intentarlo.',
  no_token_request_cache_error: 'Se perdió la autorización en curso. Recarga la pestaña del correo y vuelve a intentarlo.',
};

/** Explains a failed sign-in with its real cause. MSAL and Chrome errors carry no tokens; URLs are removed anyway. */
export function describeMicrosoftError(error: {errorCode?: string; errorMessage?: string; message?: string} | null | undefined): string {
  const firstLine = String(error?.errorMessage || error?.message || '').split('\n')[0].trim();
  const text = firstLine.replace(/https?:\/\/\S+/g, '').slice(0, 220).trim();
  if (/did not approve|user cancel/i.test(text)) return 'La ventana de Microsoft se cerró antes de terminar. Vuelve a intentarlo y completa el inicio de sesión.';
  if (/could not be loaded/i.test(text)) return 'No se pudo abrir la página de Microsoft. Comprueba tu conexión y vuelve a intentarlo.';
  const code = text.match(/AADSTS\d+/)?.[0] || error?.errorCode || '';
  if (!code) return text || 'Microsoft no completó el acceso y no indicó el motivo.';
  const hint = HINTS[code];
  return hint ? `${hint} (${code})` : `Microsoft no completó el acceso (${code}). ${text}`.trim();
}
