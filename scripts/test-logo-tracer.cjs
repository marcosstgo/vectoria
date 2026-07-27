'use strict';

const assert = require('node:assert/strict');
const { analyzeMonochromeLogo, traceMonochromeLogo, traceLogo } = require('../src/logo-tracer');
const { planWorkingSize, resampleRgba } = require('../src/resample');
const {
  flattenPath,
  rasterize,
  sampleTruth,
  intersectionOverUnion,
  distanceToContour,
  extractPathData,
  renderShape,
  isInside,
} = require('./lib/svg-geometry.cjs');

const results = [];
function report(name, detail) {
  results.push(`  ${name}: ${detail}`);
}

// Ejecuta el trazador tal como lo hace main.js: analiza, decide resolucion de
// trabajo, remuestrea y traza devolviendo coordenadas de la imagen original.
function trace(pixels, width, height, settings = {}) {
  const analysis = analyzeMonochromeLogo(pixels, width, height);
  const plan = planWorkingSize(width, height, {
    target: settings.target || 1800,
    maxScale: settings.maxScale === undefined ? 4 : settings.maxScale,
  });
  const working = plan.width === width && plan.height === height
    ? { data: pixels, width, height }
    : resampleRgba(pixels, width, height, plan.width, plan.height);
  const result = traceMonochromeLogo(working.data, working.width, working.height, {
    detail: 1,
    smooth: true,
    ...settings,
    analysis,
    output: { width, height },
  });
  return { analysis, plan, result };
}

function fidelity(result, width, height, inside, samples = 4) {
  const subpaths = flattenPath(extractPathData(result.svg));
  const traced = rasterize(subpaths, width, height, samples);
  const truth = sampleTruth(inside, width, height, samples);
  return { subpaths, iou: intersectionOverUnion(traced.mask, truth.mask) };
}

/* ------------------------------------------------------------------ *
 * 1. Regresion original: rectangulo con hueco, bordes duros
 * ------------------------------------------------------------------ */
{
  const width = 48;
  const height = 36;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const outer = x >= 4 && x <= 43 && y >= 4 && y <= 31;
      const hole = x >= 16 && x <= 31 && y >= 12 && y <= 23;
      pixels[offset] = 245;
      pixels[offset + 1] = 250;
      pixels[offset + 2] = 248;
      pixels[offset + 3] = outer && !hole ? 255 : 0;
    }
  }

  const analysis = analyzeMonochromeLogo(pixels, width, height);
  assert.equal(analysis.eligible, true, 'Un logo transparente de un solo color debe usar el trazador especializado.');
  assert.equal(analysis.mode, 'alpha');

  const result = traceMonochromeLogo(pixels, width, height, { detail: 1, smooth: true });
  assert.ok(result, 'El logo debe producir un SVG.');
  assert.equal(result.contourCount, 2, 'El contorno exterior y su hueco deben conservarse.');
  assert.match(result.svg, /fill-rule="evenodd"/);
  assert.match(result.svg, /viewBox="0 0 48 36"/);
  assert.doesNotMatch(result.svg, /<image\b/);
  assert.ok(result.curveCount > 2 && result.curveCount < 80, 'El resultado debe seguir siendo compacto y editable.');

  // Cuatro esquinas por rectangulo: si el detector no las viera, el ajuste
  // volveria a producir curvas suaves en todo el perimetro.
  assert.equal(result.cornerCount, 8, `Se esperaban 8 esquinas y se detectaron ${result.cornerCount}.`);
  assert.ok(
    result.curveCount <= 10,
    `Un rectangulo con hueco deberia salir con 8 comandos rectos, salieron ${result.curveCount}.`,
  );
  report('rectangulo con hueco', `${result.contourCount} contornos, ${result.curveCount} comandos, ${result.cornerCount} esquinas`);
}

