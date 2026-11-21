// Pruebas del editor con formato: el filtro de HTML seguro, la copia en texto plano, las imágenes dentro del texto
// y el mensaje exacto que se enviaría por Gmail y por Outlook (sin enviar nada: las llamadas se interceptan).
// Ejecutar: npx vite apps/gmail --port 5199 y abrir http://localhost:5199/tests/compose.browser.html
import { draftBodyFromHtml, draftHtml, extractInlineImages, htmlToText, resolveInlineImages, sanitizeHtml, toEmailHtml, RICH_DRAFT_MARK } from '../src/services/richText';
import { realGmailProvider } from '../src/services/realGmailProvider';
import { outlookProvider } from '../src/services/outlookProvider';

const results: { name: string; ok: boolean; info: string }[] = [];
const check = (name: string, ok: boolean, info = '') => results.push({ name, ok, info });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 1. Filtro de seguridad
let html = sanitizeHtml('<p onclick="robar()">Hola <script>alert(1)</script><b>mundo</b></p><iframe src="https://x.example"></iframe>');
check('Quita scripts, eventos e iframes y conserva el formato', html === '<p>Hola <b>mundo</b></p>', html);
html = sanitizeHtml('<a href="javascript:alert(1)">pulsa</a> y <a href="https://banco.example/x">banco</a>');
check('Un enlace javascript: queda como texto; uno web se conserva', html === 'pulsa y <a href="https://banco.example/x">banco</a>', html);
html = sanitizeHtml('<span style="color:red;background-image:url(https://rastreo.example/p.gif);position:fixed">rojo</span>');
check('De los estilos solo quedan los de formato (nada que cargue o mueva cosas)', html === '<span style="color:red">rojo</span>', html);
html = sanitizeHtml(`<img src="https://rastreo.example/pixel.gif"><img src="data:image/png;base64,${PNG}" alt="logo">`);
check('Imágenes remotas (píxeles espía) fuera; las pegadas se conservan', !html.includes('rastreo') && html.includes('data:image/png;base64'), html);
html = sanitizeHtml('<font size="5" color="#1a73e8">Grande</font>');
check('El tamaño y color del editor pasan a estilos seguros', html === '<span style="font-size:24px;color:#1a73e8">Grande</span>', html);
html = sanitizeHtml('<table><tr><td>celda</td></tr></table><form><input value="x"></form>');
check('Tablas: queda su texto; formularios: fuera', html === 'celda', html);

// 2. Copia en texto plano
const text = htmlToText('<p>Hola <b>equipo</b>:</p><ul><li>Uno</li><li>Dos</li></ul><ol><li>Primero</li><li>Segundo</li></ol><p>Ver <a href="https://ejemplo.com/a">el informe</a></p>');
check('Texto plano: viñetas, números y enlaces visibles', text === 'Hola equipo:\n• Uno\n• Dos\n1. Primero\n2. Segundo\nVer el informe (https://ejemplo.com/a)', JSON.stringify(text));

