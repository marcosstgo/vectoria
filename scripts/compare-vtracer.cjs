const fs = require('fs');
const path = require('path');
const {
  vectorize,
  optimize,
  ColorMode,
  Hierarchical,
  PathSimplifyMode,
  OptimizePreset,
} = require('@neplex/vectorizer');

const input = process.argv[2];
if (!input || !fs.existsSync(input)) throw new Error('Uso: node scripts/compare-vtracer.cjs <imagen>');

const source = fs.readFileSync(input);
const outputDir = path.resolve('artifacts', 'vtracer-comparison');
fs.mkdirSync(outputDir, { recursive: true });

const common = {
  colorMode: ColorMode.Color,
  hierarchical: Hierarchical.Stacked,
  mode: PathSimplifyMode.Spline,
  pathPrecision: 2,
};

const variants = {
  suave: { ...common, filterSpeckle: 8, colorPrecision: 4, layerDifference: 20, cornerThreshold: 90, lengthThreshold: 6, maxIterations: 10, spliceThreshold: 55 },
  equilibrado: { ...common, filterSpeckle: 4, colorPrecision: 5, layerDifference: 14, cornerThreshold: 75, lengthThreshold: 4, maxIterations: 10, spliceThreshold: 45 },
  preciso: { ...common, filterSpeckle: 2, colorPrecision: 6, layerDifference: 8, cornerThreshold: 60, lengthThreshold: 3, maxIterations: 10, spliceThreshold: 35 },
};

(async () => {
  for (const [name, config] of Object.entries(variants)) {
    const started = performance.now();
    const raw = await vectorize(source, config);
    const svg = await optimize(raw, { preset: OptimizePreset.Safe, multipass: true, multipassIterations: 3 });
    const target = path.join(outputDir, `${name}.svg`);
    fs.writeFileSync(target, svg, 'utf8');
    const paths = (svg.match(/<path\b/g) || []).length;
    const nodes = (svg.match(/[MLCQAZ][-\d., ]*/gi) || []).length;
    console.log(`${name}: ${paths} formas, ${nodes} comandos, ${Buffer.byteLength(svg)} bytes, ${Math.round(performance.now() - started)} ms`);
  }
})();
