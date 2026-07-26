import fs from 'node:fs';
import path from 'node:path';

const required = [
  'src/main.js',
  'src/logo-tracer.js',
  'src/resample.js',
  'src/preload.js',
  'scripts/lib/svg-geometry.cjs',
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'src/renderer/app.js',
  'node_modules/imagetracerjs/imagetracer_v1.2.6.js',
  'node_modules/@neplex/vectorizer/index.js',
];

let failed = false;
for (const file of required) {
  if (!fs.existsSync(path.resolve(file))) {
    console.error(`Falta: ${file}`);
    failed = true;
  }
}

const html = fs.readFileSync('src/renderer/index.html', 'utf8');
for (const id of ['stage', 'originalImage', 'vectorLayer', 'traceBtn', 'exportBtn', 'exportDialog', 'regularizeRange', 'diffLayer']) {
  if (!html.includes(`id="${id}"`)) {
    console.error(`Falta el elemento #${id}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('Vectoria: estructura verificada.');
