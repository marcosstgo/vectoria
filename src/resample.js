'use strict';

// Remuestreo separable de alta calidad para buffers RGBA.
//
// Por que existe este modulo: el trazador reconstruye el borde a partir del
// campo de cobertura del raster. Si ese raster llega a resolucion nativa, el
// antialias del borde ocupa un solo pixel y las astas finas, los remates y los
// contrapuntos de la tipografia quedan cuantizados a nivel de pixel. Ampliando
// con un nucleo de reconstruccion decente antes de extraer el contorno, el
// borde pasa a describirse con varios pixeles y la posicion subpixel del cruce
// se vuelve mucho mas estable.
//
// Ampliar y reducir piden nucleos distintos:
//   - Ampliar usa Mitchell-Netravali (B=C=1/3). Tiene muy poco ringing, lo que
//     importa aqui porque un sobreimpulso cerca de un borde duro puede crear
//     cruces de umbral falsos en detalles de un pixel.
//   - Reducir usa Lanczos-3, que conserva mejor el detalle al promediar.
//
// El alfa se maneja premultiplicado: un pixel totalmente transparente suele
// llevar color basura, y sin premultiplicar ese color sangra al borde visible.

const MITCHELL_RADIUS = 2;
const LANCZOS_RADIUS = 3;

function mitchell(x) {
  const b = 1 / 3;
  const c = 1 / 3;
  const t = Math.abs(x);
  const t2 = t * t;
  const t3 = t2 * t;
  if (t < 1) {
    return ((12 - 9 * b - 6 * c) * t3 + (-18 + 12 * b + 6 * c) * t2 + (6 - 2 * b)) / 6;
  }
  if (t < 2) {
    return ((-b - 6 * c) * t3 + (6 * b + 30 * c) * t2 + (-12 * b - 48 * c) * t + (8 * b + 24 * c)) / 6;
  }
  return 0;
}

function lanczos3(x) {
  const t = Math.abs(x);
  if (t < 1e-8) return 1;
  if (t >= LANCZOS_RADIUS) return 0;
  const pix = Math.PI * t;
  return (LANCZOS_RADIUS * Math.sin(pix) * Math.sin(pix / LANCZOS_RADIUS)) / (pix * pix);
}

// Precalcula, para cada muestra de destino, el rango de origen y sus pesos
// normalizados. Se reutiliza en todas las filas o columnas del eje.
function buildWeights(sourceLength, targetLength) {
  const ratio = sourceLength / targetLength;
  const downscaling = ratio > 1;
  const kernel = downscaling ? lanczos3 : mitchell;
  const radius = downscaling ? LANCZOS_RADIUS : MITCHELL_RADIUS;
  const filterScale = downscaling ? ratio : 1;
  const support = radius * filterScale;
  const plan = [];

  for (let index = 0; index < targetLength; index += 1) {
    const center = (index + 0.5) * ratio;
    const start = Math.max(0, Math.floor(center - support + 0.5));
    const end = Math.min(sourceLength - 1, Math.ceil(center + support - 0.5));
    const weights = new Float64Array(Math.max(1, end - start + 1));
    let total = 0;
    for (let sample = start; sample <= end; sample += 1) {
      const weight = kernel((sample + 0.5 - center) / filterScale);
      weights[sample - start] = weight;
      total += weight;
    }
    if (Math.abs(total) < 1e-12) {
      weights.fill(0);
      weights[0] = 1;
      total = 1;
    }
    for (let i = 0; i < weights.length; i += 1) weights[i] /= total;
    plan.push({ start, weights });
  }
  return plan;
}

function resampleRgba(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return { data: Uint8ClampedArray.from(source), width: sourceWidth, height: sourceHeight };
  }

  const horizontal = buildWeights(sourceWidth, targetWidth);
  const rows = new Float32Array(targetWidth * sourceHeight * 4);

  for (let y = 0; y < sourceHeight; y += 1) {
    const sourceRow = y * sourceWidth * 4;
    const targetRow = y * targetWidth * 4;
    for (let x = 0; x < targetWidth; x += 1) {
      const { start, weights } = horizontal[x];
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const weight = weights[k];
        if (weight === 0) continue;
        const offset = sourceRow + (start + k) * 4;
        const pixelAlpha = source[offset + 3] / 255;
        const premultiplied = pixelAlpha * weight;
        red += source[offset] * premultiplied;
        green += source[offset + 1] * premultiplied;
        blue += source[offset + 2] * premultiplied;
        alpha += premultiplied;
      }
      const target = targetRow + x * 4;
      rows[target] = red;
      rows[target + 1] = green;
      rows[target + 2] = blue;
      rows[target + 3] = alpha;
    }
  }

  const vertical = buildWeights(sourceHeight, targetHeight);
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    const { start, weights } = vertical[y];
    for (let x = 0; x < targetWidth; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const weight = weights[k];
        if (weight === 0) continue;
        const offset = ((start + k) * targetWidth + x) * 4;
        red += rows[offset] * weight;
        green += rows[offset + 1] * weight;
        blue += rows[offset + 2] * weight;
        alpha += rows[offset + 3] * weight;
      }
      const target = (y * targetWidth + x) * 4;
      const solved = Math.min(1, Math.max(0, alpha));
      output[target + 3] = Math.round(solved * 255);
      if (solved > 1e-4) {
        output[target] = red / solved;
        output[target + 1] = green / solved;
        output[target + 2] = blue / solved;
      }
    }
  }

  return { data: output, width: targetWidth, height: targetHeight };
}

// Decide a que resolucion conviene trabajar. Las ampliaciones se redondean a
// factor entero: sobre bordes alineados a los ejes un factor entero no
// introduce fase fraccionaria, asi que los bordes rectos siguen siendo rectos.
function planWorkingSize(width, height, options = {}) {
  const target = options.target || 1800;
  const maxScale = options.maxScale === undefined ? 4 : options.maxScale;
  const maxLongEdge = options.maxLongEdge || 3200;
  const maxPixels = options.maxPixels || 9_000_000;
  const longEdge = Math.max(width, height);

  let scale = 1;
  if (longEdge < target && maxScale > 1) {
    scale = Math.min(maxScale, Math.max(1, Math.round(target / longEdge)));
  }
  if (longEdge * scale > maxLongEdge) scale = maxLongEdge / longEdge;
  if (width * height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (width * height));
  scale = Math.max(0.05, scale);

  return {
    scale,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

module.exports = { resampleRgba, planWorkingSize };
