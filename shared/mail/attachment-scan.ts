/**
 * Looks inside an attachment, on this device, without opening or running it (phase 3):
 * - what it really is (its first bytes), whatever its name says: a «factura.pdf» that is a Windows program;
 * - HTML files with a sign-in form (a fake login page sent as an attachment);
 * - Office documents with macros;
 * - ZIP files: programs inside, or a password lock whose password comes in the same email
 *   (a trick to get past antivirus scanners);
 * - PDF files with scripts or actions that launch programs.
 */
export interface AttachmentFinding { reason: string; weight: number }

const EXECUTABLE_NAME = /\.(?:exe|scr|com|bat|cmd|ps1|vbs|vbe|js|jse|msi|hta|lnk|pif|cpl|jar|wsf|reg|dll|iso|img|vhdx?|apk|sh)$/i;
const ascii = (bytes: Uint8Array, start = 0, length = bytes.length) => {
  let out = '';
  for (let i = start; i < Math.min(bytes.length, start + length); i++) out += String.fromCharCode(bytes[i]);
  return out;
};
const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((b, i) => bytes[offset + i] === b);

export type RealKind = 'exe' | 'elf' | 'macho' | 'lnk' | 'script' | 'zip' | 'ole' | 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'html' | 'rar' | '7z' | 'gzip' | 'text' | 'unknown';

/** What the bytes say the file is. */
export function realKind(bytes: Uint8Array): RealKind {
  if (startsWith(bytes, [0x4d, 0x5a])) return 'exe';
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return 'elf';
  if (startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])) return 'macho';
  if (startsWith(bytes, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return 'lnk';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (ascii(bytes, 0, 1024).includes('%PDF-')) return 'pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 2) === 'BM') return 'bmp';
  if (ascii(bytes, 0, 4) === 'Rar!') return 'rar';
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'gzip';
  const head = ascii(bytes, 0, 2048).replace(/^﻿|^ï»¿/, '').trimStart().toLowerCase();
  if (head.startsWith('#!')) return 'script';
  if (/^<(!doctype html|html|head|body|script|form|svg|\?xml)/.test(head) || /<html[\s>]/.test(head)) return 'html';
  if (/^[\x09\x0a\x0d\x20-\x7e -ÿ]*$/.test(ascii(bytes, 0, 512))) return 'text';
  return 'unknown';
}

/** What the name promises. */
function claimedKind(name: string): RealKind | 'office' | 'any' {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['pdf'].includes(ext)) return 'pdf';
  if (['png'].includes(ext)) return 'png';
  if (['jpg', 'jpeg', 'jfif'].includes(ext)) return 'jpeg';
  if (['gif'].includes(ext)) return 'gif';
  if (['webp'].includes(ext)) return 'webp';
  if (['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'odt', 'ods'].includes(ext)) return 'zip';
  if (['doc', 'xls', 'ppt', 'msg'].includes(ext)) return 'ole';
  if (['zip'].includes(ext)) return 'zip';
  if (['txt', 'csv'].includes(ext)) return 'text';
  if (['html', 'htm', 'svg', 'shtml', 'xhtml'].includes(ext)) return 'html';
  return 'any';
}

const LABEL: Record<string, string> = { exe: 'un programa de Windows', elf: 'un programa de Linux', macho: 'un programa de Mac', lnk: 'un acceso directo de Windows', script: 'un script', zip: 'un archivo comprimido', ole: 'un documento antiguo de Office', pdf: 'un PDF', png: 'una imagen', jpeg: 'una imagen', gif: 'una imagen', webp: 'una imagen', bmp: 'una imagen', html: 'una página web (HTML)', rar: 'un archivo comprimido', '7z': 'un archivo comprimido', gzip: 'un archivo comprimido', text: 'texto', unknown: 'otro tipo de archivo' };

/** Entries of a ZIP (names and whether they are password-protected), read from its headers. */
export function zipEntries(bytes: Uint8Array): { name: string; encrypted: boolean }[] {
  const out: { name: string; encrypted: boolean }[] = [];
  // Central directory entries (PK\x01\x02) list every file, even when the data uses descriptors.
  for (let i = 0; i < bytes.length - 46 && out.length < 2000; i++) {
    if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b || bytes[i + 2] !== 0x01 || bytes[i + 3] !== 0x02) continue;
    const flags = bytes[i + 8] | (bytes[i + 9] << 8);
    const nameLength = bytes[i + 28] | (bytes[i + 29] << 8);
    const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLength));
    out.push({ name, encrypted: (flags & 1) === 1 });
    i += 45 + nameLength;
  }
  return out;
}

const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * @param mailText text of the email the file came with (to spot «the password is 1234»).
 */
