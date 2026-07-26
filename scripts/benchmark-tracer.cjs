'use strict';

// Banco de pruebas del trazador de logos.
//
// Genera formas sinteticas con antialias real (16x16 muestras por pixel, o sea
// cobertura de area exacta), las vectoriza y mide tres cosas contra la forma
// original: fidelidad de area (IoU), cuanto se aparta el trazado de los
// vertices teoricos, y cuantos comandos hace falta para conseguirlo.
//
// Uso:
//   node scripts/benchmark-tracer.cjs                 -> motor actual
//   node scripts/benchmark-tracer.cjs <ruta-motor>    -> compara contra otro
//
// El segundo argumento permite medir una version anterior del trazador y ver
// si un cambio mejora o empeora, en vez de juzgarlo a ojo.

const path = require('node:path');
const current = require('../src/logo-tracer');
const { planWorkingSize, resampleRgba } = require('../src/resample');
const {
  flattenPath,
  rasterize,
  sampleTruth,
  intersectionOverUnion,
  curvatureRoughness,
  distanceToContour,
  extractPathData,
  renderShape,
} = require('./lib/svg-geometry.cjs');

const alternativePath = process.argv[2];
const alternative = alternativePath ? require(path.resolve(alternativePath)) : null;

/* ----------------------------- casos ----------------------------- */

function rotatedSquare() {
  const width = 160;
  const height = 160;
  const center = { x: 80, y: 80 };
  const half = 46;
  const angle = Math.PI / 7;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const inside = (x, y) => {
    const dx = x - center.x;
    const dy = y - center.y;
    return Math.abs(dx * cos + dy * sin) <= half && Math.abs(-dx * sin + dy * cos) <= half;
  };
  const vertices = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => ({
    x: center.x + su * half * cos - sv * half * sin,
    y: center.y + su * half * sin + sv * half * cos,
  }));
  return { name: 'cuadrado girado', width, height, inside, vertices };
}

function letterShape() {
  const width = 120;
  const height = 150;
  const counter = { cx: 70, cy: 52, rx: 20, ry: 24, inner: 0.62 };
  const inside = (x, y) => {
    const inStem = x >= 26 && x <= 34 && y >= 20 && y <= 120;
    const inFoot = x >= 26 && x <= 92 && y >= 112 && y <= 120;
    const nx = (x - counter.cx) / counter.rx;
    const ny = (y - counter.cy) / counter.ry;
    const radial = nx * nx + ny * ny;
    return inStem || inFoot || (radial <= 1 && radial >= counter.inner * counter.inner);
  };
  const vertices = [
    { x: 26, y: 20 }, { x: 34, y: 20 }, { x: 92, y: 112 }, { x: 92, y: 120 }, { x: 26, y: 120 },
  ];
  return { name: 'letra con asta y contrapunto', width, height, inside, vertices };
}

function starShape() {
  const width = 180;
  const height = 180;
  const center = { x: 90, y: 90 };
  const points = 5;
  const outer = 74;
  const inner = 30;
  const vertices = [];
  for (let index = 0; index < points * 2; index += 1) {
    const angle = (Math.PI * index) / points - Math.PI / 2;
    const radius = index % 2 === 0 ? outer : inner;
    vertices.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  const inside = (x, y) => {
    let crossings = 0;
    for (let index = 0; index < vertices.length; index += 1) {
      const a = vertices[index];
      const b = vertices[(index + 1) % vertices.length];
      if ((a.y > y) === (b.y > y)) continue;
      if (a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x) > x) crossings += 1;
    }
    return crossings % 2 === 1;
  };
  return { name: 'estrella de 5 puntas', width, height, inside, vertices };
}

function ellipseShape() {
  const width = 120;
  const height = 150;
  const inside = (x, y) => ((x - 60) / 40) ** 2 + ((y - 70) / 50) ** 2 <= 1;
  return { name: 'elipse (sin esquinas)', width, height, inside, vertices: [] };
}

const cases = [rotatedSquare(), letterShape(), starShape(), ellipseShape()];

/* ----------------------------- medida ---------------------------- */

function measure(engine, shape, detail, useResample, regularize) {
  const pixels = renderShape(shape.width, shape.height, shape.inside);
  const analysis = engine.analyzeMonochromeLogo(pixels, shape.width, shape.height);
  if (!analysis.eligible) return null;

  const plan = useResample
    ? planWorkingSize(shape.width, shape.height, { target: 1800, maxScale: 4 })
    : { scale: 1, width: shape.width, height: shape.height };
  const working = plan.scale === 1
    ? { data: pixels, width: shape.width, height: shape.height }
    : resampleRgba(pixels, shape.width, shape.height, plan.width, plan.height);

  const started = process.hrtime.bigint();
  const result = engine.traceMonochromeLogo(working.data, working.width, working.height, {
    detail,
    smooth: true,
    analysis,
    ...(regularize === undefined ? {} : { regularize }),
    output: { width: shape.width, height: shape.height },
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  if (!result) return null;

  const subpaths = flattenPath(extractPathData(result.svg));
  const samples = 4;
  const traced = rasterize(subpaths, shape.width, shape.height, samples);
  const truth = sampleTruth(shape.inside, shape.width, shape.height, samples);
  const iou = intersectionOverUnion(traced.mask, truth.mask);
  const gaps = shape.vertices.map((vertex) => distanceToContour(subpaths, vertex));

  return {
    iou,
    roughness: curvatureRoughness(subpaths),
    worstGap: gaps.length ? Math.max(...gaps) : 0,
    commands: result.curveCount,
    shapes: result.shapeCount || 0,
    subpaths: subpaths.length,
    milliseconds: elapsed,
  };
}

function format(measurement) {
  if (!measurement) return '           no elegible';
  return `IoU ${measurement.iou.toFixed(5)}  aspereza ${measurement.roughness.toFixed(4)}  `
    + `vertice ${measurement.worstGap.toFixed(3)} px  ${String(measurement.commands).padStart(3)} cmd  `
    + `${measurement.shapes} formas  ${measurement.milliseconds.toFixed(0)} ms`;
}

const detail = Number(process.env.DETAIL || 1);
const regularize = process.env.REGULARIZE === undefined ? undefined : Number(process.env.REGULARIZE);
console.log(`Perfil de detalle: ${['Simple', 'Equilibrado', 'Preciso'][detail]}`);
console.log('IoU: parecido al ráster (más alto es más fiel). Aspereza: variación de curvatura (más bajo es más suave).\n');

cases.forEach((shape) => {
  console.log(shape.name);
  if (alternative) {
    console.log(`  referencia  ${format(measure(alternative, shape, detail, false, regularize))}`);
  }
  console.log(`  actual      ${format(measure(current, shape, detail, true, regularize))}`);
  console.log('');
});

if (!alternative) {
  console.log('Sugerencia: pasa la ruta de otro motor como argumento para comparar.');
}
