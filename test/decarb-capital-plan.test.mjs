import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

// Regression coverage for the five Crystal View Apartments fixes (session
// sesn_012uy6nzLtGaxi577wg6xBgv). Mirrors the render-then-assert pattern already used by
// test/decarb-presentation.test.mjs, applied to templates/decarb-capital-plan/layout-agent.html.

const html = readFileSync(new URL('../templates/decarb-capital-plan/layout-agent.html', import.meta.url), 'utf8')
const example = JSON.parse(readFileSync(new URL('../templates/decarb-capital-plan/example-data.json', import.meta.url), 'utf8'))

function render(overrides) {
  const data = JSON.parse(JSON.stringify(example))
  if (overrides) Object.assign(data, overrides)
  const withData = html.replace(
    /<script id="report-data"[^>]*>[\s\S]*?<\/script>/,
    `<script id="report-data" type="application/json">${JSON.stringify(data)}</script>`,
  )
  const dom = new JSDOM(withData, { runScripts: 'dangerously', pretendToBeVisual: true })
  dom.window.populateReport()
  return dom.window.document
}

// ── Fix 1: EUI/GHGi exhibits lose their border; other exhibits keep it ───────────────────────
// jsdom's getComputedStyle does not resolve var() inside the `border` shorthand (it always
// reports 'none' regardless of the actual cascade — confirmed against a minimal repro), so this
// checks the CSSOM rules directly rather than computed style.
test('a scoped rule removes the border on #exhibit-eui/#exhibit-ghgi without touching .exhibit', () => {
  const doc = render()
  const rules = Array.from(doc.styleSheets[0].cssRules)
  const scoped = rules.find((r) => r.selectorText === '#exhibit-eui, #exhibit-ghgi')
  assert.ok(scoped, 'expected a rule scoped to exactly #exhibit-eui, #exhibit-ghgi')
  assert.strictEqual(scoped.style.borderStyle, 'none')
  const shared = rules.find((r) => r.selectorText === '.exhibit')
  assert.ok(shared, 'the shared .exhibit rule must still exist')
  assert.ok(/var\(--border-hairline\)/.test(shared.style.border), '.exhibit itself must be untouched — still bordered for every other exhibit')
})

// ── Fix 3: plain-paragraph narrative wins over the structured/labelled-row summary ────────────
test('sum.narrative renders as plain exec-summary-para paragraphs, not the structured rows', () => {
  // Matches the real Crystal View shape: no executive_summary_block, a real summary.narrative.
  const doc = render({ executive_summary_block: null })
  const paras = doc.querySelectorAll('#exec-summary .exec-summary-para')
  assert.ok(paras.length >= 2, 'expected the multi-paragraph narrative to render as .exec-summary-para blocks')
  assert.strictEqual(doc.querySelectorAll('#exec-summary .exec-summary-row').length, 0, 'no labelled rows when narrative is used')
  assert.strictEqual(doc.querySelectorAll('#exec-summary .exec-summary-headline').length, 0, 'no headline callout when narrative is used')
  const summaryNarrative = doc.getElementById('summary-narrative')
  assert.strictEqual(summaryNarrative.style.display, 'none', 'the old separate narrative div stays hidden')
  assert.strictEqual(summaryNarrative.innerHTML, '', 'content lives in #exec-summary, not duplicated in #summary-narrative')
})

test('narrative still wins even when the legacy structured fields are ALSO present', () => {
  // The exact regression: any xs.headline/crrem_status/recommendation used to win outright.
  const doc = render({
    executive_summary_block: { headline: 'Should not render', crrem_status: 'Compliant', recommendation: 'Proceed' },
  })
  assert.ok(doc.querySelectorAll('#exec-summary .exec-summary-para').length >= 2)
  assert.strictEqual(doc.querySelectorAll('#exec-summary .exec-summary-row').length, 0)
  assert.strictEqual(doc.getElementById('exec-summary').textContent.includes('Should not render'), false)
})

test('xs.paragraphs still takes priority over sum.narrative when both are present', () => {
  const doc = render({ executive_summary_block: { paragraphs: ['First authored paragraph.', 'Second authored paragraph.'] } })
  const paras = doc.querySelectorAll('#exec-summary .exec-summary-para')
  assert.strictEqual(paras.length, 2)
  assert.strictEqual(paras[0].textContent, 'First authored paragraph.')
})

test('the legacy structured summary still renders when NEITHER paragraph source exists', () => {
  const doc = render({
    executive_summary_block: { headline: 'Fallback headline', crrem_status: 'Compliant' },
    summary: { narrative: '' },
  })
  assert.ok(doc.querySelector('#exec-summary .exec-summary-headline'), 'legacy fallback still works when there is truly nothing else')
  assert.strictEqual(doc.querySelector('#exec-summary .exec-summary-headline').textContent, 'Fallback headline')
})

// ── Fix 4: a whole-number reduction_pct (the "7000%" bug) is normalized, not double-scaled ────
test('carbon.reduction_pct supplied as a whole number (70) renders as ~70%, not 7000%', () => {
  const doc = render({ impact: { ...example.impact, carbon: { baseline_tco2e: 1520, post_retrofit_tco2e: 933, reduction_pct: 70 } } })
  const tiles = Array.from(doc.querySelectorAll('#summary-kpi-grid .kpi-tile'))
  const emissionsTile = tiles.find((t) => t.querySelector('.kpi-label').textContent === 'Emissions Reduction')
  assert.ok(emissionsTile, 'Emissions Reduction KPI tile should render')
  const value = emissionsTile.querySelector('.kpi-value').textContent
  assert.strictEqual(value, '70%')
})

test('carbon.reduction_pct supplied correctly as a fraction (0.386) is unaffected by the guard', () => {
  const doc = render() // example-data.json's own reduction_pct: 0.386
  const tiles = Array.from(doc.querySelectorAll('#summary-kpi-grid .kpi-tile'))
  const emissionsTile = tiles.find((t) => t.querySelector('.kpi-label').textContent === 'Emissions Reduction')
  assert.strictEqual(emissionsTile.querySelector('.kpi-value').textContent, '39%')
})
