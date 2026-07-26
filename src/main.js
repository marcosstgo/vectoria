const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const { traceLogo, analyzeMonochromeLogo } = require('./logo-tracer');
const { resampleRgba, planWorkingSize } = require('./resample');
const {
  vectorizeRaw,
  optimize,
  ColorMode,
  Hierarchical,
  PathSimplifyMode,
  OptimizePreset,
} = require('@neplex/vectorizer');

let mainWindow;

function createWindow() {
  const screenshotMode = process.argv.includes('--screenshot');
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#F4F7F5',
    show: !screenshotMode,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#142A33',
      symbolColor: '#F4F7F5',
      height: 42,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  if (screenshotMode) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const testImageIndex = process.argv.indexOf('--test-image');
      const testImagePath = testImageIndex >= 0 ? process.argv[testImageIndex + 1] : null;
      let source;
      if (testImagePath && fs.existsSync(testImagePath)) {
        const ext = path.extname(testImagePath).slice(1).toLowerCase().replace('jpg', 'jpeg');
        source = { name: path.basename(testImagePath), dataUrl: `data:image/${ext};base64,${fs.readFileSync(testImagePath).toString('base64')}` };
      } else {
        const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="620" viewBox="0 0 900 620"><rect width="900" height="620" fill="#f6f2e8"/><path d="M140 450 310 140l145 310Z" fill="#246b72"/><circle cx="585" cy="270" r="138" fill="#e4a94b"/><path d="M520 205h255v72H520zm0 105h190v72H520z" fill="#142a33"/></svg>`;
        source = { name: 'muestra-forma-norte.png', dataUrl: `data:image/svg+xml;base64,${Buffer.from(sampleSvg).toString('base64')}` };
      }
      await mainWindow.webContents.executeJavaScript(`loadDataUrl(${JSON.stringify(source)})`);
      setTimeout(async () => {
        const artifactDir = path.join(__dirname, '..', 'artifacts');
        fs.mkdirSync(artifactDir, { recursive: true });
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(artifactDir, 'vectoria-preview.png'), image.toPNG());
        const traced = await mainWindow.webContents.executeJavaScript('state.svg');
        fs.writeFileSync(path.join(artifactDir, 'smoke-test.svg'), traced, 'utf8');
        app.quit();
      }, 3500);
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('pick-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Abrir imagen',
    properties: ['openFile'],
    filters: [
      { name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
      { name: 'Todos los archivos', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const buffer = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return {
    name: path.basename(filePath),
    path: filePath,
    dataUrl: `data:image/${ext};base64,${buffer.toString('base64')}`,
  };
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function vtracerConfig(settings = {}, workingScale = 1) {
  // `Number(x) || 1` convertia detail = 0 (Simple) en 1 (Equilibrado).
  const requestedDetail = Number(settings.detail);
  const detail = Number.isFinite(requestedDetail) ? clamp(Math.round(requestedDetail), 0, 2) : 1;
  const colors = clamp(Number(settings.colors) || 8, 2, 32);
  const preset = ['logo', 'drawing', 'photo'].includes(settings.preset) ? settings.preset : 'logo';
  const profiles = [
    { filterSpeckle: 8, cornerThreshold: 90, lengthThreshold: 6, maxIterations: 10, spliceThreshold: 55 },
    { filterSpeckle: 4, cornerThreshold: 75, lengthThreshold: 4, maxIterations: 10, spliceThreshold: 45 },
    { filterSpeckle: 2, cornerThreshold: 60, lengthThreshold: 3, maxIterations: 10, spliceThreshold: 35 },
  ];
  const profile = { ...profiles[detail] };

  // Los umbrales de VTracer estan en pixeles del buffer que recibe. Si se le
  // entrega la imagen ampliada hay que escalarlos, o filtrara como ruido lo
  // mismo que antes conservaba y devolvera muchos mas nodos de los necesarios.
  if (workingScale !== 1) {
    profile.filterSpeckle = Math.max(1, Math.round(profile.filterSpeckle * workingScale * workingScale));
    profile.lengthThreshold = Math.max(2, Math.round(profile.lengthThreshold * workingScale));
    profile.spliceThreshold = Math.round(profile.spliceThreshold);
  }

  if (!settings.smooth) {
    profile.filterSpeckle = Math.max(1, Math.floor(profile.filterSpeckle / 2));
    profile.cornerThreshold = Math.max(45, profile.cornerThreshold - 12);
  }
  if (preset === 'photo') {
    profile.filterSpeckle = Math.max(1, profile.filterSpeckle - 2);
    profile.lengthThreshold = Math.max(3, profile.lengthThreshold - 1);
  }

  return {
    colorMode: ColorMode.Color,
    hierarchical: Hierarchical.Stacked,
    mode: PathSimplifyMode.Spline,
    colorPrecision: clamp(colors <= 4 ? 4 : colors <= 10 ? 5 : colors <= 20 ? 6 : 7, 1, 8),
    layerDifference: preset === 'photo' ? clamp(Math.round(14 - colors / 4), 3, 12) : clamp(Math.round(18 - colors / 2), 4, 18),
    pathPrecision: detail === 0 ? 1 : 2,
    ...profile,
  };
}

ipcMain.handle('trace-vtracer', async (_event, payload) => {
  const width = Number(payload?.width);
  const height = Number(payload?.height);
  const pixels = payload?.pixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 14_000_000) {
    throw new Error('Dimensiones de imagen no válidas.');
  }
  const buffer = Buffer.from(new Uint8Array(pixels));
  if (buffer.length !== width * height * 4) throw new Error('Los píxeles de la imagen están incompletos.');

  const settings = payload.settings || {};
  const analysis = settings.preset === 'logo' ? analyzeMonochromeLogo(buffer, width, height) : null;

  // El trazador de logo reconstruye el borde a partir del campo de cobertura,
  // asi que se beneficia mucho de trabajar por encima de la resolucion nativa:
  // el antialias pasa a describirse con varios pixeles y la posicion subpixel
  // del borde se estabiliza. VTracer no gana lo mismo y si paga el coste, asi
  // que solo se le amplia hasta 2x.
  const plan = analysis?.eligible
    ? planWorkingSize(width, height, { target: 1800, maxScale: 4, maxLongEdge: 3200, maxPixels: 9_000_000 })
    : planWorkingSize(width, height, { target: 1400, maxScale: 2, maxLongEdge: 2400, maxPixels: 5_000_000 });

  const working = plan.width === width && plan.height === height
    ? { data: buffer, width, height }
    : resampleRgba(buffer, width, height, plan.width, plan.height);

  if (analysis?.eligible) {
    const specialized = traceLogo(working.data, working.width, working.height, {
      ...settings,
      analysis,
      output: { width, height },
    });
    if (specialized) {
      return { ...specialized, workingScale: plan.scale };
    }
  }

  const rawBuffer = Buffer.isBuffer(working.data)
    ? working.data
    : Buffer.from(working.data.buffer, working.data.byteOffset, working.data.byteLength);
  const raw = await vectorizeRaw(
    rawBuffer,
    { width: working.width, height: working.height },
    vtracerConfig(settings, plan.scale),
  );
  const svg = await optimize(raw, {
    preset: OptimizePreset.Safe,
    multipass: true,
    multipassIterations: 3,
  });
  return { svg, engine: 'VTracer · curvas spline', workingScale: plan.scale };
});

ipcMain.handle('save-svg', async (_event, { svg, suggestedName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Guardar SVG',
    defaultPath: suggestedName || 'vectorizado.svg',
    filters: [{ name: 'SVG vectorial', extensions: ['svg'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, svg, 'utf8');
  return result.filePath;
});

ipcMain.handle('save-pdf', async (_event, { svg, suggestedName, width, height }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Guardar PDF vectorial',
    defaultPath: suggestedName || 'vectorizado.pdf',
    filters: [{ name: 'PDF vectorial', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return null;

  const maxPage = 14400;
  const pageWidth = Math.min(Math.max(Number(width) || 1000, 1), maxPage);
  const pageHeight = Math.min(Math.max(Number(height) || 1000, 1), maxPage);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin: 0, compress: true });
    const stream = fs.createWriteStream(result.filePath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);
    doc.pipe(stream);
    SVGtoPDF(doc, svg, 0, 0, { width: pageWidth, height: pageHeight, preserveAspectRatio: 'xMidYMid meet' });
    doc.end();
  });

  return result.filePath;
});

ipcMain.handle('reveal-file', async (_event, filePath) => {
  if (!filePath) return false;
  const { shell } = require('electron');
  shell.showItemInFolder(filePath);
  return true;
});