/* ------------------------------------------------------------------ *
 * 2. Cuadrado girado con antialias real
 *    Mide directamente lo que fallaba: el vertice tiene que quedar en punta.
 * ------------------------------------------------------------------ */
{
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
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    return Math.abs(u) <= half && Math.abs(v) <= half;
  };
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => ({
    x: center.x + su * half * cos - sv * half * sin,
    y: center.y + su * half * sin + sv * half * cos,
  }));

  const pixels = renderShape(width, height, inside);
  const { result, plan } = trace(pixels, width, height);
  assert.ok(result, 'El cuadrado girado debe vectorizarse.');
  assert.equal(result.cornerCount, 4, `Se esperaban 4 esquinas, se detectaron ${result.cornerCount}.`);

  const { subpaths, iou } = fidelity(result, width, height, inside);
  const gaps = corners.map((corner) => distanceToContour(subpaths, corner));
  const worstGap = Math.max(...gaps);

  assert.ok(worstGap < 0.35, `El vertice mas romo se aparta ${worstGap.toFixed(3)} px del real (limite 0.35).`);
  assert.ok(iou > 0.998, `Fidelidad de area insuficiente: IoU ${iou.toFixed(5)}.`);
  report('cuadrado girado', `IoU ${iou.toFixed(5)}, vertice mas romo ${worstGap.toFixed(3)} px, escala de trabajo ${plan.scale}x`);
}

/* ------------------------------------------------------------------ *
 * 3. Forma tipografica: asta fina, remate recto y contrapunto
 * ------------------------------------------------------------------ */
{
  const width = 120;
  const height = 150;
  const stem = { x0: 26, x1: 34, y0: 20, y1: 120 };      // asta de 8 px
  const foot = { x0: 26, x1: 92, y0: 112, y1: 120 };     // travesano inferior
  const counter = { cx: 70, cy: 52, rx: 20, ry: 24, inner: 0.62 };
  const inside = (x, y) => {
    const inStem = x >= stem.x0 && x <= stem.x1 && y >= stem.y0 && y <= stem.y1;
    const inFoot = x >= foot.x0 && x <= foot.x1 && y >= foot.y0 && y <= foot.y1;
    const nx = (x - counter.cx) / counter.rx;
    const ny = (y - counter.cy) / counter.ry;
    const radial = nx * nx + ny * ny;
    const inRing = radial <= 1 && radial >= counter.inner * counter.inner;
    return inStem || inFoot || inRing;
  };

  const pixels = renderShape(width, height, inside);
  const { result } = trace(pixels, width, height, { detail: 2 });
  assert.ok(result, 'La forma tipografica debe vectorizarse.');

  const { subpaths, iou } = fidelity(result, width, height, inside);
  assert.ok(subpaths.length >= 2, 'El contrapunto del anillo debe conservarse como subtrazado propio.');
  // Umbral mas bajo que en el resto: esta forma es casi todo perimetro
  // (asta de 8 px y anillo de 7 px de grosor), asi que la misma desviacion de
  // borde pesa mucho mas en la razon de areas. El motor anterior daba 0.988.
  assert.ok(iou > 0.994, `Fidelidad insuficiente en la forma tipografica: IoU ${iou.toFixed(5)}.`);

  // Grosor del asta medido sobre el trazado: cruzar la asta a media altura y
  // comprobar que sigue midiendo 8 px. Un umbral sesgado la engorda o adelgaza.
  const row = 70;
  let entered = null;
  let exited = null;
  for (let x = 0; x < width * 8; x += 1) {
    const sample = x / 8;
    const solid = isInside(subpaths, sample, row);
    if (solid && entered === null) entered = sample;
    if (!solid && entered !== null && exited === null) exited = sample;
  }
  const measured = exited - entered;
  assert.ok(
    Math.abs(measured - 8) < 0.3,
    `El asta deberia medir 8 px y mide ${measured.toFixed(3)} px.`,
  );

  // Las esquinas exteriores del pie deben quedar vivas.
  const footCorners = [
    { x: foot.x1, y: foot.y0 },
    { x: foot.x1, y: foot.y1 },
    { x: stem.x0, y: stem.y0 },
  ];
  const worstGap = Math.max(...footCorners.map((corner) => distanceToContour(subpaths, corner)));
  assert.ok(worstGap < 0.4, `Esquina tipografica redondeada: ${worstGap.toFixed(3)} px de desvio.`);
  report('forma tipografica', `IoU ${iou.toFixed(5)}, asta ${measured.toFixed(2)} px, esquina peor ${worstGap.toFixed(3)} px`);
}

