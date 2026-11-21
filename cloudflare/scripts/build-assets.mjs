import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.resolve(projectRoot, 'cloudflare/public');
const allowedFiles = ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js'];

await rm(publicDir, { recursive: true, force: true });
await mkdir(path.join(publicDir, 'assets'), { recursive: true });
for (const file of allowedFiles) await cp(path.join(projectRoot, file), path.join(publicDir, file));
await cp(path.join(projectRoot, 'assets', 'icon.svg'), path.join(publicDir, 'assets', 'icon.svg'));
console.log(`Built ${allowedFiles.length + 1} public web assets into cloudflare/public.`);
