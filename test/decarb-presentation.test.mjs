import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const html = readFileSync(new URL('../templates/decarb/layout-agent.html', import.meta.url), 'utf8')
const example = JSON.parse(readFileSync(new URL('../templates/decarb/example-data.json', import.meta.url), 'utf8'))

function render(presentation) {
  const data = { ...example, presentation }
  const withData = html.replace(
    /<script id="report-data"[^>]*>[\s\S]*?<\/script>/,
    `<script id="report-data" type="application/json">${JSON.stringify(data)}</script>`,
  )
  const dom = new JSDOM(withData, { runScripts: 'dangerously', pretendToBeVisual: true })
  // jsdom fires DOMContentLoaded asynchronously; call the (window-global) entry point
  // explicitly so population is complete before we assert.
  dom.window.populateReport()
  return dom.window.document
}

test('hides a section when presentation says visible:false', () => {
  const doc = render({ sections: { 'dq-summary': { visible: false } } })
  const el = doc.querySelector('[data-section="dq-summary"]')
  assert.ok(el, 'dq-summary section exists')
  assert.strictEqual(el.style.display, 'none')
})

test('paginates into .page cards when presentation.paged.enabled', () => {
  const doc = render({ paged: { enabled: true, page_size: 'letter', running_header: 'Decarbonization Roadmap' } })
  assert.ok(doc.querySelectorAll('.page').length >= 1, 'produced at least one .page card')
  assert.ok(doc.querySelector('.pg-header'), 'running header present')
  assert.ok(doc.querySelector('.pg-footer'), 'running footer present')
})

test('no .page cards when paged disabled', () => {
  const doc = render({ paged: { enabled: false, page_size: 'letter' } })
  assert.strictEqual(doc.querySelectorAll('.page').length, 0)
})

test('applies an identity override to the cover byline', () => {
  const doc = render({ identity: { prepared_by: 'Christopher Naismith' } })
  const by = doc.getElementById('cover-meta-by')
  assert.ok(by, 'cover-meta-by exists')
  assert.strictEqual(by.textContent, 'Christopher Naismith')
})