/* ------------------------------------------------------------------ *
 * 4. Logo opaco sobre fondo solido (antes caia a VTracer)
 * ------------------------------------------------------------------ */
{
  const width = 140;
  const height = 140;
  const inside = (x, y) => {
    const inBar = x >= 30 && x <= 110 && y >= 40 && y <= 58;
    const inPost = x >= 30 && x <= 48 && y >= 40 && y <= 104;
    return inBar || inPost;
  };
  const pixels = renderShape(width, height, inside, [20, 40, 90], [255, 255, 255]);

  const analysis = analyzeMonochromeLogo(pixels, width, height);
  assert.equal(analysis.eligible, true, 'Un logo plano sobre fondo solido ya no debe caer a VTracer.');
  assert.equal(analysis.mode, 'matte');

  const { result } = trace(pixels, width, height);
  assert.ok(result, 'El logo opaco debe vectorizarse.');
  const { subpaths, iou } = fidelity(result, width, height, inside);
  assert.ok(iou > 0.997, `Fidelidad insuficiente en modo mate: IoU ${iou.toFixed(5)}.`);

  const corners = [{ x: 110, y: 40 }, { x: 110, y: 58 }, { x: 48, y: 104 }, { x: 30, y: 40 }];
  const worstGap = Math.max(...corners.map((corner) => distanceToContour(subpaths, corner)));
  assert.ok(worstGap < 0.4, `Esquina redondeada en modo mate: ${worstGap.toFixed(3)} px.`);
  report('logo opaco (mate)', `IoU ${iou.toFixed(5)}, esquina peor ${worstGap.toFixed(3)} px, tinta ${analysis.fill}`);
}

/* ------------------------------------------------------------------ *
 * 5. Detalles pequenos: el punto de una i no puede desaparecer
 * ------------------------------------------------------------------ */
{
  const width = 90;
  const height = 90;
  const inside = (x, y) => {
    const inStem = x >= 42 && x <= 48 && y >= 34 && y <= 74;
    const dx = x - 45;
    const dy = y - 24;
    const inDot = dx * dx + dy * dy <= 3.2 * 3.2;
    return inStem || inDot;
  };
  const pixels = renderShape(width, height, inside);
  const { result } = trace(pixels, width, height);
  assert.ok(result, 'La i debe vectorizarse.');
  const { subpaths } = fidelity(result, width, height, inside);
  assert.ok(subpaths.length >= 2, 'El punto de la i se perdio: solo quedo un subtrazado.');
  assert.ok(isInside(subpaths, 45, 24), 'El centro del punto de la i deberia quedar relleno.');
  report('punto de la i', `${subpaths.length} subtrazados conservados`);
}

/* ------------------------------------------------------------------ *
 * 6. El remuestreo no debe desplazar la geometria
 * ------------------------------------------------------------------ */
{
  const width = 64;
  const height = 64;
  const inside = (x, y) => x >= 16 && x <= 48 && y >= 16 && y <= 48;
  const pixels = renderShape(width, height, inside);
  const plan = planWorkingSize(width, height, { target: 256, maxScale: 4 });
  assert.equal(plan.scale, 4, 'Las ampliaciones deben redondearse a factor entero.');
  const working = resampleRgba(pixels, width, height, plan.width, plan.height);
  assert.equal(working.width, 256);

  // Alfa opaco en el centro y transparente fuera: el nucleo no debe introducir
  // sobreimpulso que cruce el umbral donde no toca.
  const alphaAt = (x, y) => working.data[(y * working.width + x) * 4 + 3];
  assert.equal(alphaAt(128, 128), 255, 'El interior debe seguir siendo opaco.');
  assert.equal(alphaAt(8, 8), 0, 'El exterior debe seguir siendo transparente.');
  report('remuestreo', `${width}px -> ${plan.width}px a ${plan.scale}x sin sobreimpulso`);
}

