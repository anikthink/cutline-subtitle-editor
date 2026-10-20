import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modules = ['core', 'storage', 'media', 'cue-list', 'timeline', 'app'];
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const css = await readFile(path.join(root, 'assets/styles.css'), 'utf8');
const sources = await Promise.all(modules.map(name => readFile(path.join(root, 'src', name + '.js'), 'utf8')));
const script = sources.map(source => source.replace(/^import .* from ['"][^'"]+['"];?\r?\n/gm, '').replace(/^export /gm, '')).join('\n\n');
const standalone = html.replace('<link rel="stylesheet" href="./assets/styles.css">', `<style>${css}</style>`)
  .replace('<script type="module" src="./src/app.js"></script>', `<script>(()=>{\n'use strict';\n${script.replace(/<\/script/gi, '<\\/script')}\n})();</script>`)
  .replace('<a href="./downloads/Cutline.html" download="Cutline.html">Download standalone app</a>', '<button type="button" onclick="document.getElementById(\'projectMenu\').open=false;document.getElementById(\'noticeText\').textContent=\'You are using the standalone app. Keep this HTML file to use it offline.\';document.getElementById(\'notice\').hidden=false;">Standalone app</button>');

for (const directory of ['downloads', 'dist', 'dist/assets', 'dist/src', 'dist/downloads']) await mkdir(path.join(root, directory), { recursive: true });
await writeFile(path.join(root, 'downloads/Cutline.html'), standalone);
await writeFile(path.join(root, 'dist/downloads/Cutline.html'), standalone);
await copyFile(path.join(root, 'index.html'), path.join(root, 'dist/index.html'));
await copyFile(path.join(root, 'assets/styles.css'), path.join(root, 'dist/assets/styles.css'));
for (const name of modules) await copyFile(path.join(root, 'src', name + '.js'), path.join(root, 'dist/src', name + '.js'));
console.log(`Built the web app and self-contained downloads/Cutline.html (${Buffer.byteLength(standalone).toLocaleString()} bytes).`);
