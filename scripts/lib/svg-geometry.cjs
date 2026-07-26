'use strict';

// Utilidades de medida para las pruebas: aplanan el path del SVG resultante y
// permiten compararlo contra la forma original. Sin una metrica objetiva no hay
// forma de saber si un cambio en el trazador mejora o empeora el resultado.

const COMMAND = /([MLCZ])([^MLCZ]*)/gi;

function parseNumbers(chunk) {
  return (chunk.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
}

function flattenCubic(from, c1, c2, to, steps, out) {
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const mt = 1 - t;
    out.push({
      x: mt ** 3 * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * to.x,
      y: mt ** 3 * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * to.y,
    });
  }
}

// Devuelve los subtrazados como poligonos de puntos.
function flattenPath(d, steps = 24) {
  const subpaths = [];
  let current = null;
  let cursor = { x: 0, y: 0 };
  let match = COMMAND.exec(d);
  COMMAND.lastIndex = 0;
  while ((match = COMMAND.exec(d)) !== null) {
    const type = match[1].toUpperCase();
    const values = parseNumbers(match[2]);
    if (type === 'M') {
      current = [{ x: values[0], y: values[1] }];
      subpaths.push(current);
      cursor = { x: values[0], y: values[1] };
    } else if (type === 'L') {
      for (let index = 0; index + 1 < values.length; index += 2) {
        cursor = { x: values[index], y: values[index + 1] };
        current.push(cursor);
      }
    } else if (type === 'C') {
      for (let index = 0; index + 5 < values.length; index += 6) {
        const c1 = { x: values[index], y: values[index + 1] };
        const c2 = { x: values[index + 2], y: values[index + 3] };
        const to = { x: values[index + 4], y: values[index + 5] };
        flattenCubic(cursor, c1, c2, to, steps, current);
        cursor = to;
      }
    }
  }
  return subpaths.filter((subpath) => subpath.length >= 3);
}

// Regla par-impar sobre el conjunto completo de subtrazados, igual que hace el
// SVG con fill-rule="evenodd".
function isInside(subpaths, x, y) {
  let crossings = 0;
  subpaths.forEach((points) => {
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      if ((a.y > y) === (b.y > y)) continue;
      const crossX = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (crossX > x) crossings += 1;
    }
  });
  return crossings % 2 === 1;
}

// Rasterizado por linea de barrido con regla par-impar. Se muestrea por encima
// de la resolucion del pixel: a resolucion nativa la comparacion la domina el
// redondeo de los bordes y no mide lo que se quiere medir.
function rasterize(subpaths, width, height, samples = 1) {
  const gridWidth = width * samples;
  const gridHeight = height * samples;
  const mask = new Uint8Array(gridWidth * gridHeight);
  const edges = [];
  subpaths.forEach((points) => {
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      if (a.y === b.y) continue;
      edges.push(a.y < b.y ? { lowY: a.y, highY: b.y, x0: a.x, y0: a.y, dx: b.x - a.x, dy: b.y - a.y }
        : { lowY: b.y, highY: a.y, x0: a.x, y0: a.y, dx: b.x - a.x, dy: b.y - a.y });
    }
  });

  const crossings = [];
  for (let row = 0; row < gridHeight; row += 1) {
    const y = (row + 0.5) / samples;
    crossings.length = 0;
    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index];
      if (y < edge.lowY || y >= edge.highY) continue;
      crossings.push(edge.x0 + ((y - edge.y0) / edge.dy) * edge.dx);
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.max(0, Math.ceil(crossings[pair] * samples - 0.5));
      const to = Math.min(gridWidth - 1, Math.floor(crossings[pair + 1] * samples - 0.5));
      for (let column = from; column <= to; column += 1) mask[row * gridWidth + column] = 1;
    }
  }
  return { mask, width: gridWidth, height: gridHeight };
}

function sampleTruth(inside, width, height, samples = 1) {
  const gridWidth = width * samples;
  const gridHeight = height * samples;
  const mask = new Uint8Array(gridWidth * gridHeight);
  for (let row = 0; row < gridHeight; row += 1) {
    for (let column = 0; column < gridWidth; column += 1) {
      if (inside((column + 0.5) / samples, (row + 0.5) / samples)) mask[row * gridWidth + column] = 1;
    }
  }
  return { mask, width: gridWidth, height: gridHeight };
}

function intersectionOverUnion(first, second) {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < first.length; index += 1) {
    const a = first[index];
    const b = second[index];
    if (a && b) intersection += 1;
    if (a || b) union += 1;
  }
  return union ? intersection / union : 1;
}