/* ------------------------------------------------------------------ *
 * 7. Autocalibrado: un archivo con el borde duro no debe trazarse con la
 *    misma tolerancia que uno con antialias correcto
 * ------------------------------------------------------------------ */
{
  const width = 240;
  const height = 240;
  // Circulo girado respecto a la rejilla: si se umbraliza el alfa el borde
  // queda escalonado, que es lo que llega en muchos PNG reales exportados o
  // reescalados por el camino.
  const inside = (x, y) => Math.hypot(x - 120, y - 120) <= 92;
  const clean = renderShape(width, height, inside);
  const hard = Uint8ClampedArray.from(clean);
  for (let offset = 3; offset < hard.length; offset += 4) hard[offset] = hard[offset] >= 128 ? 255 : 0;

  // Con regularize a 0 para aislar el autocalibrado: si se deja activo, el
  // ajuste de formas convierte las dos variantes en un circulo exacto y la
  // prueba deja de medir lo que pretende.
  const cleanRun = trace(clean, width, height, { regularize: 0 }).result;
  const hardRun = trace(hard, width, height, { regularize: 0 }).result;

  assert.ok(cleanRun && hardRun, 'Ambas variantes deben vectorizarse.');
  assert.ok(
    hardRun.noiseRms > cleanRun.noiseRms * 1.6,
    `La sonda de ruido no distingue el borde duro (${hardRun.noiseRms.toFixed(4)}) del limpio (${cleanRun.noiseRms.toFixed(4)}).`,
  );
  assert.ok(
    hardRun.fitError > cleanRun.fitError * 1.2,
    'La tolerancia deberia aflojarse sola en el archivo ruidoso.',
  );
  // Lo que de verdad importa: sin autocalibrado el ajuste persigue la escalera
  // y devuelve muchisimos mas nodos para describir el mismo circulo.
  const naive = traceMonochromeLogo(hard, width, height, {
    detail: 1, smooth: true, regularize: 0, fitError: cleanRun.fitError, sigma: cleanRun.sigma,
  });
  assert.ok(
    hardRun.curveCount < naive.curveCount * 0.7,
    `El autocalibrado deberia recortar nodos: ${hardRun.curveCount} frente a ${naive.curveCount}.`,
  );
  report('autocalibrado', `ruido limpio ${cleanRun.noiseRms.toFixed(4)} px / duro ${hardRun.noiseRms.toFixed(4)} px, nodos ${naive.curveCount} -> ${hardRun.curveCount}`);
}

/* ------------------------------------------------------------------ *
 * 8. El perfil Simple tiene que ser distinto de Equilibrado
 * ------------------------------------------------------------------ */
{
  const width = 200;
  const height = 200;
  const inside = (x, y) => ((x - 100) / 70) ** 2 + ((y - 100) / 85) ** 2 <= 1;
  const pixels = renderShape(width, height, inside);
  const simple = trace(pixels, width, height, { detail: 0 }).result;
  const balanced = trace(pixels, width, height, { detail: 1 }).result;
  // `Number(settings.detail) || 1` convertia el 0 en 1, asi que Simple nunca
  // se aplicaba y los dos perfiles daban exactamente el mismo resultado.
  assert.ok(
    simple.fitError > balanced.fitError,
    `Simple deberia ser mas tolerante que Equilibrado (${simple.fitError.toFixed(3)} frente a ${balanced.fitError.toFixed(3)}).`,
  );
  report('perfiles', `Simple tol ${simple.fitError.toFixed(3)} / Equilibrado tol ${balanced.fitError.toFixed(3)}`);
}

/* ------------------------------------------------------------------ *
 * 9. Regularizacion: formas completas y fairing
 * ------------------------------------------------------------------ */
{
  // Un circulo debe salir como circulo exacto: cuatro cubicas, no un poligono
  // de cubicas con caras visibles. Es lo que se veia en el punto de las ies.
  const width = 160;
  const height = 160;
  const inside = (x, y) => Math.hypot(x - 80, y - 80) <= 26;
  const pixels = renderShape(width, height, inside);
  const shaped = trace(pixels, width, height).result;
  const plain = trace(pixels, width, height, { regularize: 0 }).result;

  assert.equal(shaped.shapeCount, 1, 'El circulo deberia reconocerse como forma completa.');
  assert.equal(shaped.curveCount, 4, `Un circulo exacto son 4 cubicas, salieron ${shaped.curveCount}.`);
  assert.ok(plain.shapeCount === 0, 'Con regularize a 0 no debe ajustarse ninguna forma.');

  const { subpaths, iou: shapedIou } = fidelity(shaped, width, height, inside);
  const { iou: plainIou } = fidelity(plain, width, height, inside);
  // Lo que hay que exigir no es una cifra absoluta -el sesgo residual de
  // extraccion, unos 0,03 px de radio, ya marca el suelo- sino que sustituir el
  // contorno por la forma exacta no empeore la fidelidad.
  assert.ok(
    shapedIou >= plainIou - 0.0005,
    `La forma exacta empeoro la fidelidad: ${shapedIou.toFixed(5)} frente a ${plainIou.toFixed(5)}.`,
  );

  // Y que sea redondo de verdad: el radio medido desde la caja envolvente debe
  // coincidir en los dos ejes.
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  subpaths[0].forEach((point) => {
    x0 = Math.min(x0, point.x); x1 = Math.max(x1, point.x);
    y0 = Math.min(y0, point.y); y1 = Math.max(y1, point.y);
  });
  assert.ok(Math.abs((x1 - x0) - (y1 - y0)) < 0.05, 'El circulo no salio redondo.');
  assert.ok(Math.abs((x1 - x0) / 2 - 26) < 0.1, `Radio ${(((x1 - x0) / 2)).toFixed(3)} px en lugar de 26.`);
  report('forma completa', `${shaped.curveCount} cúbicas frente a ${plain.curveCount}, radio ${((x1 - x0) / 2).toFixed(3)} de 26, IoU ${plainIou.toFixed(5)} → ${shapedIou.toFixed(5)}`);
}