export function scanAttachment(name: string, bytes: Uint8Array, mailText = ''): AttachmentFinding[] {
  const findings: AttachmentFinding[] = [];
  const add = (reason: string, weight: number) => { if (!findings.some(f => f.reason === reason)) findings.push({ reason, weight }); };
  const kind = realKind(bytes);
  const claimed = claimedKind(name);
  const runnable = ['exe', 'elf', 'macho', 'lnk', 'script'].includes(kind);
  const named = `«${name}»`;

  // 1. Disguised programs: the name promises a document or image, the bytes are a program.
  if (runnable && !EXECUTABLE_NAME.test(name)) add(`${named} dice ser ${claimed === 'any' ? 'un documento' : LABEL[claimed] ?? 'un documento'}, pero en realidad es ${LABEL[kind]}. No lo abras.`, 5);
  else if (runnable) add(`${named} es ${LABEL[kind]}: puede tomar el control de tu equipo.`, 4);
  else if (claimed !== 'any' && claimed !== kind && !(claimed === 'text' && kind === 'unknown') && !(claimed === 'zip' && kind === 'zip')) {
    add(`${named} dice ser ${LABEL[claimed] ?? 'otro tipo'}, pero su contenido es ${LABEL[kind]}.`, kind === 'html' ? 3 : 1);
  }

  // 2. HTML attachments: a fake sign-in page opened from the computer escapes the browser's protections.
  if (kind === 'html' || claimed === 'html') {
    const html = norm(new TextDecoder().decode(bytes.subarray(0, 2_000_000)));
    if (/<form[\s>]/.test(html) && /type\s*=\s*["']?password/.test(html)) add(`${named} es una página con un formulario para escribir tu contraseña. Es una página de inicio de sesión falsa: no la abras.`, 5);
    else if (/<form[\s>]/.test(html) || /type\s*=\s*["']?password/.test(html)) add(`${named} es una página con un formulario. Las empresas no envían formularios como adjunto.`, 3);
    if (/<script[\s>]/.test(html) && /(atob\(|unescape\(|eval\(|fromcharcode|window\.location|document\.write)/.test(html)) add(`${named} contiene código oculto que se ejecuta al abrirlo.`, 3);
  }

  // 3. Office macros (OOXML keeps them in vbaProject.bin; old Office in a VBA stream).
  const entries = kind === 'zip' ? zipEntries(bytes) : [];
  if (entries.some(e => /(^|\/)vbaProject\.bin$/i.test(e.name))) add(`${named} contiene macros. Si al abrirlo te pide «Habilitar contenido», no lo hagas.`, 3);
  if (kind === 'ole') {
    const text = ascii(bytes, 0, Math.min(bytes.length, 8_000_000));
    const utf16 = new TextDecoder('utf-16le').decode(bytes.subarray(0, Math.min(bytes.length, 8_000_000)));
    if (/_VBA_PROJECT|VBA\/|Macros/.test(text) || /_VBA_PROJECT|Macros/.test(utf16)) add(`${named} contiene macros. Si al abrirlo te pide «Habilitar contenido», no lo hagas.`, 3);
  }

  // 4. ZIP files: programs inside, or a lock whose password travels in the same email.
  if (kind === 'zip') {
    const programs = entries.filter(e => EXECUTABLE_NAME.test(e.name) || /\.(?:html?|svg)$/i.test(e.name));
    if (programs.length) add(`${named} contiene ${programs.length === 1 ? `«${programs[0].name.split('/').pop()}»` : `${programs.length} archivos ejecutables o páginas web`}, que pueden ejecutar programas.`, 4);
    if (entries.some(e => e.encrypted)) {
      const passwordInMail = /\b(contrasena|clave|password|pass|pwd)\b/.test(norm(mailText));
      add(passwordInMail
        ? `${named} está protegido con contraseña y la contraseña viene en el correo: es un truco para que el antivirus no pueda revisarlo.`
        : `${named} está protegido con contraseña, así que ningún antivirus puede revisar su contenido.`, passwordInMail ? 4 : 2);
    }
  }
  if (kind === 'rar' || kind === '7z') add(`${named} es un archivo comprimido que NexoMail no puede abrir para revisarlo.`, 1);

  // 5. PDF files that run scripts or launch programs.
  if (kind === 'pdf') {
    const pdf = ascii(bytes, 0, Math.min(bytes.length, 10_000_000));
    if (/\/Launch\b/.test(pdf)) add(`${named} intenta abrir otro programa al leerlo.`, 4);
    if (/\/JavaScript\b|\/JS\s*[(<]/.test(pdf)) add(`${named} contiene código JavaScript.`, 2);
    if (/\/EmbeddedFile\b/.test(pdf)) add(`${named} lleva archivos escondidos dentro.`, 2);
  }
  return findings;
}