// Distancia del vertice teorico al contorno trazado. En una esquina viva vale
// casi cero; si el trazador la redondeo con radio r, vale aproximadamente
// 0.41*r para un angulo recto. Es la medida directa de lo que antes fallaba.
function distanceToContour(subpaths, target) {
  let best = Infinity;
  subpaths.forEach((points) => {
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      let t = 0;
      if (lengthSquared > 1e-12) {
        t = ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSquared;
        t = Math.min(1, Math.max(0, t));
      }
      const distance = Math.hypot(a.x + t * dx - target.x, a.y + t * dy - target.y);
      if (distance < best) best = distance;
    }
  });
  return best;
}

// Suavidad: desviacion cuadratica media de la variacion de curvatura a lo
// largo del contorno.
//
// Hace falta junto a la fidelidad, no en su lugar. La fidelidad al raster
// premia reproducir los defectos del archivo de partida -si el borde viene
// escalonado, copiar la escalera puntua mejor que dibujar la curva-, asi que
// por si sola apunta en la direccion equivocada para un logo. Esta medida dice
// lo contrario: cuanto oscila el trazo. Entre las dos se puede decidir cuanta
// fidelidad conviene ceder.
//
// Se remuestrea a paso constante en longitud de arco antes de medir, porque si
// no el resultado cambia solo porque cambie el numero de nodos.
function curvatureRoughness(subpaths, step = 0.5) {
  let sum = 0;
  let count = 0;
  subpaths.forEach((points) => {
    const cumulative = [0];
    for (let index = 0; index < points.length; index += 1) {
      const next = points[(index + 1) % points.length];
      cumulative.push(cumulative[cumulative.length - 1]
        + Math.hypot(next.x - points[index].x, next.y - points[index].y));
    }
    const perimeter = cumulative[cumulative.length - 1];
    const samples = Math.round(perimeter / step);
    if (samples < 24) return;

    const walk = [];
    let edge = 0;
    for (let index = 0; index < samples; index += 1) {
      const distance = (index * perimeter) / samples;
      while (edge + 1 < points.length && cumulative[edge + 1] < distance) edge += 1;
      const next = (edge + 1) % points.length;
      const length = cumulative[edge + 1] - cumulative[edge];
      const amount = length > 1e-9 ? (distance - cumulative[edge]) / length : 0;
      walk.push({
        x: points[edge].x + (points[next].x - points[edge].x) * amount,
        y: points[edge].y + (points[next].y - points[edge].y) * amount,
      });
    }

    const curvature = [];
    for (let index = 0; index < walk.length; index += 1) {
      const previous = walk[(index - 1 + walk.length) % walk.length];
      const point = walk[index];
      const next = walk[(index + 1) % walk.length];
      const ax = point.x - previous.x;
      const ay = point.y - previous.y;
      const bx = next.x - point.x;
      const by = next.y - point.y;
      curvature.push(Math.atan2(ax * by - ay * bx, ax * bx + ay * by) / step);
    }
    for (let index = 0; index < curvature.length; index += 1) {
      const delta = curvature[(index + 1) % curvature.length] - curvature[index];
      sum += delta * delta;
      count += 1;
    }
  });
  return count ? Math.sqrt(sum / count) : 0;
}

function extractPathData(svg) {
  const match = svg.match(/\sd="([^"]+)"/);
  return match ? match[1] : '';
}

// Rasteriza una forma analitica con antialias real: 16x16 muestras por pixel
// dan una cobertura de area precisa, que es exactamente lo que produce un
// rasterizador de verdad y lo que el trazador tiene que saber invertir.
function renderShape(width, height, inside, color = [17, 17, 17], background = null) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const samples = 16;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          if (inside(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) covered += 1;
        }
      }
      const coverage = covered / (samples * samples);
      const offset = (y * width + x) * 4;
      if (background) {
        for (let channel = 0; channel < 3; channel += 1) {
          pixels[offset + channel] = background[channel] + (color[channel] - background[channel]) * coverage;
        }
        pixels[offset + 3] = 255;
      } else {
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = Math.round(coverage * 255);
      }
    }
  }
  return pixels;
}

module.exports = {
  flattenPath,
  rasterize,
  sampleTruth,
  intersectionOverUnion,
  curvatureRoughness,
  distanceToContour,
  extractPathData,
  renderShape,
  isInside,
};