{
  // Una elipse marcadamente alargada NO debe redondearse. El fairing con una
  // gaussiana lo hacia: atenuaba tambien la variacion legitima de curvatura.
  const width = 240;
  const height = 240;
  const rx = 100;
  const ry = 40;
  const inside = (x, y) => ((x - 120) / rx) ** 2 + ((y - 120) / ry) ** 2 <= 1;
  const pixels = renderShape(width, height, inside);
  const result = trace(pixels, width, height).result;
  const { subpaths, iou } = fidelity(result, width, height, inside);
  assert.equal(result.shapeCount, 1, 'La elipse deberia reconocerse como forma completa.');

  // La comprobacion que importa son los semiejes, no el IoU: si el alisado
  // atenuara la variacion de curvatura, el eje menor creceria y el mayor
  // encogeria hacia una circunferencia. El IoU no distingue bien eso, y ademas
  // ronda 0,997 incluso sin regularizar por el sesgo residual de extraccion.
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  subpaths[0].forEach((point) => {
    x0 = Math.min(x0, point.x); x1 = Math.max(x1, point.x);
    y0 = Math.min(y0, point.y); y1 = Math.max(y1, point.y);
  });
  const majorAxis = (x1 - x0) / 2;
  const minorAxis = (y1 - y0) / 2;
  assert.ok(Math.abs(majorAxis - rx) < 0.3, `Semieje mayor ${majorAxis.toFixed(3)} en lugar de ${rx}.`);
  assert.ok(Math.abs(minorAxis - ry) < 0.3, `Semieje menor ${minorAxis.toFixed(3)} en lugar de ${ry}.`);
  assert.ok(iou > 0.996, `Fidelidad insuficiente en la elipse alargada: IoU ${iou.toFixed(5)}.`);
  report('elipse alargada', `semiejes ${majorAxis.toFixed(2)} / ${minorAxis.toFixed(2)} de ${rx} / ${ry}, IoU ${iou.toFixed(5)}`);
}

/* ------------------------------------------------------------------ *
 * 11. Trazo fino: la regularizacion no puede engordarlo
 * ------------------------------------------------------------------ */
{
  // Texto de rotulo a tamano pequeno: astas de poco mas de dos pixeles. Es el
  // caso donde todas las operaciones con radio de accion se pasan de largo, si
  // ese radio no se limita al grosor de lo que se esta tocando: alisar mezcla
  // los dos lados del trazo a traves de su propio grosor.
  const width = 200;
  const height = 120;
  const stemWidth = 2.4;
  const stems = [30, 70, 110, 150];
  const inside = (x, y) => {
    if (y < 30 || y > 90) return false;
    return stems.some((center) => Math.abs(x - center) <= stemWidth / 2);
  };
  const pixels = renderShape(width, height, inside);

  const measureStem = (result, center) => {
    const subpaths = flattenPath(extractPathData(result.svg));
    let total = 0;
    for (let step = 0; step < 32 * 16; step += 1) {
      const x = center - 16 + step / 16;
      if (isInside(subpaths, x, 60)) total += 1 / 16;
    }
    return total;
  };

  const plain = trace(pixels, width, height, { regularize: 0 }).result;
  const regular = trace(pixels, width, height, { regularize: 1 }).result;
  const strong = trace(pixels, width, height, { regularize: 2 }).result;
  assert.ok(plain && regular && strong, 'Las astas finas deben vectorizarse.');

  const widths = [plain, regular, strong].map((run) => (
    stems.reduce((sum, center) => sum + measureStem(run, center), 0) / stems.length
  ));
  widths.forEach((measured, index) => {
    assert.ok(
      Math.abs(measured - stemWidth) < 0.22,
      `El asta de ${stemWidth} px mide ${measured.toFixed(3)} px con regularización ${[0, 1, 2][index]}.`,
    );
  });
  report('trazo fino', `${stemWidth} px → ${widths.map((value) => value.toFixed(2)).join(' / ')} px (reg 0 / 1 / 2)`);
}

