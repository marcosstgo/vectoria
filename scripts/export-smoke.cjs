const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');

const source = path.resolve('artifacts', 'smoke-test.svg');
const outputDir = path.resolve('output', 'pdf');
const target = path.join(outputDir, 'vectoria-smoke-test.pdf');

if (!fs.existsSync(source)) throw new Error('Falta artifacts/smoke-test.svg. Ejecuta primero la prueba visual.');
fs.mkdirSync(outputDir, { recursive: true });

const svg = fs.readFileSync(source, 'utf8');
const viewBox = svg.match(/viewBox="[^"]*?([\d.]+)\s+([\d.]+)"/i);
const width = viewBox ? Number(viewBox[1]) : 900;
const height = viewBox ? Number(viewBox[2]) : 620;

const doc = new PDFDocument({ size: [width, height], margin: 0, compress: true });
const stream = fs.createWriteStream(target);
doc.pipe(stream);
// Fondo de contraste exclusivo de esta prueba visual; la app no lo exporta.
doc.rect(0, 0, width, height).fill('#162a32');
SVGtoPDF(doc, svg, 0, 0, { width, height, preserveAspectRatio: 'xMidYMid meet' });
doc.end();

stream.on('finish', () => console.log(target));
stream.on('error', (error) => { throw error; });
