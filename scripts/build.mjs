import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function run(app,cli,args){const cwd=path.join(root,'apps',app);const executable=path.join(cwd,'node_modules',cli);if(!existsSync(executable))throw new Error(`Faltan dependencias de ${app}. Ejecuta RECOMPILAR.cmd.`);const result=spawnSync(process.execPath,[executable,...args],{cwd,stdio:'inherit'});if(result.status!==0)process.exit(result.status || 1);}
// One React interface for both mailboxes. The mode selects the provider (Gmail API or Microsoft Graph); see apps/gmail/.env*.
run('gmail','typescript/bin/tsc',['-b']);
run('gmail','vite/bin/vite.js',['build','--outDir',path.join(root,'extension/apps/gmail'),'--emptyOutDir']);
run('gmail','vite/bin/vite.js',['build','--mode','outlook','--outDir',path.join(root,'extension/apps/outlook'),'--emptyOutDir']);
console.log('Extensión compilada. Recárgala con «Recargar» en Ajustes de NexoMail (o en las opciones de la extensión, o en chrome://extensions).');
