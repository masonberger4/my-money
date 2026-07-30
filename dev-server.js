import express from 'express';
import dotenv from 'dotenv';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

dotenv.config({ path: '.env.local' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const apiDir = join(__dirname, 'api');
const files = readdirSync(apiDir).filter((f) => f.endsWith('.js'));

for (const file of files) {
  const route = '/api/' + file.replace(/\.js$/, '');
  const moduleUrl = pathToFileURL(join(apiDir, file)).href;
  const mod = await import(moduleUrl);
  const handler = mod.default;
  if (typeof handler !== 'function') {
    console.warn(`Skipping ${file}: no default export function`);
    continue;
  }
  // Any method: Vercel routes a file to every verb and each handler does its
  // own method check (simplefin-status answers GET and DELETE, not POST).
  app.all(route, (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error(`Unhandled error in ${route}:`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  });
  console.log(`Mounted ${route}`);
}

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Dev API server listening on http://localhost:${PORT}`);
});
