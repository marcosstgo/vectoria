const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  source: null,
  image: null,
  svg: '',
  width: 0,
  height: 0,
  view: 'compare',
  preset: 'logo',
  dirty: false,
  lastSaved: null,
  engine: '',
};

const els = {
  stage: $('#stage'),
  dropzone: $('#dropzone'),
  canvasArea: $('#canvasArea'),
  artboard: $('#artboard'),
  originalImage: $('#originalImage'),
  vectorLayer: $('#vectorLayer'),
  diffLayer: $('#diffLayer'),
  diffLegend: $('#diffLegend'),
  diffSummary: $('#diffSummary'),
  compareLine: $('#compareLine'),
  compareRange: $('#compareRange'),
  processing: $('#processing'),
  colorsRange: $('#colorsRange'),
  colorsValue: $('#colorsValue'),
  detailRange: $('#detailRange'),
  detailValue: $('#detailValue'),
  regularizeRange: $('#regularizeRange'),
  regularizeValue: $('#regularizeValue'),
  smoothToggle: $('#smoothToggle'),
  backgroundToggle: $('#backgroundToggle'),
  palette: $('#palette'),
  traceBtn: $('#traceBtn'),
  exportBtn: $('#exportBtn'),
  resultStats: $('#resultStats'),
  shapeCount: $('#shapeCount'),
  nodeCount: $('#nodeCount'),
  resultSize: $('#resultSize'),
  documentTitle: $('#documentTitle'),
  autoBadge: $('#autoBadge'),
  exportDialog: $('#exportDialog'),
  helpDialog: $('#helpDialog'),
  aboutDialog: $('#aboutDialog'),
  aboutVersion: $('#aboutVersion'),
  toast: $('#toast'),
  zoomRange: $('#zoomRange'),
  zoomValue: $('#zoomValue'),
  canvasColor: $('#canvasColor'),
  engineInfo: $('#engineInfo'),
  appVersion: $('#appVersion'),
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

function readableBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function safeBaseName(name = 'vectorizado') {
  return name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*]+/g, '-').trim() || 'vectorizado';
}

function setDirty(dirty = true) {
  state.dirty = dirty;
  els.traceBtn.disabled = !state.source || !dirty;
  els.autoBadge.textContent = dirty ? 'Cambios pendientes' : 'Actualizado';
  els.autoBadge.style.background = dirty ? '#f7ead4' : '#e1eeeb';
  els.autoBadge.style.color = dirty ? '#8b5a18' : '';
}

function detailName(value) {
  return ['Simple', 'Equilibrado', 'Preciso'][Number(value)] || 'Equilibrado';
}

// El deslizador va de 0 a 4 en pasos enteros; el motor espera de 0 a 2.
function regularizeAmount(value) {
  return Number(value) / 2;
}

function regularizeName(value) {
  return ['Ninguna', 'Suave', 'Normal', 'Alta', 'Máxima'][Number(value)] || 'Normal';
}

function updateLabels() {
  els.colorsValue.textContent = els.colorsRange.value;
  els.detailValue.textContent = detailName(els.detailRange.value);
  els.regularizeValue.textContent = regularizeName(els.regularizeRange.value);
}

function applyPreset(preset) {
  state.preset = preset;
  $$('.preset-card').forEach((button) => button.classList.toggle('active', button.dataset.preset === preset));
  // La regularizacion sube en Logo, donde el objetivo es la forma que el
  // disenador dibujo, y baja en Dibujo, donde una ondulacion del trazo puede
  // ser intencionada y no un defecto del archivo.
  const settings = {
    logo: { colors: 8, detail: 1, smooth: true, regularize: 2 },
    drawing: { colors: 4, detail: 2, smooth: true, regularize: 1 },
    photo: { colors: 20, detail: 1, smooth: true, regularize: 1 },
  }[preset];
  els.colorsRange.value = settings.colors;
  els.detailRange.value = settings.detail;
  els.regularizeRange.value = settings.regularize;
  els.smoothToggle.checked = settings.smooth;
  updateLabels();
  if (state.source) setDirty(true);
}