// 3. Imágenes dentro del texto
const { html: withCid, images } = extractInlineImages(`<p>Logo:</p><img src="data:image/png;base64,${PNG}" alt="logo">`);
check('Una imagen pegada pasa a adjunto en línea con cid:', images.length === 1 && images[0].inline === true && withCid.includes(`cid:${images[0].cid}`) && !withCid.includes('base64'), withCid);
check('…y vuelve a verse al editar', resolveInlineImages(withCid, images).includes(`data:image/png;base64,${PNG}`));
check('Si la imagen no se conservó (tras recargar), queda un aviso en su lugar', resolveInlineImages(withCid, []).includes('[imagen no conservada]'));
check('El correo enviado lleva estilo de cita y de imagen como Gmail', /border-left:1px solid #ccc/.test(toEmailHtml('<blockquote>cita</blockquote>')) && /max-width:100%/.test(toEmailHtml(`<img src="cid:a@b">`)));

// 4. Borradores
const draft = draftBodyFromHtml(`<b>Hola</b><img src="data:image/png;base64,${PNG}">`);
check('El borrador guarda el formato y avisa de que no guarda imágenes', draft.body.startsWith(RICH_DRAFT_MARK) && draft.body.includes('<b>Hola</b>') && draft.droppedImages, draft.body);
check('…y se reabre con el formato', draftHtml(draft.body).includes('<b>Hola</b>'));
check('Un borrador antiguo de texto se abre como texto', draftHtml('Línea 1\nLínea 2') === 'Línea 1<br>Línea 2', draftHtml('Línea 1\nLínea 2'));

// 5. Gmail: el mensaje MIME exacto (intercepta la llamada, no envía)
{
  const gmail = realGmailProvider as unknown as { config: unknown; accessToken: () => Promise<string>; gmailRequest: (url: string, init: RequestInit) => Promise<Response> };
  let sent = '';
  gmail.config = { sessionId: 's', email: 'yo@gmail.com', accessToken: 't' };
  gmail.accessToken = async () => 't';
  gmail.gmailRequest = async (_url, init) => { sent = String(init.body); return new Response('{}', { status: 200 }); };
  const inline = { ...images[0] };
  const pdf = { name: 'informe.pdf', type: 'application/pdf', size: 4, data: 'JVBERg==' };
  await realGmailProvider.sendEmail('ana@empresa.com, luis@empresa.com', 'Reunión', 'Hola equipo', [inline, pdf], { cc: 'jefe@empresa.com', bcc: 'archivo@empresa.com', html: `<b>Hola</b> equipo<img src="cid:${inline.cid}">` });
  const decoded = [...sent.matchAll(/Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]+?)\r\n--/g)].map((m) => decodeURIComponent(escape(atob(m[1].replace(/\r\n/g, '')))))[0] ?? '';
  check('Gmail: Para con dos destinatarios, Cc y Cco en las cabeceras', /^To: ana@empresa\.com, luis@empresa\.com\r\nCc: jefe@empresa\.com\r\nBcc: archivo@empresa\.com\r\n/.test(sent), sent.slice(0, 200));
  check('Gmail: texto plano + HTML con formato', sent.includes('multipart/alternative') && decoded.includes('<b>Hola</b>'), decoded.slice(0, 200));
  check('Gmail: la imagen va dentro del texto (multipart/related + Content-ID)', sent.includes('multipart/related') && sent.includes(`Content-ID: <${inline.cid}>`) && decoded.includes(`cid:${inline.cid}`));
  check('Gmail: el PDF va como adjunto normal', /Content-Disposition: attachment; filename\*=UTF-8''informe\.pdf/.test(sent));
  let error = '';
  await realGmailProvider.sendEmail('ana@empresa.com', 'x', 'y', [], { cc: 'no-es-correo' }).catch((e) => { error = e.message; });
  check('Gmail: un Cc inválido no se envía', /Revisa los destinatarios/.test(error), error);
}

// 6. Outlook: el mensaje de Microsoft Graph (intercepta la llamada, no envía)
{
  const outlook = outlookProvider as unknown as { account: unknown; graph: (method: string, path: string, body: unknown) => Promise<unknown> };
  let message: Record<string, any> = {};
  outlook.account = { homeAccountId: 'h', username: 'yo@outlook.com' };
  outlook.graph = async (_method, _path, body) => { message = (body as { message: Record<string, unknown> }).message; return {}; };
  const inline = { ...images[0] };
  await outlookProvider.sendEmail('ana@empresa.com', 'Reunión', 'Hola', [inline], { cc: 'jefe@empresa.com', bcc: 'archivo@empresa.com', html: `<i>Hola</i><img src="cid:${inline.cid}">` });
  check('Outlook: cuerpo HTML con formato', message.body?.contentType === 'HTML' && message.body.content.includes('<i>Hola</i>'), JSON.stringify(message.body).slice(0, 160));
  check('Outlook: Cc y Cco como destinatarios', message.ccRecipients?.[0]?.emailAddress.address === 'jefe@empresa.com' && message.bccRecipients?.[0]?.emailAddress.address === 'archivo@empresa.com');
  check('Outlook: la imagen va en línea con su contentId', message.attachments?.[0]?.isInline === true && message.attachments[0].contentId === inline.cid);
  await outlookProvider.sendEmail('ana@empresa.com', 'x', 'texto simple', []);
  check('Outlook: un correo sin formato sigue yendo como texto', message.body?.contentType === 'Text' && !message.ccRecipients);
}

