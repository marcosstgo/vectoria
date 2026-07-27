'use strict';

const EPSILON = 1e-9;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (point, amount) => ({ x: point.x * amount, y: point.y * amount });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const negate = (point) => ({ x: -point.x, y: -point.y });
const pointKey = (point) => `${Math.round(point.x * 10000)},${Math.round(point.y * 10000)}`;

function normalize(point) {
  const length = Math.hypot(point.x, point.y);
  return length > EPSILON ? scale(point, 1 / length) : { x: 0, y: 0 };
}

/* ------------------------------------------------------------------ *
 * Analisis de la imagen
 * ------------------------------------------------------------------ */

function colorStats(samples) {
  if (!samples.weight) return null;
  const means = samples.sum.map((value) => value / samples.weight);
  const deviations = samples.sumSquares.map((value, channel) => Math.sqrt(
    Math.max(0, value / samples.weight - means[channel] ** 2),
  ));
  return { means, deviation: Math.max(...deviations) };
}

function toHex(means) {
  return `#${means.map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

// Color de fondo estimado a partir del anillo exterior de la imagen. Se usa la
// mediana por canal para que un detalle que toque el borde no arrastre la
// estimacion.
function estimateBorderColor(pixels, width, height) {
  const band = Math.max(1, Math.round(Math.min(width, height) * 0.02));
  // En imagenes grandes el anillo puede tener cientos de miles de pixeles y
  // luego hay que ordenarlos; muestrear con paso constante da la misma mediana
  // a una fraccion del coste.
  const borderPixels = 2 * band * (width + height);
  const stride = Math.max(1, Math.floor(Math.sqrt(borderPixels / 40000)));
  const channels = [[], [], []];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const onBorder = x < band || y < band || x >= width - band || y >= height - band;
      if (!onBorder) continue;
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3] < 128) continue;
      for (let channel = 0; channel < 3; channel += 1) channels[channel].push(pixels[offset + channel]);
    }
  }
  if (!channels[0].length) return null;
  const median = [];
  const spread = [];
  channels.forEach((values) => {
    values.sort((a, b) => a - b);
    median.push(values[Math.floor(values.length / 2)]);
    const low = values[Math.floor(values.length * 0.05)];
    const high = values[Math.floor(values.length * 0.95)];
    spread.push(Math.abs(high - low));
  });
  return { color: median, spread: Math.max(...spread) };
}

function analyzeOpaqueLogo(pixels, width, height, base) {
  const border = estimateBorderColor(pixels, width, height);
  if (!border || border.spread > 26) return null;

  const background = border.color;
  const distances = new Float32Array(width * height);
  let maxDistance = 0;
  for (let index = 0; index < distances.length; index += 1) {
    const offset = index * 4;
    if (pixels[offset + 3] < 128) continue;
    const distance = Math.hypot(
      pixels[offset] - background[0],
      pixels[offset + 1] - background[1],
      pixels[offset + 2] - background[2],
    );
    distances[index] = distance;
    if (distance > maxDistance) maxDistance = distance;
  }
  // Un logo real separa claramente tinta y fondo. Si el contraste maximo es
  // bajo no hay nada que umbralizar con seguridad.
  if (maxDistance < 60) return null;

  const inkThreshold = maxDistance * 0.6;
  const samples = { sum: [0, 0, 0], sumSquares: [0, 0, 0], weight: 0 };
  let inkPixels = 0;
  for (let index = 0; index < distances.length; index += 1) {
    if (distances[index] < inkThreshold) continue;
    const offset = index * 4;
    inkPixels += 1;
    samples.weight += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = pixels[offset + channel];
      samples.sum[channel] += value;
      samples.sumSquares[channel] += value * value;
    }
  }
  const stats = colorStats(samples);
  if (!stats) return null;

  const coverage = inkPixels / (width * height);
  if (coverage <= 0.0005 || coverage >= 0.9) return null;

  const inks = clusterInks(pixels, width, height, background);
  // Con varias tintas la desviacion de color es alta por construccion, asi que
  // el filtro de monocromia solo se aplica cuando de verdad hay una sola.
  if (!inks || inks.length < 2) {
    if (stats.deviation >= 26) return null;
    return {
      ...base,
      eligible: true,
      mode: 'matte',
      fill: toHex(stats.means),
      background: toHex(background),
      backgroundRgb: background,
      inkRgb: stats.means,
      inks: [{ rgb: stats.means, hex: toHex(stats.means) }],
      inkCoverage: coverage,
      colorDeviation: stats.deviation,
    };
  }

  // Cada tinta por separado tiene que ser razonablemente plana; si una viene de
  // un degradado, esto no es un logo de tintas planas y mejor no tocarlo.
  if (Math.max(...inks.map((ink) => ink.spread)) > 26) return null;

  return {
    ...base,
    eligible: true,
    mode: 'multi',
    fill: inks[0].hex,
    background: toHex(background),
    backgroundRgb: background,
    inkRgb: inks[0].rgb,
    inks,
    inkCoverage: coverage,
    colorDeviation: stats.deviation,
  };
}

// Agrupa los pixeles de tinta por color para saber cuantas tintas hay.
//
// Un logo de dos tintas -un simbolo de un color y el texto de otro- pasaba
// antes por el analisis de una sola: se tomaba el color medio de los pixeles
// mas alejados del fondo, que son los de la tinta dominante, y la otra tinta
// quedaba a media cobertura. En un caso real el simbolo desaparecia casi
// entero, y sin ningun aviso, que es lo peor que puede hacer un conversor.
function clusterInks(pixels, width, height, background) {
  const total = width * height;
  const distance = new Float32Array(total);
  let maxDistance = 0;
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    if (pixels[offset + 3] < 128) continue;
    const value = Math.hypot(
      pixels[offset] - background[0],
      pixels[offset + 1] - background[1],
      pixels[offset + 2] - background[2],
    );
    distance[index] = value;
    if (value > maxDistance) maxDistance = value;
  }
  if (maxDistance < 60) return null;

  // Se necesita el interior de cada tinta, no sus bordes, porque un pixel de
  // borde es una mezcla de tinta y fondo y desplazaria los centros.
  //
  // Antes se seleccionaba por distancia al fondo superior a una fraccion del
  // maximo, y eso descarta enteras las tintas claras: en un logo con texto
  // negro y un simbolo lila, el lila queda por debajo del umbral que fija el
  // negro y el logo se analizaba como si fuera de una sola tinta. Erosionar la
  // mascara de tinta quita los bordes sin mirar el color.
  const ink = new Uint8Array(total);
  const minimumDistance = Math.max(40, maxDistance * 0.12);
  for (let index = 0; index < total; index += 1) ink[index] = distance[index] > minimumDistance ? 1 : 0;

  const core = [];
  const stride = Math.max(1, Math.floor(Math.sqrt(total / 60000)));
  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      const index = y * width + x;
      if (!ink[index]) continue;
      if (!ink[index - 1] || !ink[index + 1] || !ink[index - width] || !ink[index + width]) continue;
      const offset = index * 4;
      core.push({ r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2] });
    }
  }
  if (core.length < 40) return null;

  const distanceTo = (sample, centre) => Math.hypot(sample.r - centre[0], sample.g - centre[1], sample.b - centre[2]);

  const run = (k) => {
    // Siembra tipo k-means++: el primero al azar y cada siguiente lo mas lejos
    // posible de los ya elegidos, que es lo que separa tintas parecidas.
    const centres = [[core[0].r, core[0].g, core[0].b]];
    while (centres.length < k) {
      let best = null;
      let bestDistance = -1;
      core.forEach((sample) => {
        const nearest = Math.min(...centres.map((centre) => distanceTo(sample, centre)));
        if (nearest > bestDistance) { bestDistance = nearest; best = sample; }
      });
      centres.push([best.r, best.g, best.b]);
    }
    const assignment = new Int32Array(core.length);
    for (let iteration = 0; iteration < 24; iteration += 1) {
      let moved = false;
      core.forEach((sample, index) => {
        let bestIndex = 0;
        let bestDistance = Infinity;
        centres.forEach((centre, centreIndex) => {
          const distance = distanceTo(sample, centre);
          if (distance < bestDistance) { bestDistance = distance; bestIndex = centreIndex; }
        });
        if (assignment[index] !== bestIndex) { assignment[index] = bestIndex; moved = true; }
      });
      const sums = centres.map(() => [0, 0, 0, 0]);
      core.forEach((sample, index) => {
        const bucket = sums[assignment[index]];
        bucket[0] += sample.r; bucket[1] += sample.g; bucket[2] += sample.b; bucket[3] += 1;
      });
      sums.forEach((bucket, index) => {
        if (bucket[3]) centres[index] = [bucket[0] / bucket[3], bucket[1] / bucket[3], bucket[2] / bucket[3]];
      });
      if (!moved) break;
    }
    const counts = centres.map(() => 0);
    const squared = centres.map(() => 0);
    core.forEach((sample, index) => {
      counts[assignment[index]] += 1;
      const gap = distanceTo(sample, centres[assignment[index]]);
      squared[assignment[index]] += gap * gap;
    });
    // Dispersion de cada grupo, medida sobre el mismo nucleo erosionado que se
    // uso para agruparlos. Calcularla despues con un umbral global volvia a
    // dejar fuera la tinta clara y la daba por sucia.
    const spread = centres.map((_, index) => (counts[index] ? Math.sqrt(squared[index] / counts[index]) : Infinity));
    return { centres, counts, spread };
  };

  let chosen = run(1);
  for (let k = 2; k <= 3; k += 1) {
    const attempt = run(k);
    // Se acepta una tinta mas sólo si los grupos quedan lejos entre si y
    // ninguno es residual. Sin estas dos condiciones, cualquier degradado o
    // sombra se partiria en tintas inventadas.
    let minimumSeparation = Infinity;
    for (let i = 0; i < attempt.centres.length; i += 1) {
      for (let j = i + 1; j < attempt.centres.length; j += 1) {
        minimumSeparation = Math.min(minimumSeparation, Math.hypot(
          attempt.centres[i][0] - attempt.centres[j][0],
          attempt.centres[i][1] - attempt.centres[j][1],
          attempt.centres[i][2] - attempt.centres[j][2],
        ));
      }
    }
    const smallest = Math.min(...attempt.counts) / core.length;
    if (minimumSeparation > 70 && smallest > 0.06) chosen = attempt;
    else break;
  }

  const inks = chosen.centres.map((centre, index) => ({
    rgb: centre,
    hex: toHex(centre),
    share: chosen.counts[index] / core.length,
    spread: chosen.spread[index],
  }));
  // De oscura a clara, para que el orden de pintado sea estable.
  inks.sort((a, b) => (a.rgb[0] + a.rgb[1] + a.rgb[2]) - (b.rgb[0] + b.rgb[1] + b.rgb[2]));
  return inks;
}

function analyzeMonochromeLogo(pixels, width, height) {
  const pixelCount = width * height;
  let transparent = 0;
  let visible = 0;
  let weight = 0;
  const sum = [0, 0, 0];
  const sumSquares = [0, 0, 0];
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha < 16) transparent += 1;
    if (alpha < 24) continue;
    const alphaWeight = alpha / 255;
    visible += 1;
    weight += alphaWeight;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = pixels[offset + channel];
      sum[channel] += value * alphaWeight;
      sumSquares[channel] += value * value * alphaWeight;
    }
  }
  if (!visible || !weight) return { eligible: false, mode: 'none' };

  const stats = colorStats({ sum, sumSquares, weight });
  const transparentRatio = transparent / pixelCount;
  const coverage = visible / pixelCount;
  const base = {
    fill: toHex(stats.means),
    transparentRatio,
    coverage,
    colorDeviation: stats.deviation,
  };

  const alphaEligible = transparentRatio > 0.02
    && coverage > 0.001
    && coverage < 0.98
    && stats.deviation < 22;
  if (alphaEligible) return { ...base, eligible: true, mode: 'alpha' };

  // Sin transparencia util todavia puede ser un logo plano sobre fondo solido.
  // Antes estos archivos caian directos a VTracer, que es justo el peor motor
  // para tipografia; ahora se intenta extraer una mate.
  if (transparentRatio <= 0.35) {
    const matte = analyzeOpaqueLogo(pixels, width, height, base);
    if (matte) return matte;
  }

  return { ...base, eligible: false, mode: 'none' };
}

/* ------------------------------------------------------------------ *
 * Campo de cobertura
 * ------------------------------------------------------------------ */

// Devuelve la cobertura de tinta en [0,1] por pixel.
//
// En modo alfa el canal alfa ya es cobertura de area, asi que el umbral neutro
// es exactamente 0.5. En modo mate se proyecta el color sobre el eje que une
// fondo y tinta: proyectar, en vez de usar luminancia, elimina el sesgo que
// hacia engordar o adelgazar las astas segun el tono del logo.
function buildCoverageField(pixels, width, height, analysis, inkIndex = 0) {
  const field = new Float32Array(width * height);

  // Varias tintas: cada pixel se desmezcla contra el eje fondo-tinta que mejor
  // lo explica. Un pixel del borde entre el simbolo lila y el blanco es una
  // mezcla de esos dos, y proyectarlo sobre el eje del negro daria un valor
  // intermedio sin sentido; se elige el eje cuyo residuo es menor y sólo ese
  // recibe cobertura.
  if (analysis.mode === 'multi') {
    const background = analysis.backgroundRgb;
    const axes = analysis.inks.map((ink) => {
      const axis = [ink.rgb[0] - background[0], ink.rgb[1] - background[1], ink.rgb[2] - background[2]];
      return { axis, squared: axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2 };
    });
    for (let index = 0; index < field.length; index += 1) {
      const offset = index * 4;
      const alpha = pixels[offset + 3] / 255;
      if (alpha < 0.02) continue;
      const dr = pixels[offset] - background[0];
      const dg = pixels[offset + 1] - background[1];
      const db = pixels[offset + 2] - background[2];
      let bestIndex = -1;
      let bestResidual = Infinity;
      let bestAmount = 0;
      axes.forEach((entry, candidate) => {
        if (entry.squared < EPSILON) return;
        const amount = clamp((dr * entry.axis[0] + dg * entry.axis[1] + db * entry.axis[2]) / entry.squared, 0, 1);
        const residual = (dr - amount * entry.axis[0]) ** 2
          + (dg - amount * entry.axis[1]) ** 2
          + (db - amount * entry.axis[2]) ** 2;
        if (residual < bestResidual) { bestResidual = residual; bestIndex = candidate; bestAmount = amount; }
      });
      if (bestIndex === inkIndex) field[index] = bestAmount * alpha;
    }
    return field;
  }

  if (analysis.mode === 'matte') {
    const background = analysis.backgroundRgb;
    const ink = analysis.inkRgb;
    const axis = [ink[0] - background[0], ink[1] - background[1], ink[2] - background[2]];
    const squaredLength = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2;
    if (squaredLength < EPSILON) return field;
    for (let index = 0; index < field.length; index += 1) {
      const offset = index * 4;
      const alpha = pixels[offset + 3] / 255;
      const projection = (
        (pixels[offset] - background[0]) * axis[0]
        + (pixels[offset + 1] - background[1]) * axis[1]
        + (pixels[offset + 2] - background[2]) * axis[2]
      ) / squaredLength;
      field[index] = clamp(projection, 0, 1) * alpha;
    }
    return field;
  }

  for (let index = 0; index < field.length; index += 1) field[index] = pixels[index * 4 + 3] / 255;
  return field;
}

/* ------------------------------------------------------------------ *
 * Marching squares
 * ------------------------------------------------------------------ */

function interpolateEdge(a, b, threshold) {
  const denominator = b.value - a.value;
  const amount = Math.abs(denominator) < EPSILON ? 0.5 : clamp((threshold - a.value) / denominator, 0, 1);
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount };
}

function marchingSegments(field, width, height, threshold = 0.5) {
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  const grid = new Float32Array(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid[(y + 1) * paddedWidth + x + 1] = field[y * width + x];
  }
  const segments = [];
  for (let y = 0; y < paddedHeight - 1; y += 1) {
    for (let x = 0; x < paddedWidth - 1; x += 1) {
      const tl = { x: x - 0.5, y: y - 0.5, value: grid[y * paddedWidth + x] };
      const tr = { x: x + 0.5, y: y - 0.5, value: grid[y * paddedWidth + x + 1] };
      const br = { x: x + 0.5, y: y + 0.5, value: grid[(y + 1) * paddedWidth + x + 1] };
      const bl = { x: x - 0.5, y: y + 0.5, value: grid[(y + 1) * paddedWidth + x] };
      const code = (tl.value >= threshold ? 1 : 0) | (tr.value >= threshold ? 2 : 0)
        | (br.value >= threshold ? 4 : 0) | (bl.value >= threshold ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const top = () => interpolateEdge(tl, tr, threshold);
      const right = () => interpolateEdge(tr, br, threshold);
      const bottom = () => interpolateEdge(bl, br, threshold);
      const left = () => interpolateEdge(tl, bl, threshold);
      const push = (a, b) => segments.push([a, b]);
      const centerInside = (tl.value + tr.value + br.value + bl.value) / 4 >= threshold;
      switch (code) {
        case 1: push(left(), top()); break;
        case 2: push(top(), right()); break;
        case 3: push(left(), right()); break;
        case 4: push(right(), bottom()); break;
        case 5:
          if (centerInside) { push(top(), right()); push(bottom(), left()); }
          else { push(left(), top()); push(right(), bottom()); }
          break;
        case 6: push(top(), bottom()); break;
        case 7: push(left(), bottom()); break;
        case 8: push(bottom(), left()); break;
        case 9: push(top(), bottom()); break;
        case 10:
          if (centerInside) { push(left(), top()); push(right(), bottom()); }
          else { push(top(), right()); push(bottom(), left()); }
          break;
        case 11: push(right(), bottom()); break;
        case 12: push(left(), right()); break;
        case 13: push(top(), right()); break;
        case 14: push(left(), top()); break;
        default: break;
      }
    }
  }
  return segments;
}

// Enlaza los segmentos sueltos en contornos.
//
// Dos cambios frente a la version anterior: en un vertice con varias
// continuaciones posibles (celdas de silla) se elige la que mejor prolonga la
// direccion actual en lugar de la primera libre, y un contorno que no llega a
// cerrarse ya no se descarta en silencio, se cierra. Antes esos casos
// aparecian como trozos del logo que sencillamente faltaban.
function connectContours(segments) {
  const edges = segments.map(([a, b], index) => ({
    a, b, aKey: pointKey(a), bKey: pointKey(b), index,
  }));
  const adjacency = new Map();
  const addEdge = (key, edgeIndex) => {
    if (!adjacency.has(key)) adjacency.set(key, []);
    adjacency.get(key).push(edgeIndex);
  };
  edges.forEach((edge) => { addEdge(edge.aKey, edge.index); addEdge(edge.bKey, edge.index); });

  const used = new Uint8Array(edges.length);
  const contours = [];

  edges.forEach((startEdge) => {
    if (used[startEdge.index]) return;
    used[startEdge.index] = 1;
    const points = [startEdge.a, startEdge.b];
    const startKey = startEdge.aKey;
    let currentKey = startEdge.bKey;
    let heading = normalize(subtract(startEdge.b, startEdge.a));
    let guard = 0;

    while (currentKey !== startKey && guard <= edges.length) {
      const candidates = (adjacency.get(currentKey) || []).filter((index) => !used[index]);
      if (!candidates.length) break;
      let best = candidates[0];
      if (candidates.length > 1) {
        let bestScore = -Infinity;
        candidates.forEach((candidate) => {
          const edge = edges[candidate];
          const from = edge.aKey === currentKey ? edge.a : edge.b;
          const to = edge.aKey === currentKey ? edge.b : edge.a;
          const score = dot(heading, normalize(subtract(to, from)));
          if (score > bestScore) { bestScore = score; best = candidate; }
        });
      }
      used[best] = 1;
      const edge = edges[best];
      const next = edge.aKey === currentKey ? edge.b : edge.a;
      heading = normalize(subtract(next, points[points.length - 1]));
      points.push(next);
      currentKey = edge.aKey === currentKey ? edge.bKey : edge.aKey;
      guard += 1;
    }

    if (points.length < 5) return;
    if (currentKey === startKey) points.pop();
    contours.push(points);
  });

  return contours;
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return area / 2;
}

function resampleClosed(points, spacing = 0.75) {
  const cumulative = [0];
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    cumulative.push(cumulative[cumulative.length - 1]
      + Math.hypot(next.x - points[index].x, next.y - points[index].y));
  }
  const perimeter = cumulative[cumulative.length - 1];
  if (perimeter < EPSILON) return points.slice();
  const count = clamp(Math.round(perimeter / spacing), 8, 60000);
  const result = [];
  let edge = 0;
  for (let sample = 0; sample < count; sample += 1) {
    const distance = sample * perimeter / count;
    while (edge + 1 < points.length && cumulative[edge + 1] < distance) edge += 1;
    const nextIndex = (edge + 1) % points.length;
    const edgeLength = cumulative[edge + 1] - cumulative[edge];
    const amount = edgeLength > EPSILON ? (distance - cumulative[edge]) / edgeLength : 0;
    result.push({
      x: points[edge].x + (points[nextIndex].x - points[edge].x) * amount,
      y: points[edge].y + (points[nextIndex].y - points[edge].y) * amount,
    });
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Esquinas
 * ------------------------------------------------------------------ */

// Angulo de giro visto desde una distancia fija en longitud de arco.
// 0 = recta, PI/2 = esquina de 90 grados, cerca de PI = pico.
function cornerSharpness(points, index, radius) {
  const count = points.length;
  const step = radius % count;
  const back = normalize(subtract(points[(index - step + count) % count], points[index]));
  const forward = normalize(subtract(points[(index + step) % count], points[index]));
  const cosine = clamp(dot(back, forward), -1, 1);
  return Math.PI - Math.acos(cosine);
}

// Deteccion en dos escalas mas supresion de no-maximos.
//
// La escala corta localiza la esquina con precision; la larga confirma que hay
// un giro real y no ruido del borde. Sin la confirmacion, una curva muy cerrada
// -el contrapunto de una 'e', por ejemplo- se detectaria como esquina.
function detectCorners(points, options) {
  const count = points.length;
  const near = Math.max(2, Math.round(options.nearSupport));
  const far = Math.max(near + 1, Math.round(options.farSupport));
  if (count < far * 4) return [];

  const threshold = options.threshold;
  // Discriminante entre esquina y curva cerrada: sobre un arco de radio R el
  // giro medido crece de forma lineal con la distancia de observacion, asi que
  // al pasar de la escala corta a la larga se multiplica por far/near. En una
  // esquina el giro es el mismo se mire de cerca o de lejos. Comparar las dos
  // escalas por su cociente, y no por un umbral suelto, evita que el
  // contrapunto de una 'e' o el extremo de una elipse estrecha se tomen por
  // vertices y acaben partiendo una curva que deberia ser continua.
  const growthLimit = 1 + 0.45 * (far / near - 1);
  const strength = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const close = cornerSharpness(points, index, near);
    if (close < threshold) continue;
    const wide = cornerSharpness(points, index, far);
    if (wide < threshold * 0.5) continue;
    if (wide > close * growthLimit) continue;
    strength[index] = close;
  }

  const corners = [];
  for (let index = 0; index < count; index += 1) {
    if (!strength[index]) continue;
    let isPeak = true;
    for (let offset = -near; offset <= near && isPeak; offset += 1) {
      if (!offset) continue;
      const other = strength[(index + offset + count) % count];
      if (other > strength[index]) isPeak = false;
      else if (other === strength[index] && offset < 0) isPeak = false;
    }
    if (isPeak) corners.push(index);
  }
  return corners;
}

// Ajuste ortogonal (PCA) de una recta a una ventana de muestras.
function fitLine(points, indices) {
  let meanX = 0;
  let meanY = 0;
  indices.forEach((index) => { meanX += points[index].x; meanY += points[index].y; });
  meanX /= indices.length;
  meanY /= indices.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  indices.forEach((index) => {
    const dx = points[index].x - meanX;
    const dy = points[index].y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  });
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { point: { x: meanX, y: meanY }, direction: { x: Math.cos(theta), y: Math.sin(theta) } };
}

function intersectLines(first, second) {
  const denominator = first.direction.x * second.direction.y - first.direction.y * second.direction.x;
  if (Math.abs(denominator) < 1e-6) return null;
  const delta = subtract(second.point, first.point);
  const t = (delta.x * second.direction.y - delta.y * second.direction.x) / denominator;
  return add(first.point, scale(first.direction, t));
}

// El antialias redondea las esquinas del raster: el vertice real no cae en
// ninguna muestra, esta donde se cortarian los dos bordes si siguieran rectos.
// Aqui se ajusta una recta a cada lado, saltandose las muestras contaminadas
// junto al vertice, y se lleva la esquina a la interseccion. Ademas se
// proyectan sobre esas rectas las muestras intermedias, para que el ajuste
// posterior entre recto en el vertice en lugar de describir el arco.
function refineCorners(points, corners, options) {
  if (corners.length < 2) return points;
  const count = points.length;
  const result = points.slice();
  const gap = Math.max(1, Math.round(options.refineGap));
  const span = Math.max(3, Math.round(options.refineSpan));
  const maxShift = options.maxShift;

  corners.forEach((corner, position) => {
    const previous = corners[(position - 1 + corners.length) % corners.length];
    const next = corners[(position + 1) % corners.length];
    // Reparto adaptativo de la ventana. Cuando dos esquinas estan muy juntas
    // -el corte en angulo del terminal de una 'e', por ejemplo, que son dos
    // vertices separados por dos o tres pixeles- no cabe la ventana completa.
    // Antes eso hacia que se saltara el refinado y esos vertices se quedaban
    // sobre el arco redondeado del raster, que es justo donde se notaba.
    // Ahora se encoge el hueco y el tramo hasta lo que quepa.
    const room = (side) => Math.floor(side / 2);
    const window = (side) => {
      const available = room(side);
      if (available < 3) return null;
      const localGap = Math.max(1, Math.min(gap, available - 2));
      const localSpan = Math.min(span, available - localGap);
      return localSpan >= 2 ? { gap: localGap, span: localSpan } : null;
    };
    const backWindow = window((corner - previous + count) % count);
    const forwardWindow = window((next - corner + count) % count);
    if (!backWindow || !forwardWindow) return;

    const backIndices = [];
    for (let step = backWindow.gap; step <= backWindow.gap + backWindow.span; step += 1) {
      backIndices.push((corner - step + count) % count);
    }
    const forwardIndices = [];
    for (let step = forwardWindow.gap; step <= forwardWindow.gap + forwardWindow.span; step += 1) {
      forwardIndices.push((corner + step) % count);
    }

    const backLine = fitLine(points, backIndices);
    const forwardLine = fitLine(points, forwardIndices);
    const vertex = intersectLines(backLine, forwardLine);
    if (!vertex) return;
    if (Math.hypot(vertex.x - points[corner].x, vertex.y - points[corner].y) > maxShift) return;

    result[corner] = vertex;
    const project = (line, index) => {
      const relative = subtract(points[index], line.point);
      return add(line.point, scale(line.direction, dot(relative, line.direction)));
    };
    for (let step = 1; step < backWindow.gap; step += 1) {
      const back = (corner - step + count) % count;
      result[back] = project(backLine, back);
    }
    for (let step = 1; step < forwardWindow.gap; step += 1) {
      const forward = (corner + step) % count;
      result[forward] = project(forwardLine, forward);
    }
  });

  return result;
}

// Peso de suavizado por muestra: 0 en la esquina y rampa hasta 1. Antes el
// suavizado Laplaciano se aplicaba por igual a todo el contorno y redondeaba
// las esquinas antes incluso de llegar al ajuste de curvas.
function smoothingWeights(count, corners, radius) {
  const weights = new Float64Array(count).fill(1);
  if (!corners.length || radius < 1) return weights;
  const reach = Math.min(radius, Math.floor(count / 2) - 1);
  if (reach < 1) return weights;
  corners.forEach((corner) => {
    for (let offset = -reach; offset <= reach; offset += 1) {
      const index = (corner + offset + count) % count;
      const factor = Math.min(1, Math.abs(offset) / (reach + 1));
      weights[index] = Math.min(weights[index], factor);
    }
  });
  return weights;
}

// Suavizado gaussiano a lo largo del arco, con sigma expresado en pixeles de
// la imagen original.
//
// Antes se usaban pasadas Laplacianas fijas. El problema es que su alcance
// depende del espaciado de muestreo: con la imagen ampliada 4x las mismas tres
// pasadas suavizan una cuarta parte del recorrido real, asi que el resultado
// cambiaba segun la resolucion de trabajo. Una convolucion con sigma fisico da
// el mismo alisado sea cual sea la escala, y ademas se controla de una sola
// pasada en vez de iterando.
function smoothContour(points, sigmaSamples, weights) {
  const count = points.length;
  if (!(sigmaSamples > 0.05) || count < 5) return points;
  const radius = Math.min(Math.floor(count / 2) - 1, Math.max(1, Math.ceil(sigmaSamples * 3)));
  if (radius < 1) return points;

  const kernel = new Float64Array(radius * 2 + 1);
  let total = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const value = Math.exp(-(offset * offset) / (2 * sigmaSamples * sigmaSamples));
    kernel[offset + radius] = value;
    total += value;
  }
  for (let index = 0; index < kernel.length; index += 1) kernel[index] /= total;

  return points.map((point, index) => {
    const weight = weights ? weights[index] : 1;
    if (weight <= 0) return point;
    let x = 0;
    let y = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const sample = points[(index + offset + count) % count];
      const factor = kernel[offset + radius];
      x += sample.x * factor;
      y += sample.y * factor;
    }
    return {
      x: point.x + weight * (x - point.x),
      y: point.y + weight * (y - point.y),
    };
  });
}

// Ruido de extraccion del contorno, en unidades del espacio de trabajo.
//
// Una forma real no tiene detalle por debajo del pixel, asi que lo que queda a
// esa escala tras alisar es ruido de muestreo, no senal. Se mide como la
// desviacion cuadratica media entre el contorno y su version alisada,
// descartando el entorno de las esquinas, donde el residuo es grande pero es
// informacion legitima.
//
// Sirve para saber hasta donde se puede confiar en un archivo concreto. Un PNG
// exportado con antialias correcto ronda 0,02 px; uno con el borde casi duro,
// o reescalado por el camino, pasa de 0,07 px. Ajustar la tolerancia a ese
// numero es la diferencia entre seguir la curva o seguir la escalera de
// pixeles.
// Se usa un ajuste cuadratico local (Savitzky-Golay de orden 2) en lugar de un
// alisado gaussiano. La diferencia importa: un gaussiano desplaza el contorno
// en las zonas curvas una cantidad sigma^2 * curvatura / 2, que en un
// contrapunto de radio pequeno es del mismo orden que el ruido que se quiere
// medir. Una parabola absorbe la curvatura de forma exacta, asi que lo que
// queda en el residuo es solo el temblor de muestreo.
function contourNoise(points, corners, halfWindow, exclusion) {
  const count = points.length;
  const k = Math.max(2, Math.round(halfWindow));
  if (count < Math.max(16, k * 4)) return null;

  let s0 = 0;
  let s2 = 0;
  let s4 = 0;
  for (let t = -k; t <= k; t += 1) { s0 += 1; s2 += t * t; s4 += t * t * t * t; }
  const determinant = s0 * s4 - s2 * s2;
  if (Math.abs(determinant) < EPSILON) return null;

  const blocked = new Uint8Array(count);
  const reach = Math.min(exclusion, Math.floor(count / 2) - 1);
  corners.forEach((corner) => {
    for (let offset = -reach; offset <= reach; offset += 1) {
      blocked[(corner + offset + count) % count] = 1;
    }
  });

  let sum = 0;
  let used = 0;
  for (let index = 0; index < count; index += 1) {
    if (blocked[index]) continue;
    let sumX = 0; let sumY = 0; let sumT2X = 0; let sumT2Y = 0;
    for (let t = -k; t <= k; t += 1) {
      const point = points[(index + t + count) % count];
      sumX += point.x; sumY += point.y;
      sumT2X += t * t * point.x; sumT2Y += t * t * point.y;
    }
    const fitX = (s4 * sumX - s2 * sumT2X) / determinant;
    const fitY = (s4 * sumY - s2 * sumT2Y) / determinant;
    const dx = points[index].x - fitX;
    const dy = points[index].y - fitY;
    sum += dx * dx + dy * dy;
    used += 1;
  }
  return used >= 8 ? { squared: sum, samples: used } : null;
}

/* ------------------------------------------------------------------ *
 * Ajuste de Bezier
 * ------------------------------------------------------------------ */

function bezierPoint(curve, t) {
  const mt = 1 - t;
  return add(
    add(scale(curve[0], mt ** 3), scale(curve[1], 3 * t * mt ** 2)),
    add(scale(curve[2], 3 * t ** 2 * mt), scale(curve[3], t ** 3)),
  );
}

function bezierDerivative(curve, t) {
  const mt = 1 - t;
  return add(
    add(scale(subtract(curve[1], curve[0]), 3 * mt * mt), scale(subtract(curve[2], curve[1]), 6 * mt * t)),
    scale(subtract(curve[3], curve[2]), 3 * t * t),
  );
}

function bezierSecondDerivative(curve, t) {
  return add(
    scale(add(subtract(curve[2], scale(curve[1], 2)), curve[0]), 6 * (1 - t)),
    scale(add(subtract(curve[3], scale(curve[2], 2)), curve[1]), 6 * t),
  );
}

function chordParameters(points, first, last) {
  const parameters = [0];
  for (let index = first + 1; index <= last; index += 1) {
    parameters.push(parameters[parameters.length - 1]
      + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  }
  const total = parameters[parameters.length - 1];
  return total > EPSILON
    ? parameters.map((value) => value / total)
    : parameters.map((_, index) => index / (parameters.length - 1));
}

function generateBezier(points, first, last, parameters, leftTangent, rightTangent) {
  const start = points[first];
  const end = points[last];
  let c00 = 0; let c01 = 0; let c11 = 0; let x0 = 0; let x1 = 0;
  for (let index = 0; index <= last - first; index += 1) {
    const t = parameters[index];
    const mt = 1 - t;
    const b0 = mt ** 3; const b1 = 3 * t * mt ** 2; const b2 = 3 * t ** 2 * mt; const b3 = t ** 3;
    const a1 = scale(leftTangent, b1); const a2 = scale(rightTangent, b2);
    const difference = subtract(points[first + index], add(scale(start, b0 + b1), scale(end, b2 + b3)));
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
    x0 += dot(a1, difference); x1 += dot(a2, difference);
  }
  const determinant = c00 * c11 - c01 * c01;
  let alphaLeft = Math.abs(determinant) > EPSILON ? (x0 * c11 - x1 * c01) / determinant : 0;
  let alphaRight = Math.abs(determinant) > EPSILON ? (c00 * x1 - c01 * x0) / determinant : 0;
  const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (alphaLeft < segmentLength * 1e-3 || alphaRight < segmentLength * 1e-3) {
    alphaLeft = segmentLength / 3;
    alphaRight = segmentLength / 3;
  }
  return [start, add(start, scale(leftTangent, alphaLeft)), add(end, scale(rightTangent, alphaRight)), end];
}

function maximumError(points, first, last, curve, parameters) {
  let error = 0;
  let split = Math.floor((first + last) / 2);
  for (let index = first + 1; index < last; index += 1) {
    const difference = subtract(bezierPoint(curve, parameters[index - first]), points[index]);
    const distance = dot(difference, difference);
    if (distance > error) { error = distance; split = index; }
  }
  return { error, split };
}

function reparameterize(points, first, parameters, curve) {
  return parameters.map((parameter, index) => {
    const difference = subtract(bezierPoint(curve, parameter), points[first + index]);
    const derivative = bezierDerivative(curve, parameter);
    const denominator = dot(derivative, derivative) + dot(difference, bezierSecondDerivative(curve, parameter));
    return Math.abs(denominator) < EPSILON
      ? parameter
      : clamp(parameter - dot(difference, derivative) / denominator, 0, 1);
  });
}

function fitCubic(points, first, last, leftTangent, rightTangent, maxError, curves, depth = 0) {
  if (last - first === 1) {
    const distance = Math.hypot(points[last].x - points[first].x, points[last].y - points[first].y) / 3;
    curves.push({
      curve: [
        points[first],
        add(points[first], scale(leftTangent, distance)),
        add(points[last], scale(rightTangent, distance)),
        points[last],
      ],
      first,
      last,
    });
    return;
  }
  let parameters = chordParameters(points, first, last);
  let curve = generateBezier(points, first, last, parameters, leftTangent, rightTangent);
  let result = maximumError(points, first, last, curve, parameters);
  const squaredError = maxError * maxError;
  if (result.error <= squaredError) { curves.push({ curve, first, last }); return; }
  // Antes de partir conviene insistir en reparametrizar: una particion anade un
  // nodo permanente al resultado, mientras que reajustar los parametros suele
  // bajar el error sin coste. Con tolerancias estrictas la ventana original
  // (9x) hacia que el ajuste partiera curvas que si convergian.
  if (result.error <= squaredError * 36) {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      parameters = reparameterize(points, first, parameters, curve);
      curve = generateBezier(points, first, last, parameters, leftTangent, rightTangent);
      result = maximumError(points, first, last, curve, parameters);
      if (result.error <= squaredError) { curves.push({ curve, first, last }); return; }
    }
  }
  const split = depth > 32 || result.split <= first || result.split >= last
    ? Math.floor((first + last) / 2)
    : result.split;
  // Dentro de un tramo sin esquinas la continuidad suave en el corte es lo
  // correcto: la union no deberia notarse.
  const centerTangent = normalize(subtract(points[split - 1], points[split + 1]));
  fitCubic(points, first, split, leftTangent, centerTangent, maxError, curves, depth + 1);
  fitCubic(points, split, last, negate(centerTangent), rightTangent, maxError, curves, depth + 1);
}

// Ajusta una sola cubica al tramo y devuelve tambien su error, para poder
// decidir si merece la pena quedarse con ella.
function fitSingle(points, first, last, leftTangent, rightTangent) {
  let parameters = chordParameters(points, first, last);
  let curve = generateBezier(points, first, last, parameters, leftTangent, rightTangent);
  let result = maximumError(points, first, last, curve, parameters);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const nextParameters = reparameterize(points, first, parameters, curve);
    const nextCurve = generateBezier(points, first, last, nextParameters, leftTangent, rightTangent);
    const nextResult = maximumError(points, first, last, nextCurve, nextParameters);
    if (nextResult.error >= result.error) break;
    parameters = nextParameters;
    curve = nextCurve;
    result = nextResult;
  }
  return { curve, error: result.error };
}

function joinTangent(points, index, forward) {
  const previous = points[Math.max(0, index - 1)];
  const next = points[Math.min(points.length - 1, index + 1)];
  const direction = normalize(subtract(next, previous));
  return forward ? direction : negate(direction);
}

// Eliminacion de nodos.
//
// El ajuste recursivo parte por la mitad en cuanto el error se pasa, y nunca
// vuelve atras: cada particion deja un nodo permanente aunque despues resulte
// innecesario. Aqui se intenta borrar cada union y reajustar el tramo unido,
// aceptando el borrado solo si el error sigue dentro de tolerancia. En cada
// vuelta se elimina la union que menos error introduce.
function reduceKnots(points, pieces, leftTangent, rightTangent, maxError) {
  if (pieces.length < 2) return pieces;
  const squaredError = maxError * maxError;
  let list = pieces;
  // Cota de seguridad: cada vuelta quita como mucho un nodo, y sin ella una
  // curva con cientos de tramos costaria tiempo cubico.
  const rounds = Math.min(list.length, 200);

  for (let round = 0; round < rounds && list.length > 1; round += 1) {
    let bestIndex = -1;
    let bestFit = null;
    let bestError = Infinity;
    for (let index = 0; index + 1 < list.length; index += 1) {
      const start = list[index].first;
      const end = list[index + 1].last;
      const left = index === 0 ? leftTangent : joinTangent(points, start, true);
      const right = index + 2 === list.length ? rightTangent : joinTangent(points, end, false);
      const attempt = fitSingle(points, start, end, left, right);
      if (attempt.error <= squaredError && attempt.error < bestError) {
        bestError = attempt.error;
        bestIndex = index;
        bestFit = attempt.curve;
      }
    }
    if (bestIndex < 0) break;
    list = [
      ...list.slice(0, bestIndex),
      { curve: bestFit, first: list[bestIndex].first, last: list[bestIndex + 1].last },
      ...list.slice(bestIndex + 2),
    ];
  }
  return list;
}

function fitSpan(points, first, last, leftTangent, rightTangent, maxError) {
  const pieces = [];
  fitCubic(points, first, last, leftTangent, rightTangent, maxError, pieces);
  return reduceKnots(points, pieces, leftTangent, rightTangent, maxError).map((piece) => piece.curve);
}

// Direccion de salida en un extremo, promediada sobre unas pocas muestras para
// que el ruido del borde no incline la tangente.
function endTangent(segment, fromIndex, toIndex) {
  const available = Math.abs(toIndex - fromIndex);
  const span = Math.min(available, 4);
  if (span < 1) return { x: 0, y: 0 };
  const step = toIndex > fromIndex ? 1 : -1;
  let accumulated = { x: 0, y: 0 };
  for (let offset = 1; offset <= span; offset += 1) {
    const direction = normalize(subtract(segment[fromIndex + step * offset], segment[fromIndex]));
    accumulated = add(accumulated, scale(direction, 1 / offset));
  }
  return normalize(accumulated);
}

// Contorno cerrado sin esquinas detectadas: se abre por el punto de menor giro
// para que la costura sea invisible.
function fitSmoothClosedContour(points, maxError) {
  let seam = 0;
  let smallestTurn = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const incoming = normalize(subtract(points[index], points[(index - 1 + points.length) % points.length]));
    const outgoing = normalize(subtract(points[(index + 1) % points.length], points[index]));
    const turn = Math.abs(Math.atan2(
      incoming.x * outgoing.y - incoming.y * outgoing.x,
      dot(incoming, outgoing),
    ));
    if (turn < smallestTurn) { smallestTurn = turn; seam = index; }
  }
  const open = [...points.slice(seam), ...points.slice(0, seam), points[seam]];
  const tangent = normalize(subtract(open[1], open[open.length - 2]));
  return fitSpan(open, 0, open.length - 1, tangent, negate(tangent), maxError);
}

// Tramos del contorno que son rectos dentro de una tolerancia.
//
// Hace falta buscarlos aparte de las esquinas, porque una forma geometrica con
// los vertices redondeados -que es medio catalogo de logos- no tiene ninguna
// esquina que detectar: sus vertices son arcos, no discontinuidades. Sin
// esquinas, el contorno entero se ajustaba como una curva continua y sus lados
// rectos se disolvian dentro de ella. Medido sobre un simbolo real: el 99% de
// su perimetro era recto dentro de 0,25 px y salia casi todo como cubicas.
function detectStraightRuns(points, tolerance, minimumLength) {
  const count = points.length;
  // Ademas de una longitud minima absoluta, el tramo tiene que ser largo
  // respecto a su propio contorno.
  //
  // Sin la parte relativa, en una letra de trazo curvo aparecen decenas de
  // tramos cortos casi rectos y cada uno obliga a partir: la palabra del
  // logotipo salia troceada en secuencias de recta y curva alternadas, con mas
  // nodos que antes. Como el remuestreo es uniforme, un porcentaje de las
  // muestras es un porcentaje del perimetro.
  const minimumSamples = Math.max(minimumLength, Math.ceil(count * 0.06));
  if (count < minimumSamples * 2) return [];

  // Un tramo es recto si sus puntos quedan cerca de la cuerda Y ademas la
  // cuerda mide casi lo mismo que el arco.
  //
  // La segunda condicion no es redundante: en un trazo fino, el recorrido que
  // sube por un lado, da la vuelta al remate y baja por el otro tambien queda
  // cerca de su propia cuerda, y sin este control se aceptaba como recta y le
  // cortaba la punta al trazo. Se detecto porque un asta de 2,4 px pasaba a
  // medir 1,94.
  const straight = (from, to) => {
    const a = points[from % count];
    const b = points[to % count];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    if (chord < EPSILON) return false;
    let arc = 0;
    let worst = 0;
    for (let index = from; index <= to; index += 1) {
      const point = points[index % count];
      worst = Math.max(worst, Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / chord);
      if (worst > tolerance) return false;
      if (index > from) {
        const previous = points[(index - 1) % count];
        arc += Math.hypot(point.x - previous.x, point.y - previous.y);
      }
    }
    if (chord / arc <= 0.995) return false;

    // Y el giro neto entre los dos extremos tiene que ser casi nulo.
    //
    // La tolerancia por si sola no basta: un arco de circunferencia cumple la
    // distancia a la cuerda mientras la flecha quepa en el margen, y con esa
    // condicion admite hasta unos 16 grados de giro. El resultado era que una
    // circunferencia se troceaba en rectas. Una recta de verdad no gira, mida
    // lo que mida, asi que esta condicion no le afecta.
    const span = Math.max(2, Math.min(6, Math.floor((to - from) / 4)));
    const first = normalize(subtract(points[(from + span) % count], points[from % count]));
    const last = normalize(subtract(points[to % count], points[(to - span) % count]));
    const netTurn = Math.abs(Math.atan2(
      first.x * last.y - first.y * last.x,
      dot(first, last),
    ));
    return netTurn < 0.07;
  };

  // Se empieza a recorrer desde el punto de giro mas cerrado. Ese punto esta
  // dentro de un vertice redondeado, que es justo donde un tramo recto termina,
  // asi que el barrido no parte ningun tramo por la mitad.
  let seed = 0;
  let tightest = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count];
    const next = points[(index + 1) % count];
    const incoming = normalize(subtract(points[index], previous));
    const outgoing = normalize(subtract(next, points[index]));
    const turn = Math.abs(Math.atan2(
      incoming.x * outgoing.y - incoming.y * outgoing.x,
      dot(incoming, outgoing),
    ));
    if (turn > tightest) { tightest = turn; seed = index; }
  }

  const runs = [];
  let start = 0;
  while (start < count) {
    let end = start + 2;
    while (end < start + count && straight(seed + start, seed + end)) end += 1;
    end -= 1;
    if (end - start >= minimumSamples) {
      // Se recorta un poco cada extremo. Dos motivos: los ultimos puntos son
      // donde la rectitud estaba al limite, y sobre todo hay que dejar hueco
      // entre tramos consecutivos para la curva del vertice. Sin el recorte, un
      // tramo empezaba justo donde terminaba el anterior, el vertice se quedaba
      // sin muestras y las rectas se encadenaban cortandolo: el contrapunto de
      // una letra salio convertido en un triangulo.
      const trim = Math.min(3, Math.floor((end - start) / 8));
      const from = start + trim;
      const to = end - trim;
      if (to - from >= minimumSamples * 0.6) {
        runs.push({ from: (seed + from) % count, to: (seed + to) % count, length: to - from });
      }
    }
    start = end > start ? end + 1 : start + 1;
  }
  return runs;
}

// Con esquinas: el contorno se parte en tramos y cada tramo se ajusta con
// tangentes de un solo lado.
//
// Esta es la correccion central del trazador. Antes todos los cortes heredaban
// una tangente compartida, asi que el ajuste era literalmente incapaz de
// producir un vertice en punta: el apice de una 'A', el remate de una asta o
// una esquina de 90 grados salian siempre redondeados, hiciera lo que hiciera
// el control de error.
function fitContourWithCorners(points, corners, maxError) {
  if (corners.length < 2) return fitSmoothClosedContour(points, maxError);
  const count = points.length;
  const curves = [];
  for (let position = 0; position < corners.length; position += 1) {
    const start = corners[position];
    const end = corners[(position + 1) % corners.length];
    const length = (end - start + count) % count;
    if (length < 1) continue;
    const segment = [];
    for (let offset = 0; offset <= length; offset += 1) segment.push(points[(start + offset) % count]);
    const leftTangent = endTangent(segment, 0, segment.length - 1);
    const rightTangent = endTangent(segment, segment.length - 1, 0);
    fitSpan(segment, 0, segment.length - 1, leftTangent, rightTangent, maxError)
      .forEach((curve) => curves.push(curve));
  }
  return curves;
}

// Ajuste con tramos rectos explicitos.
//
// Cada tramo recto se emite como una recta exacta, y el hueco entre dos rectas
// -el vertice redondeado- se ajusta con curvas cuyas tangentes son las
// direcciones de esas dos rectas. Asi el arco entra y sale tangente a los
// lados, que es como se dibuja un vertice redondeado, y no hay que fiarlo a que
// el ajuste por minimos cuadrados acierte por su cuenta.
function fitContourWithLines(points, corners, runs, maxError) {
  const count = points.length;
  const curves = [];
  const cornerSet = new Set(corners);

  // La recta se ajusta a las muestras del tramo, no se traza entre sus dos
  // extremos.
  //
  // El tramo se extiende mientras la desviacion lo permita, asi que sus
  // extremos se meten un poco dentro del vertice, donde el contorno ya esta
  // girando. La cuerda entre esos dos puntos corta hacia dentro de la forma:
  // sobre un asta de 2,4 px la adelgazaba a 1,94. Un ajuste ortogonal sigue la
  // parte recta, que es la mayoria de las muestras, y despues se proyectan los
  // extremos sobre esa recta.
  const solved = runs.map((run) => {
    const indices = [];
    const span = (run.to - run.from + count) % count;
    for (let offset = 0; offset <= span; offset += 1) indices.push((run.from + offset) % count);
    let line = fitLine(points, indices);
    // Una pasada robusta: se descartan las muestras contaminadas del vertice y
    // se reajusta con las que de verdad son rectas.
    const clean = indices.filter((index) => {
      const relative = subtract(points[index], line.point);
      return Math.abs(relative.x * -line.direction.y + relative.y * line.direction.x) <= maxError * 0.6;
    });
    if (clean.length >= Math.max(6, indices.length * 0.5)) line = fitLine(points, clean);
    const project = (point) => {
      const relative = subtract(point, line.point);
      return add(line.point, scale(line.direction, dot(relative, line.direction)));
    };
    return { run, line, start: project(points[run.from]), end: project(points[run.to]) };
  });

  for (let index = 0; index < solved.length; index += 1) {
    const current = solved[index];
    const following = solved[(index + 1) % solved.length];
    const run = current.run;
    const next = following.run;
    const direction = (entry) => normalize(subtract(entry.end, entry.start));

    const start = current.start;
    const end = current.end;
    const third = scale(subtract(end, start), 1 / 3);
    curves.push([start, add(start, third), subtract(end, third), end]);

    // El hueco hasta la siguiente recta.
    const gap = (next.from - run.to + count) % count;
    if (gap < 1) {
      // Sin muestras entre las dos rectas no hay nada que ajustar, pero el
      // trazado tiene que seguir siendo continuo: se enlazan los extremos.
      const link = scale(subtract(following.start, current.end), 1 / 3);
      curves.push([current.end, add(current.end, link), subtract(following.start, link), following.start]);
      continue;
    }
    const segment = [];
    for (let offset = 0; offset <= gap; offset += 1) segment.push(points[(run.to + offset) % count]);
    // Los extremos del hueco son los puntos proyectados, para que la curva
    // arranque exactamente donde termina la recta.
    segment[0] = current.end;
    segment[segment.length - 1] = following.start;

    // Si hay una esquina viva dentro del hueco, se parte alli y cada mitad se
    // ajusta con tangente de un solo lado: un vertice en punta no puede quedar
    // sujeto a las tangentes de las rectas vecinas.
    const inside = [];
    for (let offset = 1; offset < gap; offset += 1) {
      if (cornerSet.has((run.to + offset) % count)) inside.push(offset);
    }
    // Giro entre las dos rectas. Cerca de 180 grados el hueco es un remate de
    // trazo: los dos lados vuelven sobre si mismos y sus direcciones ya no
    // sirven de tangente, porque obligarian a la curva a entrar y salir en el
    // mismo sentido. Se detecto porque un asta de 2,4 px salia con 1,94: la
    // curva cortaba por la punta.
    const before = direction(current);
    const after = direction(following);
    const turn = Math.abs(Math.atan2(
      before.x * after.y - before.y * after.x,
      dot(before, after),
    ));
    const hairpin = turn > (150 * Math.PI) / 180;

    const breaks = [0, ...inside, gap];
    for (let piece = 0; piece + 1 < breaks.length; piece += 1) {
      const from = breaks[piece];
      const to = breaks[piece + 1];
      if (to - from < 1) continue;
      const leftTangent = from === 0 && !hairpin ? before : endTangent(segment, from, to);
      const rightTangent = to === gap && !hairpin ? negate(after) : endTangent(segment, to, from);
      fitSpan(segment, from, to, leftTangent, rightTangent, maxError)
        .forEach((curve) => curves.push(curve));
    }
  }
  return curves;
}

/* ------------------------------------------------------------------ *
 * Regularizacion: apartarse del raster a proposito
 * ------------------------------------------------------------------ *
 *
 * Todo lo anterior persigue fidelidad al raster. Para un logo eso no es el
 * objetivo: nadie quiere una copia exacta de los artefactos de un PNG mal
 * exportado, quiere la forma que el disenador dibujo. Estas dos fases se
 * apartan del original de forma deliberada y controlada.
 */

// Fairing: se alisa la direccion de la tangente a lo largo del arco y se
// reconstruye el contorno integrandola de nuevo.
//
// Por que en el angulo y no en las posiciones: alisar posiciones encoge la
// figura, porque tira de cada punto hacia la cuerda de sus vecinos. Alisar el
// angulo de la tangente conserva la longitud de cada tramo y el giro total, de
// modo que la forma no encoge; lo unico que desaparece es la oscilacion de
// direccion, que es exactamente lo que el ojo lee como trazo abultado.
//
// Sobre una curva ya suave el operador no hace nada -si el angulo no oscila,
// alisarlo no lo cambia-, asi que un archivo limpio pasa practicamente intacto.
function fairSegment(points, sigmaSamples, budget) {
  const count = points.length;
  if (count < 6 || !(sigmaSamples > 0.05) || !(budget > 0)) return points;

  const lengths = [];
  const angles = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x;
    const dy = points[index + 1].y - points[index].y;
    lengths.push(Math.hypot(dx, dy));
    angles.push(Math.atan2(dy, dx));
  }
  // Desenrollado: sin esto, un salto de +PI a -PI se alisaria como un giro
  // enorme y destrozaria la reconstruccion.
  for (let index = 1; index < angles.length; index += 1) {
    let delta = angles[index] - angles[index - 1];
    while (delta > Math.PI) { angles[index] -= 2 * Math.PI; delta -= 2 * Math.PI; }
    while (delta < -Math.PI) { angles[index] += 2 * Math.PI; delta += 2 * Math.PI; }
  }

  // Se alisa con un ajuste cuadratico local (Savitzky-Golay de orden 2) y no
  // con una gaussiana. La diferencia no es cosmetica: una gaussiana atenua
  // TODA la variacion del angulo, incluida la que es legitima, de modo que
  // convierte las elipses en algo mas parecido a un circulo. Lo comprobe sobre
  // una elipse matematicamente perfecta y perdia fidelidad. Un ajuste
  // cuadratico reproduce exactamente el angulo cuya curvatura varia de forma
  // suave y solo elimina lo que oscila por encima de eso.
  const radius = Math.min(Math.floor((angles.length - 1) / 2), Math.max(2, Math.ceil(sigmaSamples * 2)));
  if (radius < 2) return points;
  let s0 = 0; let s2 = 0; let s4 = 0;
  for (let t = -radius; t <= radius; t += 1) { s0 += 1; s2 += t * t; s4 += t * t * t * t; }
  const denominator = s0 * s4 - s2 * s2;
  if (Math.abs(denominator) < EPSILON) return points;

  const smoothed = new Float64Array(angles.length);
  for (let index = 0; index < angles.length; index += 1) {
    let sum = 0;
    let sumT2 = 0;
    for (let t = -radius; t <= radius; t += 1) {
      // Reflejo en los extremos: el tramo es abierto y extenderlo de forma
      // periodica mezclaria los dos extremos, que no tienen relacion.
      let sample = index + t;
      if (sample < 0) sample = -sample;
      if (sample >= angles.length) sample = 2 * (angles.length - 1) - sample;
      const value = angles[clamp(sample, 0, angles.length - 1)];
      sum += value;
      sumT2 += t * t * value;
    }
    smoothed[index] = (s4 * sum - s2 * sumT2) / denominator;
  }

  const rebuilt = [points[0]];
  for (let index = 0; index < angles.length; index += 1) {
    const previous = rebuilt[index];
    rebuilt.push({
      x: previous.x + lengths[index] * Math.cos(smoothed[index]),
      y: previous.y + lengths[index] * Math.sin(smoothed[index]),
    });
  }

  // El extremo reconstruido no cae exactamente donde el original. El desfase se
  // reparte proporcionalmente a la longitud recorrida, de modo que los dos
  // extremos quedan clavados y las esquinas no se mueven.
  const drift = subtract(points[count - 1], rebuilt[count - 1]);
  let travelled = 0;
  const perimeter = lengths.reduce((sum, value) => sum + value, 0);
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const share = perimeter > EPSILON ? travelled / perimeter : 0;
    const corrected = add(rebuilt[index], scale(drift, share));
    // Presupuesto de infidelidad: por muy fea que sea la oscilacion, no nos
    // alejamos del raster mas de esta distancia.
    const offset = subtract(corrected, points[index]);
    const distance = Math.hypot(offset.x, offset.y);
    result.push(distance > budget ? add(points[index], scale(offset, budget / distance)) : corrected);
    if (index < lengths.length) travelled += lengths[index];
  }
  return result;
}

// Anchura local del trazo en cada muestra del contorno.
//
// Se busca, para cada punto, el punto mas cercano del propio contorno que este
// suficientemente lejos medido a lo largo del arco. En un trazo, ese punto es
// el de enfrente y la distancia es el grosor. La condicion sobre el arco es lo
// que evita que el vecino inmediato -que esta a un paso- gane siempre, y de
// paso descarta los remates, donde el punto de enfrente se alcanza dando la
// vuelta por la punta.
//
// Se usa un indice de rejilla porque comparar todos contra todos seria
// cuadratico y estos contornos llegan a varios miles de muestras.
function localWidths(points, minArcSeparation, searchRadius) {
  const count = points.length;
  const arc = new Float64Array(count);
  for (let index = 1; index < count; index += 1) {
    arc[index] = arc[index - 1]
      + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  const perimeter = arc[count - 1]
    + Math.hypot(points[0].x - points[count - 1].x, points[0].y - points[count - 1].y);

  const cell = Math.max(searchRadius / 2, 1e-3);
  const buckets = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  points.forEach((point, index) => {
    const cx = Math.floor(point.x / cell);
    const cy = Math.floor(point.y / cell);
    const id = key(cx, cy);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(index);
  });

  const widths = new Float64Array(count).fill(Infinity);
  const partners = new Int32Array(count).fill(-1);
  for (let index = 0; index < count; index += 1) {
    const point = points[index];
    const cx = Math.floor(point.x / cell);
    const cy = Math.floor(point.y / cell);
    let best = Infinity;
    let bestIndex = -1;
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const bucket = buckets.get(key(cx + ox, cy + oy));
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k += 1) {
          const other = bucket[k];
          const along = Math.abs(arc[other] - arc[index]);
          const separation = Math.min(along, perimeter - along);
          if (separation < minArcSeparation) continue;
          const distance = Math.hypot(points[other].x - point.x, points[other].y - point.y);
          if (distance < best) { best = distance; bestIndex = other; }
        }
      }
    }
    widths[index] = best;
    partners[index] = bestIndex;
  }
  return { widths, partners };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Lleva el grosor del trazo hacia un valor constante.
//
// En un logotipo con texto pequeno el asta mide dos pixeles y pico, y a ese
// tamano el raster no sostiene el grosor: ondula. Copiarlo fielmente reproduce
// la ondulacion. Aqui se mide el grosor a lo largo del contorno, se comprueba
// que la forma sea de verdad monolineal -si no lo es, no se toca nada- y se
// empuja cada punto por su normal hasta igualarlo.
//
// Se dejan fuera dos sitios donde el grosor es legitimamente distinto: los
// remates, donde no hay punto de enfrente, y las uniones entre trazos, donde
// hay mas tinta a proposito. Ambos se detectan porque su anchura se aparta
// mucho de la mediana.
function regularizeStrokeWidth(points, corners, thickness, strength, budget) {
  const count = points.length;
  if (count < 24 || !(strength > 0) || !(thickness > 0)) return points;

  // Primer filtro: la forma tiene que ser alargada. El cociente isoperimetrico
  // -perimetro al cuadrado partido por cuatro pi por el area- vale 1 en un
  // circulo, 1,27 en un cuadrado y crece con lo estirada que este la forma; un
  // trazo diez veces mas largo que ancho ronda 3.
  //
  // Sin este filtro el regularizador se aplicaba a formas macizas, donde la
  // "anchura" que mide es el tamano de la propia figura, y deformaba las
  // esquinas de un cuadrado en tres pixeles.
  const area = Math.abs(polygonArea(points));
  let perimeterLength = 0;
  for (let index = 0; index < count; index += 1) {
    const next = points[(index + 1) % count];
    perimeterLength += Math.hypot(next.x - points[index].x, next.y - points[index].y);
  }
  if (area < EPSILON) return points;
  const elongation = (perimeterLength * perimeterLength) / (4 * Math.PI * area);
  if (elongation < 3) return points;

  const { widths, partners } = localWidths(points, thickness * 2.2, thickness * 3.5);
  const usable = [];
  for (let index = 0; index < count; index += 1) {
    if (Number.isFinite(widths[index])) usable.push(widths[index]);
  }
  // Si mas de un tercio de las muestras no encuentra pareja, esto no es un
  // trazo: puede ser una mancha compacta o una forma con relleno.
  if (usable.length < count * 0.66) return points;

  const reference = median(usable);
  if (!(reference > 0)) return points;

  // El objetivo es LOCAL, no un grosor unico para todo el contorno.
  //
  // Forzar un grosor global rompe los diseños donde el grosor varia a
  // proposito: un anillo eliptico es mas ancho en un eje que en otro, y una
  // didona alterna asta gruesa y fina. Lo detecto el banco de pruebas, que
  // perdio fidelidad en el contrapunto de la letra al igualarlo.
  //
  // La distincion util es la misma que en el fairing: la variacion lenta es
  // diseño y hay que respetarla, la rapida es el raster que no sostiene el
  // trazo y hay que quitarla. Se alisa el perfil de anchuras a lo largo del
  // arco y cada punto se lleva hacia SU anchura alisada.
  const spacingAlong = perimeterLength / count;
  const blur = (window) => {
    const radius = Math.max(1, Math.round(window / spacingAlong));
    const result = new Float64Array(count).fill(NaN);
    for (let index = 0; index < count; index += 1) {
      let sum = 0;
      let weight = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sample = (index + offset + count) % count;
        const width = widths[sample];
        if (!Number.isFinite(width)) continue;
        if (width < reference * 0.6 || width > reference * 1.7) continue;
        const factor = 1 - Math.abs(offset) / (radius + 1);
        sum += width * factor;
        weight += factor;
      }
      if (weight > 0) result[index] = sum / weight;
    }
    return result;
  };

  // Se comparan dos escalas de alisado del mismo perfil de anchuras, no la
  // medida cruda contra su media.
  //
  // La medida cruda es un minimo sobre muestras discretas, asi que salta de una
  // muestra a otra. Corregir contra ella inyecta ese salto en la geometria: en
  // la prueba de la letra convirtio un contorno de seis rectas en uno de 151
  // puntos ondulados. Restando dos alisados el ruido de muestreo se cancela en
  // los dos terminos y solo queda la ondulacion de escala media, que es la que
  // hay que quitar.
  const narrow = blur(reference * 0.6);
  const wide = blur(reference * 3);

  // Zonas donde la medida de anchura vale: fuera quedan los remates, donde no
  // hay punto de enfrente, y las uniones entre trazos, donde hay mas tinta a
  // proposito.
  const valid = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const width = widths[index];
    valid[index] = Number.isFinite(width) && width >= reference * 0.65 && width <= reference * 1.5 ? 1 : 0;
  }
  // Las esquinas tampoco valen: alli el punto de enfrente esta en diagonal y la
  // anchura medida no significa nada.
  const guard = Math.max(2, Math.round(reference / spacingAlong));
  if (corners && corners.length) {
    corners.forEach((corner) => {
      for (let offset = -guard; offset <= guard; offset += 1) valid[(corner + offset + count) % count] = 0;
    });
  }
  // Erosion de la banda valida. Sin esto, las ventanas de alisado junto a una
  // zona excluida mezclan datos con huecos y generan una correccion que no
  // corresponde a ninguna ondulacion real: es lo que seguia torciendo los
  // bordes rectos de la prueba.
  const eroded = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    let ok = 1;
    for (let offset = -guard; offset <= guard && ok; offset += 1) {
      if (!valid[(index + offset + count) % count]) ok = 0;
    }
    eroded[index] = ok;
  }

  const correction = new Float64Array(count);
  const maximumShift = reference * 0.15;
  for (let index = 0; index < count; index += 1) {
    if (!eroded[index]) continue;
    if (!Number.isFinite(narrow[index]) || !Number.isFinite(wide[index])) continue;
    correction[index] = clamp((wide[index] - narrow[index]) / 2, -maximumShift, maximumShift);
  }

  // Se alisa la correccion a lo largo del arco: aplicarla en crudo introduciria
  // escalones justo en el borde de las zonas excluidas.
  const radius = Math.max(2, Math.round(thickness / (2 * (perimeterLength / count))));
  const smoothed = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    let sum = 0;
    let weight = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const sample = (index + offset + count) % count;
      const factor = 1 - Math.abs(offset) / (radius + 1);
      sum += correction[sample] * factor;
      weight += factor;
    }
    smoothed[index] = weight > 0 ? sum / weight : 0;
  }

  let applied = 0;
  for (let index = 0; index < count; index += 1) if (smoothed[index]) applied += 1;
  if (!applied) return points;
  regularizeStrokeWidth.lastApplied = applied / count;

  const orientation = polygonArea(points) >= 0 ? 1 : -1;
  return points.map((point, index) => {
    const shift = clamp(smoothed[index] * strength, -budget, budget);
    if (!shift) return point;
    const previous = points[(index - 1 + count) % count];
    const next = points[(index + 1) % count];
    const tangent = normalize(subtract(next, previous));
    // Normal hacia fuera del relleno, con el signo corregido por la
    // orientacion del contorno: un hueco recorre al reves que su exterior y sin
    // esto se adelgazaria justo donde hay que engordar.
    const normal = scale({ x: tangent.y, y: -tangent.x }, orientation);
    const partner = partners[index];
    if (partner >= 0) {
      // Si se puede, se usa la direccion real hacia la pareja: es mas fiable
      // que la normal cuando el contorno viene con algo de ruido.
      const towards = normalize(subtract(point, points[partner]));
      if (dot(towards, normal) > 0.2) return add(point, scale(towards, shift));
    }
    return add(point, scale(normal, shift));
  });
}

// Aplica el fairing por tramos entre esquinas, para no alisar nunca a traves de
// un vertice.
function fairContour(points, corners, sigmaSamples, budget) {
  const count = points.length;
  if (count < 8) return points;
  if (corners.length < 2) {
    const closed = [...points, points[0]];
    const faired = fairSegment(closed, sigmaSamples, budget);
    // En un contorno cerrado sin esquinas la costura es arbitraria: se promedia
    // el primer punto con el ultimo para que no quede un pliegue visible.
    const seam = {
      x: (faired[0].x + faired[faired.length - 1].x) / 2,
      y: (faired[0].y + faired[faired.length - 1].y) / 2,
    };
    const result = faired.slice(0, count);
    result[0] = seam;
    return result;
  }

  const result = points.slice();
  for (let position = 0; position < corners.length; position += 1) {
    const start = corners[position];
    const end = corners[(position + 1) % corners.length];
    const span = (end - start + count) % count;
    if (span < 6) continue;
    const segment = [];
    for (let offset = 0; offset <= span; offset += 1) segment.push(points[(start + offset) % count]);
    const faired = fairSegment(segment, sigmaSamples, budget);
    for (let offset = 1; offset < span; offset += 1) result[(start + offset) % count] = faired[offset];
  }
  return result;
}

// Ajuste de circunferencia por minimos cuadrados (Kasa). Lineal en
// (cx, cy, r^2 - cx^2 - cy^2), asi que sale de resolver un sistema 3x3.
function fitCircle(points) {
  let sumX = 0; let sumY = 0;
  points.forEach((point) => { sumX += point.x; sumY += point.y; });
  const meanX = sumX / points.length;
  const meanY = sumY / points.length;

  let suu = 0; let suv = 0; let svv = 0; let suuu = 0; let svvv = 0; let suvv = 0; let svuu = 0;
  points.forEach((point) => {
    const u = point.x - meanX;
    const v = point.y - meanY;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v;
    suvv += u * v * v; svuu += v * u * u;
  });
  const determinant = suu * svv - suv * suv;
  if (Math.abs(determinant) < EPSILON) return null;
  const bx = (suuu + suvv) / 2;
  const by = (svvv + svuu) / 2;
  const cu = (bx * svv - by * suv) / determinant;
  const cv = (suu * by - suv * bx) / determinant;
  const center = { x: cu + meanX, y: cv + meanY };
  let radius = Math.sqrt(Math.max(0, cu * cu + cv * cv + (suu + svv) / points.length));

  // Kasa minimiza la distancia algebraica, que sesga ligeramente el centro y el
  // radio. Unas pocas iteraciones geometricas quitan ese sesgo: el radio pasa a
  // ser la distancia media y el centro se reajusta con la media de las
  // direcciones radiales.
  for (let iteration = 0; iteration < 12; iteration += 1) {
    let sumDistance = 0;
    let sumUx = 0;
    let sumUy = 0;
    points.forEach((point) => {
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      const distance = Math.hypot(dx, dy);
      if (distance < EPSILON) return;
      sumDistance += distance;
      sumUx += dx / distance;
      sumUy += dy / distance;
    });
    const nextRadius = sumDistance / points.length;
    const nextCenter = {
      x: meanX + nextRadius * (sumUx / points.length),
      y: meanY + nextRadius * (sumUy / points.length),
    };
    const shift = Math.hypot(nextCenter.x - center.x, nextCenter.y - center.y)
      + Math.abs(nextRadius - radius);
    center.x = nextCenter.x;
    center.y = nextCenter.y;
    radius = nextRadius;
    if (shift < 1e-9) break;
  }

  let worst = 0;
  points.forEach((point) => {
    worst = Math.max(worst, Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - radius));
  });
  return { center, radiusX: radius, radiusY: radius, rotation: 0, deviation: worst };
}

// Elipse: centro y orientacion salen de los momentos de segundo orden del
// poligono; los semiejes se refinan con unas pocas iteraciones de Gauss-Newton
// sobre el residuo (x/a)^2 + (y/b)^2 - 1.
function fitEllipse(points) {
  let sumX = 0; let sumY = 0;
  points.forEach((point) => { sumX += point.x; sumY += point.y; });
  const center = { x: sumX / points.length, y: sumY / points.length };

  let mxx = 0; let myy = 0; let mxy = 0;
  points.forEach((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    mxx += dx * dx; myy += dy * dy; mxy += dx * dy;
  });
  mxx /= points.length; myy /= points.length; mxy /= points.length;
  const rotation = 0.5 * Math.atan2(2 * mxy, mxx - myy);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const local = points.map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos };
  });

  let a = Math.sqrt(2 * Math.max(mxx, myy)) || 1;
  let b = Math.sqrt(2 * Math.min(mxx, myy)) || 1;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    let jaa = 0; let jab = 0; let jbb = 0; let ra = 0; let rb = 0;
    local.forEach(({ u, v }) => {
      const residual = (u * u) / (a * a) + (v * v) / (b * b) - 1;
      const da = (-2 * u * u) / (a * a * a);
      const db = (-2 * v * v) / (b * b * b);
      jaa += da * da; jab += da * db; jbb += db * db;
      ra += da * residual; rb += db * residual;
    });
    const determinant = jaa * jbb - jab * jab;
    if (Math.abs(determinant) < EPSILON) break;
    const stepA = (ra * jbb - rb * jab) / determinant;
    const stepB = (jaa * rb - jab * ra) / determinant;
    a = Math.max(EPSILON, a - stepA);
    b = Math.max(EPSILON, b - stepB);
    if (Math.abs(stepA) + Math.abs(stepB) < 1e-7) break;
  }

  // Desviacion geometrica real, no algebraica: distancia radial al punto de la
  // elipse en la misma direccion angular.
  let worst = 0;
  local.forEach(({ u, v }) => {
    const angle = Math.atan2(v / b, u / a);
    const dx = u - a * Math.cos(angle);
    const dy = v - b * Math.sin(angle);
    worst = Math.max(worst, Math.hypot(dx, dy));
  });
  return { center, radiusX: a, radiusY: b, rotation, deviation: worst };
}

// Una elipse se representa exacta con cuatro cubicas usando el factor de
// Kappa; el error frente a la elipse verdadera es del orden del 0,02%, muy por
// debajo de cualquier tolerancia util, y baja el punto de una 'i' de siete u
// ocho nodos irregulares a cuatro perfectos.
const KAPPA = 0.5522847498307936;

function ellipseCurves(shape) {
  const cos = Math.cos(shape.rotation);
  const sin = Math.sin(shape.rotation);
  const map = (u, v) => ({
    x: shape.center.x + u * cos - v * sin,
    y: shape.center.y + u * sin + v * cos,
  });
  const a = shape.radiusX;
  const b = shape.radiusY;
  const ka = a * KAPPA;
  const kb = b * KAPPA;
  const anchors = [[a, 0], [0, b], [-a, 0], [0, -b]];
  const handles = [[[a, kb], [ka, b]], [[-ka, b], [-a, kb]], [[-a, -kb], [-ka, -b]], [[ka, -b], [a, -kb]]];
  const curves = [];
  for (let index = 0; index < 4; index += 1) {
    const start = anchors[index];
    const end = anchors[(index + 1) % 4];
    curves.push([
      map(start[0], start[1]),
      map(handles[index][0][0], handles[index][0][1]),
      map(handles[index][1][0], handles[index][1][1]),
      map(end[0], end[1]),
    ]);
  }
  return curves;
}

// Intenta reemplazar un contorno entero por una forma geometrica. Solo se
// acepta si el ajuste es claramente bueno, para no convertir en circulo algo
// que no lo era.
function fitWholeShape(points, corners, tolerance, relativeLimit, smallExtent) {
  if (points.length < 16) return null;
  // Cuantas esquinas se toleran antes de descartar el contorno.
  //
  // En una forma grande, tres o mas esquinas significan poligono y no hay nada
  // que redondear. Pero en una mancha de siete u ocho pixeles de radio el
  // detector encuentra esquinas falsas sin parar -uno de los puntos de las ies
  // de este logo daba siete-, porque a ese tamano el borde del raster es
  // demasiado grosero para juzgarlo. Por debajo de ese tamano se deja decidir a
  // la prueba de desviacion, que es mas fiable.
  const extent = Math.max(...points.map((point) => Math.abs(point.x - points[0].x)))
    + Math.max(...points.map((point) => Math.abs(point.y - points[0].y)));
  if (extent > smallExtent && corners.length > 2) return null;
  const circle = fitCircle(points);
  const ellipse = fitEllipse(points);
  const candidates = [circle, ellipse].filter(Boolean);
  if (!candidates.length) return null;

  candidates.forEach((shape) => {
    shape.size = Math.max(shape.radiusX, shape.radiusY);
    // El limite es relativo al tamano, y ademas depende de si la forma es
    // pequena o grande.
    //
    // En una mancha de pocos pixeles el raster no da para distinguir un circulo
    // de un poligono suave, asi que se admite bastante desviacion: medido sobre
    // un logo caligrafico real, los puntos de las ies se apartan un 13-14% del
    // circulo perfecto -son trazos a mano- mientras que los demas contornos
    // pequenos se apartan un 48% o mas. Ahi decidir a favor del circulo es
    // idealizar, que es lo que se pide.
    //
    // En una forma grande sobra informacion y hay que ser estricto. Con el
    // limite generoso, un rectangulo redondeado de 160x80 se aceptaba como
    // elipse y perdia sus cuatro lados rectos.
    const generous = shape.size * 2 <= smallExtent;
    shape.limit = generous
      ? Math.max(tolerance * 0.6, shape.size * relativeLimit)
      : Math.max(tolerance * 0.6, shape.size * 0.03);
  });

  const circleOk = circle && circle.deviation <= circle.limit;
  const ellipseOk = ellipse && ellipse.deviation <= ellipse.limit
    && ellipse.radiusX / Math.max(EPSILON, ellipse.radiusY) < 6
    && ellipse.radiusY / Math.max(EPSILON, ellipse.radiusX) < 6;

  // Seleccion de modelo, no orden de comprobacion. Probar la circunferencia
  // primero y aceptarla sin mirar la elipse convertia en circulo cualquier
  // elipse cuya excentricidad cupiera dentro del limite: con un contrapunto de
  // 20x24 el error de la circunferencia es de 2 px, por debajo del limite, y el
  // contrapunto salia redondo. Solo se prefiere el modelo simple cuando ademas
  // es casi tan bueno como el complejo.
  if (circleOk && (!ellipseOk || circle.deviation <= Math.max(ellipse.deviation * 1.3, circle.limit * 0.25))) {
    return { ...circle, kind: 'circle' };
  }
  if (ellipseOk) return { ...ellipse, kind: 'ellipse' };
  return null;
}

/* ------------------------------------------------------------------ *
 * Salida SVG
 * ------------------------------------------------------------------ */

function number(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

// Una cubica cuyos dos puntos de control caen sobre la cuerda describe un
// segmento recto. Emitirla como recta deja las astas perfectamente rectas en
// vez de con una curvatura residual, y permite fundir tramos colineales
// consecutivos en un solo comando.
function isStraight(curve, tolerance) {
  const axis = subtract(curve[3], curve[0]);
  const length = Math.hypot(axis.x, axis.y);
  if (length < EPSILON) return false;
  const unit = scale(axis, 1 / length);
  const normal = { x: -unit.y, y: unit.x };
  const controls = [curve[1], curve[2]];
  for (let index = 0; index < controls.length; index += 1) {
    const relative = subtract(controls[index], curve[0]);
    if (Math.abs(dot(relative, normal)) > tolerance) return false;
    const along = dot(relative, unit);
    if (along < -tolerance || along > length + tolerance) return false;
  }
  return true;
}

function buildCommands(curves, tolerance) {
  const commands = [];
  curves.forEach((curve) => {
    if (isStraight(curve, tolerance)) {
      const previous = commands[commands.length - 1];
      if (previous && previous.type === 'line') {
        const before = normalize(subtract(previous.to, previous.from));
        const after = normalize(subtract(curve[3], previous.from));
        if (dot(before, after) > 0.99995) {
          previous.to = curve[3];
          return;
        }
      }
      commands.push({ type: 'line', from: curve[0], to: curve[3] });
      return;
    }
    commands.push({ type: 'curve', c1: curve[1], c2: curve[2], to: curve[3] });
  });
  return commands;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Reparte los contornos en formas independientes, cada una con sus huecos.
//
// Sin esto, todos los contornos de una tinta acaban en un unico trazado
// compuesto: en un logotipo con simbolo y texto son treinta y tantos contornos
// en un solo objeto. Al abrirlo en Illustrator no se puede coger una letra y
// moverla; hay que soltar el trazado compuesto, y al soltarlo los contrapuntos
// dejan de ser huecos y se convierten en formas rellenas encima de la letra.
//
// La profundidad de anidamiento decide que es relleno y que es hueco: par es
// relleno -incluida una isla dentro de un hueco- e impar es hueco. Cada hueco
// se asigna al contorno que lo contiene mas de cerca.
function groupContours(entries) {
  const count = entries.length;
  const depth = new Int32Array(count);
  const parent = new Int32Array(count).fill(-1);

  for (let index = 0; index < count; index += 1) {
    // Cualquier vertice sirve de sonda: los contornos de marching squares no se
    // cruzan entre si, asi que un vertice de uno nunca cae sobre otro.
    const probe = entries[index].points[0];
    for (let other = 0; other < count; other += 1) {
      if (other === index) continue;
      if (pointInPolygon(probe, entries[other].points)) depth[index] += 1;
    }
  }

  for (let index = 0; index < count; index += 1) {
    const probe = entries[index].points[0];
    let best = -1;
    for (let other = 0; other < count; other += 1) {
      if (other === index) continue;
      if (!pointInPolygon(probe, entries[other].points)) continue;
      if (best < 0 || depth[other] > depth[best]) best = other;
    }
    parent[index] = best;
  }

  const groups = [];
  for (let index = 0; index < count; index += 1) {
    if (depth[index] % 2 !== 0) continue;
    const holes = [];
    for (let other = 0; other < count; other += 1) {
      if (depth[other] % 2 === 1 && parent[other] === index) holes.push(entries[other]);
    }
    groups.push({ outer: entries[index], holes });
  }
  return groups;
}

function shapeElement(shape, transform, fill) {
  // Una elipse solo puede salir como elemento propio si la escala es la misma
  // en los dos ejes; si no, deja de ser una elipse y hay que emitir el trazado.
  if (Math.abs(transform.x - transform.y) > 1e-6) return null;
  const scaleFactor = transform.x;
  const cx = number(shape.center.x * scaleFactor);
  const cy = number(shape.center.y * scaleFactor);
  const rx = shape.radiusX * scaleFactor;
  const ry = shape.radiusY * scaleFactor;
  if (shape.kind === 'circle') {
    return `<circle cx="${cx}" cy="${cy}" r="${number(rx)}" fill="${fill}"/>`;
  }
  const degrees = (shape.rotation * 180) / Math.PI;
  const rotation = Math.abs(degrees) > 0.05
    ? ` transform="rotate(${number(degrees)} ${cx} ${cy})"`
    : '';
  return `<ellipse cx="${cx}" cy="${cy}" rx="${number(rx)}" ry="${number(ry)}" fill="${fill}"${rotation}/>`;
}

function commandsToPath(commands, start, transform) {
  if (!commands.length) return '';
  const at = (point) => `${number(point.x * transform.x)} ${number(point.y * transform.y)}`;
  let path = `M${at(start)}`;
  commands.forEach((command) => {
    if (command.type === 'line') path += `L${at(command.to)}`;
    else path += `C${at(command.c1)} ${at(command.c2)} ${at(command.to)}`;
  });
  return `${path}Z`;
}

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

function traceMonochromeLogo(pixels, width, height, settings = {}) {
  const analysis = settings.analysis && settings.analysis.eligible
    ? settings.analysis
    : analyzeMonochromeLogo(pixels, width, height);
  if (!analysis.eligible) return null;

  // Ojo con `Number(x) || 1`: para detail = 0 (perfil Simple) el 0 es falsy y
  // el perfil se convertia silenciosamente en Equilibrado, asi que Simple nunca
  // llego a aplicarse.
  const requested = Number(settings.detail);
  const detail = Number.isFinite(requested) ? clamp(Math.round(requested), 0, 2) : 1;

  // Relacion entre el espacio de trabajo y el de salida. Si main.js amplio la
  // imagen 4x antes de trazar, transform vale 0.25 y toda tolerancia expresada
  // en pixeles de la imagen original se convierte dividiendo por ese factor.
  // Sin esta conversion, ampliar dispararia el numero de nodos en lugar de
  // mejorar la fidelidad.
  const output = settings.output && settings.output.width && settings.output.height
    ? settings.output
    : { width, height };
  const transform = { x: output.width / width, y: output.height / height };
  const factor = (transform.x + transform.y) / 2;
  const sourcePixel = 1 / factor;

  const threshold = clamp(Number(settings.threshold) || 0.5, 0.2, 0.8);
  const inkList = analysis.inks && analysis.inks.length ? analysis.inks : [{ hex: analysis.fill }];
  const inkIndex = clamp(Number(settings.inkIndex) || 0, 0, inkList.length - 1);
  const field = buildCoverageField(pixels, width, height, analysis, inkIndex);
  const rawContours = connectContours(marchingSegments(field, width, height, threshold));
  if (!rawContours.length) return null;

  const spacing = clamp(0.75 * Math.min(2, Math.max(1, sourcePixel / 2)), 0.6, 1.5);
  // Areas minimas expresadas en pixeles de la imagen original, para que el
  // supersampling no cambie que se conserva y que no. Antes eran absolutas en
  // el espacio de trabajo, asi que en imagenes pequenas se comian los puntos
  // de la i, las tildes y la puntuacion.
  const minimumArea = [3, 1.5, 0.5][detail] / (factor * factor);
  // Giro minimo, en radianes, para considerar que hay una esquina. Se puede
  // sobreescribir desde settings para calibrar contra un lote de logos reales;
  // un valor por encima de PI desactiva la deteccion, que es util para medir
  // cuanto aporta.
  const cornerThreshold = Number(settings.cornerThreshold) || [0.85, 0.7, 0.6][detail];

  const cornerOptions = {
    nearSupport: Math.max(2, (2.0 * sourcePixel) / spacing),
    farSupport: Math.max(4, (4.5 * sourcePixel) / spacing),
    threshold: cornerThreshold,
  };
  const refineOptions = {
    refineGap: Math.max(1, (1.4 * sourcePixel) / spacing),
    refineSpan: Math.max(3, (5.0 * sourcePixel) / spacing),
    maxShift: 3.0 * sourcePixel,
  };
  const smoothingRadius = Math.round((1.5 * sourcePixel) / spacing);

  // --- Fase 1: extraer, localizar esquinas y medir el ruido del archivo ---
  const prepared = [];
  let noiseSquared = 0;
  let noiseSamples = 0;
  // Ventana de 3 px de la imagen original. Con un alisado gaussiano una
  // ventana asi de ancha estaria dominada por la curvatura; el ajuste
  // cuadratico permite ensancharla, y hace falta ensancharla porque la escalera
  // de un borde mal antialiaseado tiene un periodo de aproximadamente un pixel:
  // con ventana corta pasa desapercibida.
  const probeWindow = (3.0 * sourcePixel) / spacing;
  const probeExclusion = Math.round((3.0 * sourcePixel) / spacing);

  rawContours.forEach((rawContour) => {
    if (Math.abs(polygonArea(rawContour)) < minimumArea) return;
    const contour = resampleClosed(rawContour, spacing);
    if (contour.length < 8) return;
    const corners = detectCorners(contour, cornerOptions);
    prepared.push({ contour, corners });
    const noise = contourNoise(contour, corners, probeWindow, probeExclusion);
    if (noise) { noiseSquared += noise.squared; noiseSamples += noise.samples; }
  });
  if (!prepared.length) return null;

  // Ruido en pixeles de la imagen original.
  const noiseRms = noiseSamples ? Math.sqrt(noiseSquared / noiseSamples) * factor : 0;
  // 0,038 px es lo que mide esta sonda en un PNG exportado con antialias
  // correcto; se toma como referencia de archivo limpio. Un logo con el borde
  // casi duro, o reescalado por el camino, llega a 0,10 px.
  const noiseFactor = clamp(noiseRms / 0.038, 1, 4);

  // Tolerancia de ajuste y alisado, en pixeles de la imagen original, escalados
  // por la calidad medida del archivo.
  //
  // Los valores anteriores (0,95 / 0,62 / 0,30) dejaban parar al ajuste con casi
  // un pixel de error. Pero fijarlos bajos sin mirar el archivo es igual de malo
  // por el otro extremo: en un PNG con el borde duro el ajuste deja de seguir la
  // curva y se pone a seguir la escalera de pixeles, lo que sube el parecido
  // medido y baja la calidad real. Calibrar contra el ruido evita los dos fallos
  // con un solo criterio.
  //
  // Ademas del escalado hay un suelo: la tolerancia nunca baja de 3,5 veces el
  // ruido medido, que es el orden de sus picos. Sin ese suelo el perfil Preciso
  // seguia persiguiendo la escalera en archivos ruidosos, porque su tolerancia
  // parte ya por debajo del ruido. En archivos limpios el suelo queda por
  // debajo de los tres perfiles y no interviene.
  const profileError = [0.5, 0.25, 0.14][detail] * (0.6 + 0.4 * noiseFactor);
  const fitError = (Number(settings.fitError)
    || Math.max(profileError, 3.5 * noiseRms)) / factor;
  const sigma = settings.smooth === false
    ? 0
    : (Number(settings.sigma) || [0.6, 0.4, 0.25][detail] * (0.35 + 0.65 * noiseFactor));
  const sigmaSamples = sigma / (spacing * factor);

  // Regularizacion: 0 respeta el raster tal cual, 1 es el valor por defecto,
  // valores mayores idealizan mas. Un logo escaneado quiere idealizar; un plano
  // tecnico, donde cada ondulacion puede ser real, no.
  const regularize = settings.regularize === undefined
    ? 1
    : clamp(Number(settings.regularize) || 0, 0, 2);
  const fairSigma = regularize * 2.2;
  const fairSigmaSamples = fairSigma / (spacing * factor);
  // El presupuesto se ata al ruido medido: en un archivo limpio no hay
  // oscilacion que quitar y apenas se mueve nada; en uno sucio se permite mas.
  const fairBudget = (regularize * Math.max(0.3, 7 * noiseRms)) / factor;
  const shapeTolerance = fitError * (1 + regularize);
  const shapeRelativeLimit = Math.min(0.3, 0.08 * (1 + regularize));

  const paths = [];
  let curveCount = 0;
  let cornerCount = 0;
  let shapeCount = 0;
  let strokeFixed = 0;
  let straightRuns = 0;

  // --- Fase 2: refinar, alisar, regularizar y ajustar ---
  prepared.forEach(({ corners, contour: extracted }) => {
    // Grosor caracteristico del contorno: para una forma alargada, el area
    // dividida entre el perimetro vale aproximadamente medio grosor de trazo.
    //
    // Hace falta porque todas las operaciones que siguen tienen un radio de
    // accion, y ese radio no puede ser el mismo en un asta de 26 px que en una
    // de 2 px. Sin este limite, alisar un asta fina mezcla los dos lados del
    // trazo a traves de su propio grosor: medido sobre un logotipo con texto
    // fino, la regularizacion engordaba las astas un 14%, y el refinado de
    // esquinas, con un margen de 3 px sobre un trazo de 2 px, sacaba picos.
    const perimeter = extracted.reduce((sum, point, index) => {
      const next = extracted[(index + 1) % extracted.length];
      return sum + Math.hypot(next.x - point.x, next.y - point.y);
    }, 0);
    const thickness = perimeter > EPSILON
      ? (2 * Math.abs(polygonArea(extracted))) / perimeter
      : Infinity;

    const localRefine = {
      ...refineOptions,
      maxShift: Math.min(refineOptions.maxShift, Math.max(0.4, thickness * 0.7)),
    };
    const localSigmaSamples = Math.min(sigmaSamples, (thickness * 0.35) / spacing);
    const localFairSamples = Math.min(fairSigmaSamples, (thickness * 0.3) / spacing);
    const localBudget = Math.min(fairBudget, thickness * 0.05);

    let contour = refineCorners(extracted, corners, localRefine);
    const weights = smoothingWeights(contour.length, corners, smoothingRadius);
    contour = smoothContour(contour, localSigmaSamples, weights);
    // Se repite el refinado: el suavizado ya no toca las esquinas, pero si
    // desplaza ligeramente las muestras vecinas que definen las dos rectas.
    if (corners.length >= 2) contour = refineCorners(contour, corners, localRefine);

    if (regularize > 0) {
      contour = fairContour(contour, corners, localFairSamples, localBudget);
      regularizeStrokeWidth.lastApplied = 0;
      contour = regularizeStrokeWidth(
        contour,
        corners,
        thickness,
        Math.min(1, regularize),
        thickness * 0.15,
      );
      if (regularizeStrokeWidth.lastApplied > 0) strokeFixed += 1;
      if (corners.length >= 2) contour = refineCorners(contour, corners, localRefine);
    }

    // Si el contorno entero es un circulo o una elipse, se emite como tal.
    const shape = regularize > 0
      ? fitWholeShape(contour, corners, shapeTolerance, shapeRelativeLimit, 40 * sourcePixel)
      : null;
    // Tramos rectos: tolerancia igual a la del ajuste, así que sólo entra lo
    // que de todas formas se iba a aproximar dentro de ese margen, y longitud
    // mínima de 4 px de la imagen original para no convertir en recta cualquier
    // temblor corto.
    const runs = shape ? [] : detectStraightRuns(
      contour,
      fitError,
      Math.max(6, Math.round((8 * sourcePixel) / spacing)),
    );
    const curves = shape
      ? ellipseCurves(shape)
      : (runs.length >= 2
        ? fitContourWithLines(contour, corners, runs, fitError)
        : fitContourWithCorners(contour, corners, fitError));
    if (runs.length >= 2) straightRuns += runs.length;
    if (shape) shapeCount += 1;
    if (!curves.length) return;
    const commands = buildCommands(curves, fitError * 0.8);
    const path = commandsToPath(commands, curves[0][0], transform);
    if (!path) return;

    curveCount += commands.length;
    cornerCount += corners.length;
    paths.push({ d: path, points: contour, shape });
  });

  if (!paths.length) return null;

  const fill = inkList[inkIndex].hex || analysis.fill;
  const groups = groupContours(paths);
  const elements = groups.map((group, index) => {
    // Un circulo o una elipse sin huecos sale como elemento propio: Illustrator
    // los abre como objetos elipse vivos, con sus tiradores de tamano, en vez
    // de como cuatro curvas sueltas.
    if (!group.holes.length && group.outer.shape) {
      const element = shapeElement(group.outer.shape, transform, fill);
      if (element) return element;
    }
    const data = [group.outer.d, ...group.holes.map((hole) => hole.d)].join('');
    const name = ` id="forma-${inkIndex + 1}-${index + 1}"`;
    return `<path${name} d="${data}" fill="${fill}" fill-rule="evenodd"/>`;
  });
  const pathMarkup = elements.length > 1
    ? `<g id="tinta-${inkIndex + 1}">${elements.join('')}</g>`
    : elements.join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${output.width}" height="${output.height}" viewBox="0 0 ${output.width} ${output.height}">${pathMarkup}</svg>`;

  const label = analysis.mode === 'multi'
    ? 'Cincel · varias tintas'
    : analysis.mode === 'matte'
      ? 'Cincel · mate sobre fondo sólido'
      : 'Cincel · contorno subpíxel';
  // La calidad del borde del archivo se informa en la interfaz: si sale
  // "borde duro", el limite no esta en el trazador sino en el PNG de partida,
  // y conviene conseguir el original en mayor resolucion.
  const quality = noiseFactor >= 2.2 ? 'borde duro' : noiseFactor >= 1.4 ? 'borde irregular' : 'borde limpio';

  const shapeNote = shapeCount
    ? ` · ${shapeCount} ${shapeCount === 1 ? 'forma exacta' : 'formas exactas'}`
    : '';

  return {
    svg,
    pathMarkup,
    fill,
    inkCount: inkList.length,
    engine: `${label} · ${cornerCount} esquinas${shapeNote} · ${quality}`,
    curveCount,
    contourCount: paths.length,
    cornerCount,
    shapeCount,
    strokeFixed,
    straightRuns,
    noiseRms,
    fitError: fitError * factor,
    sigma,
    regularize,
    analysis,
  };
}