function fitArtboard() {
  if (!state.width || els.canvasArea.hidden) return;
  const areaWidth = Math.max(200, els.canvasArea.clientWidth - 44);
  const areaHeight = Math.max(200, els.canvasArea.clientHeight - 70);
  const fit = Math.min(areaWidth / state.width, areaHeight / state.height);
  const zoom = Number(els.zoomRange.value) / 100;
  els.artboard.style.width = `${Math.max(120, state.width * fit * zoom)}px`;
  els.artboard.style.height = `${Math.max(90, state.height * fit * zoom)}px`;
  els.zoomValue.textContent = `${els.zoomRange.value}%`;
}

function setView(view) {
  $$('.view-tab').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  els.artboard.className = `artboard view-${view}`;
  state.view = view;
  els.diffLegend.style.display = view === 'diff' ? 'inline-flex' : 'none';
  if (view === 'diff') renderDifference();
}

// Vista de diferencias.
//
// Es la herramienta que hemos usado para encontrar cada fallo del motor: rojo
// donde el trazado pone tinta que el original no tiene, naranja donde le falta.
// Teniéndola dentro de la aplicación se puede juzgar un resultado sin depender
// de un análisis externo, que es justo lo que hace falta cuando aparece un
// archivo que se comporta de forma rara.
async function renderDifference() {
  if (!state.svg || !state.image || !els.diffLayer) return;
  const longest = Math.max(state.width, state.height);
  const scale = Math.min(1, 1600 / longest);
  const width = Math.max(1, Math.round(state.width * scale));
  const height = Math.max(1, Math.round(state.height * scale));

  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  sourceContext.drawImage(state.image, 0, 0, width, height);
  const sourceData = sourceContext.getImageData(0, 0, width, height).data;

  // Máscara de tinta del original. Con transparencia basta el canal alfa; sobre
  // fondo sólido se mide la distancia al color del fondo, igual que hace el
  // motor para construir su campo de cobertura.
  const background = estimateBackground(sourceData, width, height);
  let opaque = 0;
  let maxDistance = 0;
  for (let i = 0; i < sourceData.length; i += 4) {
    if (sourceData[i + 3] > 200) opaque += 1;
    const distance = Math.hypot(
      sourceData[i] - background[0],
      sourceData[i + 1] - background[1],
      sourceData[i + 2] - background[2],
    );
    if (sourceData[i + 3] > 128 && distance > maxDistance) maxDistance = distance;
  }
  const mostlyOpaque = opaque > (width * height) * 0.9;
  const inkThreshold = Math.max(30, maxDistance * 0.5);
  const sourceInk = (index) => {
    const alpha = sourceData[index + 3] / 255;
    if (!mostlyOpaque) return alpha >= 0.5;
    if (alpha < 0.5) return false;
    return Math.hypot(
      sourceData[index] - background[0],
      sourceData[index + 1] - background[1],
      sourceData[index + 2] - background[2],
    ) >= inkThreshold;
  };

  const traced = document.createElement('canvas');
  traced.width = width;
  traced.height = height;
  const tracedContext = traced.getContext('2d', { willReadFrequently: true });
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.svg)}`;
  try {
    await image.decode();
  } catch (error) {
    console.warn('No se pudo rasterizar el SVG para la vista de diferencias.', error);
    return;
  }
  tracedContext.drawImage(image, 0, 0, width, height);
  const tracedData = tracedContext.getImageData(0, 0, width, height).data;

  const output = tracedContext.createImageData(width, height);
  let added = 0;
  let missing = 0;
  for (let i = 0; i < output.data.length; i += 4) {
    const inSource = sourceInk(i);
    const inTrace = tracedData[i + 3] >= 128;
    if (inSource && inTrace) {
      output.data[i] = 210; output.data[i + 1] = 214; output.data[i + 2] = 212; output.data[i + 3] = 255;
    } else if (inTrace) {
      output.data[i] = 232; output.data[i + 1] = 58; output.data[i + 2] = 58; output.data[i + 3] = 255;
      added += 1;
    } else if (inSource) {
      output.data[i] = 250; output.data[i + 1] = 166; output.data[i + 2] = 32; output.data[i + 3] = 255;
      missing += 1;
    } else {
      output.data[i + 3] = 0;
    }
  }
  els.diffLayer.width = width;
  els.diffLayer.height = height;
  els.diffLayer.getContext('2d').putImageData(output, 0, 0);

  const total = added + missing;
  els.diffSummary.textContent = total
    ? `${added.toLocaleString('es')} px de más · ${missing.toLocaleString('es')} px de menos`
    : 'Sin diferencias apreciables';
  els.diffSummary.hidden = false;
}

function updateCompare(value) {
  els.vectorLayer.style.clipPath = `inset(0 0 0 ${value}%)`;
  els.compareLine.style.left = `${value}%`;
}

function setCanvasBackground(mode, customColor) {
  els.artboard.dataset.canvasBg = mode;
  if (customColor) els.artboard.style.setProperty('--canvas-custom', customColor);
  $$('.canvas-bg-btn').forEach((button) => button.classList.toggle('active', button.dataset.canvasBg === mode));
  $('.canvas-color').classList.toggle('active', mode === 'custom');
}

function chooseCanvasForImage(image) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 96 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let visible = 0;
  let transparent = 0;
  let luminance = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 24) { transparent += 1; continue; }
    const weight = pixels[i + 3] / 255;
    visible += weight;
    luminance += (pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722) * weight;
  }
  const transparencyRatio = transparent / (pixels.length / 4);
  const averageLuminance = visible ? luminance / visible : 255;
  if (transparencyRatio > .08 && averageLuminance > 188) return 'dark';
  if (transparencyRatio > .08) return 'checker';
  return 'light';
}

function getTraceOptions() {
  const detail = Number(els.detailRange.value);
  const preset = state.preset;
  const detailOptions = [
    { ltres: 1.65, qtres: 1.65, pathomit: 16, roundcoords: 1 },
    { ltres: 1.0, qtres: 1.0, pathomit: 8, roundcoords: 2 },
    { ltres: 0.55, qtres: 0.55, pathomit: 3, roundcoords: 2 },
  ][detail];

  return {
    ...detailOptions,
    numberofcolors: Number(els.colorsRange.value),
    colorsampling: 2,
    colorquantcycles: preset === 'photo' ? 4 : 6,
    mincolorratio: preset === 'photo' ? 0.01 : 0.025,
    rightangleenhance: preset === 'logo',
    layering: 0,
    strokewidth: 0,
    linefilter: preset !== 'drawing',
    scale: 1,
    viewbox: true,
    desc: false,
    blurradius: els.smoothToggle.checked ? (preset === 'photo' ? 1 : 0.6) : 0,
    blurdelta: 20,
  };
}

function estimateBackground(data, width, height) {
  const points = [
    [1, 1], [Math.max(1, width - 2), 1],
    [1, Math.max(1, height - 2)], [Math.max(1, width - 2), Math.max(1, height - 2)],
  ];
  const sum = [0, 0, 0];
  points.forEach(([x, y]) => {
    const offset = (y * width + x) * 4;
    sum[0] += data[offset]; sum[1] += data[offset + 1]; sum[2] += data[offset + 2];
  });
  return sum.map((value) => value / points.length);
}

function removeEstimatedBackground(imageData) {
  const { data, width, height } = imageData;
  const bg = estimateBackground(data, width, height);
  const threshold = 52;
  for (let i = 0; i < data.length; i += 4) {
    const distance = Math.sqrt(
      (data[i] - bg[0]) ** 2 +
      (data[i + 1] - bg[1]) ** 2 +
      (data[i + 2] - bg[2]) ** 2,
    );
    if (distance < threshold) data[i + 3] = Math.round(255 * Math.max(0, distance - 18) / (threshold - 18));
  }
  return imageData;
}

function createImageData() {
  // El proceso principal decide la resolucion de trabajo y remuestrea con un
  // nucleo de reconstruccion propio. Aqui solo se entregan los pixeles lo mas
  // cerca posible del original: reducir en el canvas antes de enviarlos tiraba
  // detalle que despues era imposible recuperar.
  const maxPixels = 12_000_000;
  const scale = Math.min(1, Math.sqrt(maxPixels / (state.width * state.height)));
  const width = Math.max(1, Math.round(state.width * scale));
  const height = Math.max(1, Math.round(state.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // Logo contours are smoothed geometrically after extracting the alpha edge.
  // Pixel blur changes stroke width and can close small counters in lettering.
  if (els.smoothToggle.checked && state.preset === 'drawing') context.filter = 'blur(.3px)';
  context.drawImage(state.image, 0, 0, width, height);
  let imageData = context.getImageData(0, 0, width, height);
  if (els.backgroundToggle.checked) imageData = removeEstimatedBackground(imageData);
  return imageData;
}

function normalizeSvg(svg) {
  let result = svg.trim();
  if (!/xmlns=/.test(result)) result = result.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  if (!/viewBox=/i.test(result)) {
    const dimensions = result.match(/<svg\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/i);
    if (dimensions) result = result.replace('<svg ', `<svg viewBox="0 0 ${dimensions[1]} ${dimensions[2]}" preserveAspectRatio="xMidYMid meet" `);
  }
  result = result.replace(/<desc>.*?<\/desc>/gs, '');
  return result;
}

function updateResultInfo(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const paths = [...doc.querySelectorAll('path')];
  const nodeCount = paths.reduce((count, path) => count + ((path.getAttribute('d') || '').match(/[MLCQAZ]/gi) || []).length, 0);
  const colors = [...new Set(paths.map((path) => path.getAttribute('fill')).filter((fill) => fill && fill !== 'none'))].slice(0, 18);

  els.shapeCount.textContent = paths.length.toLocaleString('es');
  els.nodeCount.textContent = nodeCount.toLocaleString('es');
  els.resultSize.textContent = readableBytes(new Blob([svg]).size);
  els.resultStats.hidden = false;

  els.palette.innerHTML = '';
  colors.forEach((color) => {
    const swatch = document.createElement('span');
    swatch.style.setProperty('--swatch', color);
    swatch.title = color;
    els.palette.appendChild(swatch);
  });
}

async function traceImage({ initial = false } = {}) {
  if (!state.image || !window.ImageTracer) return;
  els.processing.hidden = false;
  els.traceBtn.disabled = true;
  els.exportBtn.disabled = true;

  await new Promise((resolve) => setTimeout(resolve, 45));
  try {
    const started = performance.now();
    const imageData = createImageData();
    let svg;
    try {
      const result = await window.vectoria.traceVtracer({
        pixels: imageData.data.slice().buffer,
        width: imageData.width,
        height: imageData.height,
        settings: {
          preset: state.preset,
          colors: Number(els.colorsRange.value),
          detail: Number(els.detailRange.value),
          smooth: els.smoothToggle.checked,
          regularize: regularizeAmount(els.regularizeRange.value),
        },
      });
      svg = result.svg;
      state.engine = result.engine;
    } catch (vtracerError) {
      console.warn('VTracer no disponible; usando motor compatible.', vtracerError);
      svg = window.ImageTracer.imagedataToSVG(imageData, getTraceOptions());
      state.engine = 'Motor compatible';
    }
    state.svg = normalizeSvg(svg);
    els.vectorLayer.innerHTML = state.svg;
    updateResultInfo(state.svg);
    if (state.view === 'diff') renderDifference();
    els.engineInfo.querySelector('b').textContent = state.engine;
    els.engineInfo.hidden = false;
    setDirty(false);
    els.exportBtn.disabled = false;
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    if (!initial) showToast(`Trazado actualizado en ${elapsed} s`);
  } catch (error) {
    console.error(error);
    showToast('No se pudo vectorizar esta imagen. Prueba otro archivo o reduce el detalle.');
    els.traceBtn.disabled = false;
  } finally {
    els.processing.hidden = true;
  }
}

async function loadDataUrl(source) {
  if (!source?.dataUrl) return;
  const image = new Image();
  image.decoding = 'async';
  image.onload = async () => {
    state.source = source;
    state.image = image;
    state.width = image.naturalWidth;
    state.height = image.naturalHeight;
    state.svg = '';
    state.lastSaved = null;
    state.engine = '';
    els.originalImage.src = source.dataUrl;
    const preferredCanvas = chooseCanvasForImage(image);
    setCanvasBackground(preferredCanvas);
    els.documentTitle.textContent = source.name || 'Imagen sin título';
    els.dropzone.hidden = true;
    els.canvasArea.hidden = false;
    els.stage.classList.remove('is-empty');
    els.resultStats.hidden = true;
    els.engineInfo.hidden = true;
    els.exportBtn.disabled = true;
    els.zoomRange.value = 100;
    fitArtboard();
    if (preferredCanvas === 'dark') showToast('Fondo oscuro activado para que el diseño blanco sea visible.');
    await traceImage({ initial: true });
  };
  image.onerror = () => showToast('El archivo no contiene una imagen compatible.');
  image.src = source.dataUrl;
}

async function pickImage() {
  const selected = await window.vectoria.pickImage();
  if (selected) await loadDataUrl(selected);
}

function loadDroppedFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Suelta una imagen JPG, PNG, BMP, GIF o WebP.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => loadDataUrl({ name: file.name, dataUrl: reader.result });
  reader.onerror = () => showToast('No se pudo leer la imagen.');
  reader.readAsDataURL(file);
}

function resetProject() {
  state.source = null;
  state.image = null;
  state.svg = '';
  state.engine = '';
  state.width = 0;
  state.height = 0;
  els.originalImage.removeAttribute('src');
  els.vectorLayer.innerHTML = '';
  els.dropzone.hidden = false;
  els.canvasArea.hidden = true;
  els.resultStats.hidden = true;
  els.engineInfo.hidden = true;
  els.traceBtn.disabled = true;
  els.exportBtn.disabled = true;
  els.documentTitle.textContent = 'Una imagen, curvas limpias.';
  els.autoBadge.textContent = 'Automático';
  els.autoBadge.removeAttribute('style');
}

async function exportResult(format) {
  if (!state.svg) return;
  const base = safeBaseName(state.source?.name);
  try {
    const path = format === 'svg'
      ? await window.vectoria.saveSvg({ svg: state.svg, suggestedName: `${base}-vector.svg` })
      : await window.vectoria.savePdf({ svg: state.svg, suggestedName: `${base}-vector.pdf`, width: state.width, height: state.height });
    if (path) {
      state.lastSaved = path;
      els.exportDialog.hidden = true;
      showToast(`${format.toUpperCase()} guardado correctamente`);
    }
  } catch (error) {
    console.error(error);
    showToast(`No se pudo guardar el ${format.toUpperCase()}.`);
  }
}

$('#openBtn').addEventListener('click', pickImage);
$('#chooseBtn').addEventListener('click', pickImage);
$('#newBtn').addEventListener('click', resetProject);
$('#helpBtn').addEventListener('click', () => { els.helpDialog.hidden = false; });
$('#closeHelp').addEventListener('click', () => { els.helpDialog.hidden = true; });
$('#aboutBtn').addEventListener('click', () => { els.aboutDialog.hidden = false; });
$('#closeAbout').addEventListener('click', () => { els.aboutDialog.hidden = true; });
$('#closeExport').addEventListener('click', () => { els.exportDialog.hidden = true; });
els.traceBtn.addEventListener('click', () => traceImage());
els.exportBtn.addEventListener('click', () => { els.exportDialog.hidden = false; });

$$('.format-card').forEach((button) => button.addEventListener('click', () => exportResult(button.dataset.format)));
$$('.preset-card').forEach((button) => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
$$('.view-tab').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('.canvas-bg-btn').forEach((button) => button.addEventListener('click', () => setCanvasBackground(button.dataset.canvasBg)));
els.canvasColor.addEventListener('input', () => setCanvasBackground('custom', els.canvasColor.value));

[els.colorsRange, els.detailRange, els.regularizeRange].forEach((input) => input.addEventListener('input', () => {
  updateLabels();
  if (state.source) setDirty(true);
}));
[els.smoothToggle, els.backgroundToggle].forEach((input) => input.addEventListener('change', () => state.source && setDirty(true)));

els.compareRange.addEventListener('input', () => updateCompare(els.compareRange.value));
els.zoomRange.addEventListener('input', fitArtboard);
window.addEventListener('resize', fitArtboard);

['dragenter', 'dragover'].forEach((name) => window.addEventListener(name, (event) => {
  event.preventDefault();
  els.stage.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((name) => window.addEventListener(name, (event) => {
  event.preventDefault();
  els.stage.classList.remove('dragging');
}));
window.addEventListener('drop', (event) => loadDroppedFile(event.dataTransfer.files[0]));

$$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('mousedown', (event) => {
  if (event.target === backdrop) backdrop.hidden = true;
}));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    els.exportDialog.hidden = true;
    els.helpDialog.hidden = true;
    els.aboutDialog.hidden = true;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    pickImage();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.svg) {
    event.preventDefault();
    els.exportDialog.hidden = false;
  }
});

updateLabels();
updateCompare(50);
setCanvasBackground('checker');

window.vectoria.getVersion()
  .then((version) => {
    els.appVersion.textContent = `v${version}`;
    // En el diálogo la etiqueta ya dice "Versión", así que aquí sólo el número.
    els.aboutVersion.textContent = version;
  })
  .catch(() => { els.appVersion.hidden = true; });