// 7. Lector: imágenes que vienen dentro del correo (cid:)
{
  const { mailDocument } = await import('@shared/mail/mail-document');
  const { loadInlineImages, isInlineImage } = await import('../src/services/inlineImages');
  const dataUrl = `data:image/png;base64,${PNG}`;
  let doc = mailDocument('<p>Logo</p><img src="cid:logo@x"><img src="https://rastreo.example/p.png">', false, { 'logo@x': dataUrl }).document;
  check('El lector muestra la imagen propia del correo sin pedir permiso…', doc.includes(dataUrl), doc.slice(-300));
  check('…pero sigue bloqueando las imágenes de internet', !doc.includes('rastreo.example') && /img-src data:;/.test(doc));
  doc = mailDocument('<img src="cid:otro@x">', false, { 'otro@x': 'data:text/html;base64,PHNjcmlwdD4=' }).document;
  check('Un cid: que no es una imagen no se muestra', !doc.includes('data:text/html'));
  const email = { id: 'm1', bodyHtml: '<img src="cid:logo@x">', sender: 'a@b.com' } as never;
  const list = async () => [{ id: 'a1', name: 'logo.png', type: 'image/png', size: 70, cid: 'logo@x' }, { id: 'a2', name: 'informe.pdf', type: 'application/pdf', size: 10 }];
  const download = async () => new Blob([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], { type: 'image/png' });
  const images = await loadInlineImages(email, list, download);
  check('Las imágenes del texto se descargan y se convierten para el lector', images['logo@x']?.startsWith('data:image/png;base64,'), JSON.stringify(images).slice(0, 80));
  check('…y no aparecen como adjuntos; el PDF sí', isInlineImage((await list())[0], email) && !isInlineImage((await list())[1], email));
}

// 8. Gmail: lee el Content-ID de las imágenes y el hilo para «Abrir en Gmail»
{
  const gmail = realGmailProvider as unknown as { parseGmailMessage: (msg: unknown, labels: Map<string, string>) => { attachments?: { cid?: string; name: string }[]; threadId?: string } };
  const b64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_');
  const parsed = gmail.parseGmailMessage({ id: '18c2f0a1b2c3d4e5', threadId: '18c2f0a1b2c3d4e0', labelIds: ['SENT'], internalDate: String(Date.now()), snippet: '', payload: {
    mimeType: 'multipart/related', headers: [{ name: 'From', value: 'Yo <yo@gmail.com>' }, { name: 'Subject', value: 'Logo' }], parts: [
      { mimeType: 'text/html', body: { data: b64url('<p>Hola</p><img src="cid:img-1@nexomail">') } },
      { mimeType: 'image/png', filename: '', headers: [{ name: 'Content-ID', value: '<img-1@nexomail>' }], body: { attachmentId: 'ATT1', size: 70 } },
    ] } }, new Map());
  check('Gmail: la imagen del texto se reconoce por su Content-ID (aunque no tenga nombre)', parsed.attachments?.[0]?.cid === 'img-1@nexomail', JSON.stringify(parsed.attachments));
  check('Gmail: guarda el hilo para abrirlo en Gmail', parsed.threadId === '18c2f0a1b2c3d4e0');
}

const failed = results.filter((x) => !x.ok).length;
document.body.innerHTML = `<h1>${failed ? `HAY FALLOS (${failed})` : 'TODO OK'} · ${results.length} pruebas</h1><ul>${results.map((x) => `<li style="color:${x.ok ? '#17603f' : '#b52740'}">${x.ok ? 'OK' : 'FALLO'} · ${x.name}${x.ok ? '' : `<br><small>${x.info.replace(/</g, '&lt;')}</small>`}</li>`).join('')}</ul>`;
(window as unknown as { composeResults: unknown }).composeResults = { failed, total: results.length, results };
