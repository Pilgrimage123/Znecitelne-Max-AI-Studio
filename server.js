import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const APP_FILE = path.join(__dirname, 'znecitelne.html');

const safeInlineJs = (code) =>
  String(code || '')
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');

const safeInlineJsonString = (str) =>
  JSON.stringify(String(str || ''))
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

// API endpoint to bundle and download the self-contained offline application
app.get('/api/download-offline-app', (req, res) => {
  try {
    const variant = req.query.variant === 'ocr' ? 'ocr' : 'standard';
    const canonicalHtml = fs.readFileSync(APP_FILE, 'utf8');
    const readLib = (rel) => fs.readFileSync(path.join(__dirname, rel));
    const readLibText = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

    const fontkit = readLibText('lib/fontkit.umd.min.js');
    const pdflib = readLibText('lib/pdf-lib.min.js');
    const pdfjs = readLibText('lib/pdf.min.js');
    const pdfworkerB64 = readLib('lib/pdf.worker.min.js').toString('base64');
    const mammoth = readLibText('lib/mammoth.browser.min.js');
    const xlsx = readLibText('lib/xlsx.full.min.js');
    const fflate = readLibText('lib/fflate.js');

    let out = canonicalHtml;
    out = out.replace(/<script\s+src="\.?\/lib\/fontkit\.umd\.min\.js"[^>]*><\/script>/i, () =>
      `<script>/* fontkit */ (window.__libLocal=window.__libLocal||{}).fontkit=1;\n${safeInlineJs(fontkit)}\n</script>`
    );
    out = out.replace(/<script\s+src="\.?\/lib\/pdf-lib\.min\.js"[^>]*><\/script>/i, () =>
      `<script>/* pdf-lib */ (window.__libLocal=window.__libLocal||{}).pdflib=1;\n${safeInlineJs(pdflib)}\n</script>`
    );
    out = out.replace(/<script\s+src="\.?\/lib\/pdf\.worker\.min\.js"[^>]*><\/script>/i, () =>
      `<script>/* pdf.worker */ (window.__libLocal=window.__libLocal||{}).pdfworker=1; window.__INLINE_PDF_WORKER_B64__ = "${pdfworkerB64}";\n</script>`
    );
    out = out.replace(/<script\s+src="\.?\/lib\/pdf\.min\.js"[^>]*><\/script>/i, () =>
      `<script>/* pdf.js */ (window.__libLocal=window.__libLocal||{}).pdfjs=1;\n${safeInlineJs(pdfjs)}\n</script>`
    );
    out = out.replace(/<script\s+src="\.?\/lib\/mammoth\.browser\.min\.js"[^>]*><\/script>/i, () =>
      `<script>/* mammoth */ (window.__libLocal=window.__libLocal||{}).mammoth=1;\n${safeInlineJs(mammoth)}\n</script>`
    );
    out = out.replace(/<script\s+src="\.?\/lib\/xlsx\.full\.min\.js"[^>]*><\/script>/i, () =>
      `<script>/* xlsx */ (window.__libLocal=window.__libLocal||{}).xlsx=1;\n${safeInlineJs(xlsx)}\n</script>`
    );
    out = out.replace(/<script\s+src="\.?\/lib\/fflate\.js"[^>]*><\/script>/i, () =>
      `<script>/* fflate */ (window.__libLocal=window.__libLocal||{}).fflate=1;\n${safeInlineJs(fflate)}\n</script>`
    );

    if (variant === 'ocr') {
      const tesseractJs = readLibText('lib/tesseract.min.js');
      const workerCode = readLibText('lib/tesseract/worker.min.js');
      // tesseract-core-simd-lstm.wasm.js already embeds the WASM binary inline (no duplicate .wasm needed)
      const simdCoreJs = readLibText('lib/tesseract/core/tesseract-core-simd-lstm.wasm.js');
      const langCesB64 = readLib('lib/tesseract/lang/ces.traineddata.gz').toString('base64');

      out = out.replace(/<script\s+src="\.?\/lib\/tesseract\.min\.js"[^>]*><\/script>/i, () =>
        `<script id="inline-tesseract-lib">/* tesseract */ (window.__libLocal=window.__libLocal||{}).tesseract=1;\n${safeInlineJs(tesseractJs)}\n</script>\n<script id="inline-ocr-assets">\nwindow.__INLINE_OCR_ASSETS__ = {\n  workerCode: ${safeInlineJsonString(workerCode)},\n  simdCoreJs: ${safeInlineJsonString(simdCoreJs)},\n  langCesB64: "${langCesB64}"\n};\n</script>`
      );
    } else {
      out = out.replace(/<script\s+src="\.?\/lib\/tesseract\.min\.js"[^>]*><\/script>/i, () =>
        `<script id="inline-tesseract-lib">/* OCR excluded in standard single-file build */</script>`
      );
    }

    const filename = variant === 'ocr' ? 'znecitelne-offline-ocr.html' : 'znecitelne-offline.html';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(out);
  } catch (err) {
    console.error('Failed generating offline app bundle:', err);
    res.status(500).type('text/plain').send('Failed generating offline app: ' + err.message);
  }
});

// Canonical application entry point.
app.get('/', (_req, res) => {
  res.sendFile(APP_FILE);
});

app.get('/znecitelne.html', (_req, res) => {
  res.sendFile(APP_FILE);
});

// There is intentionally no second application entry point.  Keep old
// /index.html bookmarks working without creating an index.html application.
app.get('/index.html', (_req, res) => {
  res.redirect(308, '/');
});

// Static assets: ./lib/*, metadata.json, etc.
// Missing file-like assets must remain real 404s. Otherwise the SPA shell
// can be returned with HTTP 200 and fool runtime asset probes.
app.use(express.static(__dirname, { fallthrough: true }));

// Client-side fallback for application routes only.
app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  res.sendFile(APP_FILE);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
