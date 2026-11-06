import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
export default defineConfig({base:'./',plugins:[react()],resolve:{alias:{'@shared':fileURLToPath(new URL('../../shared',import.meta.url))}}});
