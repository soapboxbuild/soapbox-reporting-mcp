// Server-side PDF rendering for the template-mcp.
//
// report mode  → continuous doc paginated with Paged.js (hero page 1, running
//                header page 2+, footer + page numbers, keep-together).
// deck   mode  → a flip slide deck exported one .slide per landscape page.
//
// Chromium ships in the Docker image (Playwright base). The rendered PDF is
// uploaded to Supabase Storage and a signed URL is returned to the caller.
import http from 'node:http'
import { chromium, type Browser } from 'playwright'
import { PDFDocument } from 'pdf-lib'

// Repointed from soapboxbuild/soapbox-agent as part of the 2026-08-15 migration — this repo is
// now the source of truth for both the templates and these PDF-render assets. print.css and
// paged.polyfill.js were carried over from soapbox-agent's skills/report-pdf/assets/ (the report-pdf
// *skill*, i.e. its agent-facing instructions, was deliberately NOT migrated — these two files are
// runtime assets the service itself depends on, a different thing that happened to live under the
// same directory name). raw.githubusercontent.com requires the source repo to be public, matching
// soapbox-agent's own visibility.
const REPO = 'https://raw.githubusercontent.com/soapboxbuild/soapbox-reporting-mcp/main'

let browserPromise: Promise<Browser> | null = null
function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = chromium.launch({ args: ['--no-sandbox'] })
  return browserPromise
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`)
  return r.text()
}

export type PdfMode = 'auto' | 'report' | 'deck'

export function detectMode(html: string, requested: PdfMode): 'report' | 'deck' {
  if (requested !== 'auto') return requested
  return /id="deck"|class="slide/.test(html) ? 'deck' : 'report'
}

// Report transform: mirror the skill's print-transform (open <details>, un-toggle
// legends, derive a running header/footer from the report's own title/meta).
const TRANSFORM_JS = `(() => {
  const d = document;
  d.querySelectorAll('details').forEach(e => e.open = true);
  d.querySelectorAll('.leg-off,[data-si].off').forEach(e => e.classList.remove('leg-off','off'));
  const t = (d.querySelector('.doc-header-title,.port-name,.doc-title')||{}).textContent
          || (d.title||'').replace(/\\s*\\|\\s*Soapbox.*$/,'') || 'Soapbox Report';
  const sub = (d.querySelector('.doc-header-sub,.port-sub')||{}).textContent || '';
  const meta = (d.querySelector('.meta-strip,.meta-confidential')||{}).textContent
             || 'Soapbox Sustainability Intelligence · CONFIDENTIAL';
  const mk = (c,x) => { const e=d.createElement('div'); e.className=c; e.textContent=x; d.body.insertBefore(e,d.body.firstChild); };
  mk('print-runhdr-l', t.trim());
  mk('print-runhdr-r', (sub.split('·')[0]||'').trim());
  mk('print-runftr', meta.replace(/\\s+/g,' ').trim());
})();`

async function renderReportPdf(html: string): Promise<Buffer> {
  const [printCss, pagedJs] = await Promise.all([
    fetchText(`${REPO}/src/assets/print.css`),
    fetchText(`${REPO}/src/assets/paged.polyfill.js`),
  ])
  // Serve the doc + assets over a real origin and page.goto — Paged.js (921 KB)
  // must load as an EXTERNAL <script>; inlining it breaks (embedded tokens).
  const wired = html
    .replace('</head>', '<link rel="stylesheet" href="print.css"></head>')
    .replace('</body>', '<script>window.PagedConfig={auto:false}</script><script src="paged.polyfill.js"></script></body>')
  const files: Record<string, [string, string]> = {
    '/index.html': [wired, 'text/html; charset=utf-8'],
    '/print.css': [printCss, 'text/css'],
    '/paged.polyfill.js': [pagedJs, 'application/javascript'],
  }
  const server = http.createServer((req, res) => {
    const f = files[(req.url ?? '').split('?')[0]]
    if (f) { res.writeHead(200, { 'Content-Type': f[1] }); res.end(f[0]) }
    else { res.writeHead(404); res.end() }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as import('node:net').AddressInfo).port
  const page = await (await getBrowser()).newPage()
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForFunction(
      "window.__reportReady === true || document.querySelectorAll('table tbody tr, .kpi, .slide').length > 2",
      { timeout: 8_000 }).catch(() => {})
    // The handshake above resolves on the row-count arm long before a template that paginates
    // itself has finished: decarb-capital-plan reflows a second time on fonts.ready (its first
    // pass measures fallback metrics and lands pages ~24px over the sheet), so Paged.js would
    // otherwise snapshot a half-paginated DOM. Wait for the real faces, give the template's
    // fonts.ready handler its frames, and let __reportReady settle if it is coming.
    await page.evaluate(
      '(async()=>{ if (document.fonts && document.fonts.ready) await document.fonts.ready;'
      + ' await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()',
    ).catch(() => {})
    await page.waitForFunction('window.__reportReady === true', { timeout: 2_000 }).catch(() => {})
    await page.evaluate(TRANSFORM_JS)
    await page.evaluate('(async()=>{ await window.PagedPolyfill.preview(); })()')
    await page.waitForSelector('.pagedjs_page', { timeout: 45_000 })
    await page.waitForTimeout(1_200)
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true })
    return Buffer.from(pdf)
  } finally {
    await page.close()
    server.close()
  }
}

async function renderDeckPdf(html: string): Promise<Buffer> {
  const page = await (await getBrowser()).newPage()
  try {
    await page.setViewportSize({ width: 1680, height: 980 })
    await page.setContent(html, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForSelector('.slide', { timeout: 8_000 })
    await page.addStyleTag({ content:
      '#nav,#navbar,#progress{display:none!important}#stage{transform:none!important}.slide{border-radius:0!important;box-shadow:none!important}' })
    const n: number = await page.evaluate("document.querySelectorAll('.slide').length")
    const doc = await PDFDocument.create()
    for (let i = 0; i < n; i++) {
      await page.evaluate((k: number) => {
        const s = Array.from(document.querySelectorAll('.slide'))
        s.forEach((x, j) => x.classList.toggle('active', j === k))
      }, i)
      await page.waitForTimeout(140)
      const shot = await page.locator('.slide.active').screenshot({ type: 'png' })
      const png = await doc.embedPng(shot)
      const p = doc.addPage([png.width, png.height])
      p.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height })
    }
    return Buffer.from(await doc.save())
  } finally {
    await page.close()
  }
}

/** Render → PDF buffer + page-mode used. */
export async function renderPdf(html: string, mode: PdfMode): Promise<{ pdf: Buffer; mode: 'report' | 'deck' }> {
  const m = detectMode(html, mode)
  const pdf = m === 'deck' ? await renderDeckPdf(html) : await renderReportPdf(html)
  return { pdf, mode: m }
}

/** Upload to Supabase Storage (asset-files/report-exports/…) and return a 7-day signed URL. */
export async function uploadPdf(pdf: Buffer, filename: string): Promise<string> {
  const base = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not configured on template-mcp')
  const slug = filename.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'report.pdf'
  const obj = `report-exports/${Date.now()}-${slug}`
  const up = await fetch(`${base}/storage/v1/object/asset-files/${obj}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: new Uint8Array(pdf),
  })
  if (!up.ok) throw new Error(`storage upload → ${up.status} ${await up.text()}`)
  const sign = await fetch(`${base}/storage/v1/object/sign/asset-files/${obj}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 604800 }),
  })
  if (!sign.ok) throw new Error(`storage sign → ${sign.status}`)
  const { signedURL } = await sign.json() as { signedURL: string }
  return `${base}/storage/v1${signedURL}`
}