/* ------------------------------------------------------------------ *
 * 12. Logo de dos tintas
 * ------------------------------------------------------------------ */
{
  // Un simbolo de color claro sobre un texto oscuro, ambos sobre blanco. Antes
  // el analisis tomaba el color de la tinta dominante y la clara quedaba a
  // media cobertura: en un logo real el simbolo desaparecia casi entero, y sin
  // aviso ninguno.
  const width = 220;
  const height = 220;
  const symbol = (x, y) => Math.hypot(x - 110, y - 70) <= 34;
  const bar = (x, y) => x >= 45 && x <= 175 && y >= 130 && y <= 156;
  const DARK = [18, 18, 20];
  const LIGHT = [140, 118, 151];

  const pixels = new Uint8ClampedArray(width * height * 4);
  const samples = 8;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let inSymbol = 0;
      let inBar = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (symbol(px, py)) inSymbol += 1;
          if (bar(px, py)) inBar += 1;
        }
      }
      const total = samples * samples;
      const a = inSymbol / total;
      const b = inBar / total;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = 255
          + a * (LIGHT[channel] - 255)
          + b * (DARK[channel] - 255);
      }
      pixels[offset + 3] = 255;
    }
  }

  const analysis = analyzeMonochromeLogo(pixels, width, height);
  assert.equal(analysis.eligible, true, 'Un logo de dos tintas planas debe ser elegible.');
  assert.equal(analysis.mode, 'multi', `Se esperaba modo multi y salió ${analysis.mode}.`);
  assert.equal(analysis.inks.length, 2, `Se esperaban 2 tintas y se detectaron ${analysis.inks.length}.`);

  const result = traceLogo(pixels, width, height, { detail: 1, smooth: true, analysis });
  assert.ok(result, 'El logo de dos tintas debe vectorizarse.');
  // El símbolo redondo sale como <circle>, no como <path>, así que se cuentan
  // los rellenos de cualquier elemento dibujable.
  const fills = [...result.svg.matchAll(/<(?:path|circle|ellipse)\b[^>]*fill="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.equal(fills.length, 2, `Se esperaban 2 objetos, uno por tinta, y salieron ${fills.length}.`);

  // Cada tinta debe salir con su color, no con el promedio de las dos.
  const near = (hex, rgb) => {
    const value = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    return Math.hypot(value[0] - rgb[0], value[1] - rgb[1], value[2] - rgb[2]) < 24;
  };
  assert.ok(fills.some((hex) => near(hex, DARK)), `Falta la tinta oscura. Salieron ${fills.join(', ')}.`);
  assert.ok(fills.some((hex) => near(hex, LIGHT)), `Falta la tinta clara. Salieron ${fills.join(', ')}.`);

  // Y el símbolo claro tiene que conservar su área: es lo que se perdía.
  const subpaths = flattenPath(extractPathData(result.svg));
  const symbolArea = Math.PI * 34 * 34;
  const traced = rasterize(subpaths, width, height, 3);
  let covered = 0;
  for (let index = 0; index < traced.mask.length; index += 1) if (traced.mask[index]) covered += 1;
  const totalArea = covered / 9;
  const expected = symbolArea + 130 * 26;
  assert.ok(
    Math.abs(totalArea - expected) / expected < 0.02,
    `Área total ${totalArea.toFixed(0)} frente a ${expected.toFixed(0)} esperada.`,
  );
  report('dos tintas', `${fills.join(' + ')}, área a ${(100 * Math.abs(totalArea - expected) / expected).toFixed(2)}%`);
}

/* ------------------------------------------------------------------ *
 * 13. Salida editable: un objeto por forma, con sus propios huecos
 * ------------------------------------------------------------------ */
{
  // Dos anillos separados y un disco. Antes salían los cinco contornos en un
  // único trazado compuesto, así que en Illustrator no se podía mover un anillo
  // sin soltar el compuesto, y al soltarlo los huecos pasaban a ser formas
  // rellenas encima.
  const width = 320;
  const height = 160;
  const ring = (x, y, cx) => {
    const r = Math.hypot(x - cx, y - 80);
    return r <= 44 && r >= 24;
  };
  const disc = (x, y) => Math.hypot(x - 265, y - 80) <= 26;
  const inside = (x, y) => ring(x, y, 60) || ring(x, y, 160) || disc(x, y);
  const pixels = renderShape(width, height, inside);
  const result = trace(pixels, width, height).result;
  assert.ok(result, 'La forma debe vectorizarse.');

  const drawable = [...result.svg.matchAll(/<(path|circle|ellipse)\b/g)].map((match) => match[1]);
  assert.equal(drawable.length, 3, `Se esperaban 3 objetos independientes y salieron ${drawable.length}.`);

  // Cada anillo tiene que llevarse su hueco dentro: dos subtrazados por objeto.
  const rings = [...result.svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)]
    .map((match) => (match[1].match(/M/g) || []).length);
  assert.deepEqual(rings.sort(), [2, 2], `Cada anillo debe ser un compuesto de 2 subtrazados, salieron ${rings}.`);

  // Y el disco, que no tiene huecos y es redondo, como elemento propio.
  assert.ok(
    drawable.includes('circle') || drawable.includes('ellipse'),
    'El disco deberia salir como <circle> o <ellipse>, no como trazado.',
  );

  const { iou } = fidelity(result, width, height, inside);
  assert.ok(iou > 0.995, `La reestructuracion cambio la geometria: IoU ${iou.toFixed(5)}.`);
  report('salida editable', `${drawable.length} objetos (${drawable.join(', ')}), IoU ${iou.toFixed(5)}`);
}

