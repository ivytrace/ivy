import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const uiDir = process.env.IVY_UI_DIR ?? path.resolve(process.cwd(), '../ui/dist');

serve({ fetch: createApp({ uiDir }).fetch, port }, (info) => {
  console.log(`Ivy API listening on :${info.port} (UI from ${uiDir})`);
});