// Traza el logo entero: una pasada por tinta, todas en el mismo SVG.
//
// Cada tinta se trata como un problema independiente de una sola tinta, que es
// lo que el motor sabe hacer bien. Funciona mientras las tintas no compartan
// borde; cuando lo comparten haria falta una topologia comun para que no
// queden ni huecos ni solapes en la costura, y eso queda pendiente.
function traceLogo(pixels, width, height, settings = {}) {
  const analysis = settings.analysis && settings.analysis.eligible
    ? settings.analysis
    : analyzeMonochromeLogo(pixels, width, height);
  if (!analysis.eligible) return null;

  const inks = analysis.inks && analysis.inks.length ? analysis.inks : [{ hex: analysis.fill }];
  if (inks.length < 2) return traceMonochromeLogo(pixels, width, height, { ...settings, analysis });

  const layers = [];
  const totals = {
    curveCount: 0, contourCount: 0, cornerCount: 0, shapeCount: 0, strokeFixed: 0, noiseRms: 0,
  };
  inks.forEach((ink, index) => {
    const layer = traceMonochromeLogo(pixels, width, height, { ...settings, analysis, inkIndex: index });
    if (!layer) return;
    layers.push(layer);
    totals.curveCount += layer.curveCount;
    totals.contourCount += layer.contourCount;
    totals.cornerCount += layer.cornerCount;
    totals.shapeCount += layer.shapeCount;
    totals.strokeFixed += layer.strokeFixed;
    totals.noiseRms = Math.max(totals.noiseRms, layer.noiseRms);
  });
  if (!layers.length) return null;

  const output = settings.output && settings.output.width && settings.output.height
    ? settings.output
    : { width, height };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${output.width}" height="${output.height}" viewBox="0 0 ${output.width} ${output.height}">${layers.map((layer) => layer.pathMarkup).join('')}</svg>`;

  return {
    ...totals,
    svg,
    inkCount: inks.length,
    inks: inks.map((ink) => ink.hex),
    engine: `Cincel · ${layers.length} tintas · ${totals.cornerCount} esquinas`,
    analysis,
  };
}

module.exports = {
  analyzeMonochromeLogo,
  traceMonochromeLogo,
  traceLogo,
  clusterInks,
  buildCoverageField,
  marchingSegments,
  connectContours,
  resampleClosed,
  detectCorners,
  detectStraightRuns,
  refineCorners,
  fitContourWithCorners,
};