/* ------------------------------------------------------------------ *
 * 14. Lados rectos con vértices redondeados
 * ------------------------------------------------------------------ */
{
  // Un rectángulo redondeado no tiene ninguna esquina que detectar: sus
  // vértices son arcos. Sin buscar los tramos rectos aparte, todo su perímetro
  // -recto en más del 90%- se ajustaba como una curva continua.
  const width = 240;
  const height = 160;
  const box = { x0: 40, y0: 40, x1: 200, y1: 120 };
  const radius = 18;
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, box.x0 + radius), box.x1 - radius);
    const cy = Math.min(Math.max(y, box.y0 + radius), box.y1 - radius);
    if (x >= box.x0 && x <= box.x1 && y >= box.y0 + radius && y <= box.y1 - radius) return true;
    if (y >= box.y0 && y <= box.y1 && x >= box.x0 + radius && x <= box.x1 - radius) return true;
    return Math.hypot(x - cx, y - cy) <= radius;
  };
  const pixels = renderShape(width, height, inside);
  const result = trace(pixels, width, height).result;
  assert.ok(result, 'El rectángulo redondeado debe vectorizarse.');

  const data = extractPathData(result.svg);
  const lines = (data.match(/L/g) || []).length;
  const curves = (data.match(/C/g) || []).length;
  assert.ok(lines >= 4, `Los cuatro lados deberían ser rectas y sólo salieron ${lines}.`);
  assert.ok(curves <= 10, `Los vértices deberían ser 4 arcos cortos y salieron ${curves} curvas.`);

  // Y los lados tienen que estar donde toca, no cortados hacia dentro.
  const subpaths = flattenPath(data);
  let top = null;
  let bottom = null;
  for (let step = 0; step <= height * 16; step += 1) {
    const y = step / 16;
    if (isInside(subpaths, 120, y)) { if (top === null) top = y; bottom = y; }
  }
  assert.ok(Math.abs(top - box.y0) < 0.25, `Lado superior en ${top.toFixed(2)} en lugar de ${box.y0}.`);
  assert.ok(Math.abs(bottom - box.y1) < 0.25, `Lado inferior en ${bottom.toFixed(2)} en lugar de ${box.y1}.`);

  const { iou } = fidelity(result, width, height, inside);
  assert.ok(iou > 0.998, `Fidelidad insuficiente: IoU ${iou.toFixed(5)}.`);
  report('rectángulo redondeado', `${lines} rectas y ${curves} curvas, lados a ${Math.abs(top - box.y0).toFixed(2)} px, IoU ${iou.toFixed(5)}`);
}

console.log('Vectoria Logo: todas las pruebas de geometria pasan.');
console.log(results.join('\n'));
