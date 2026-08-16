import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { renderPdf, uploadPdf, type PdfMode } from './render-pdf.js'

const REPO = 'https://raw.githubusercontent.com/soapboxbuild/soapbox-agent/main'
const KNOWN_TYPES = ['rsra', 'crrem', 'sustainability-passport', 'portfolio-analysis', 'decarb', 'retrofit-advisor', 'esg-profile', 'esg-fund-deck', 'delivery-presentation'] as const
type ReportType = typeof KNOWN_TYPES[number]

// In-memory cache with 5-minute TTL — re-fetches after template updates without requiring a redeploy
const CACHE_TTL_MS = 5 * 60 * 1000
const templateCache = new Map<ReportType, { html: string; fetchedAt: number }>()

async function fetchTemplate(report_type: ReportType): Promise<string | null> {
  const cached = templateCache.get(report_type)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.html
  const url = `${REPO}/templates/${report_type}/layout-agent.html`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return cached?.html ?? null  // fall back to stale on fetch error
  const html = await res.text()
  templateCache.set(report_type, { html, fetchedAt: Date.now() })
  return html
}

const app = express()
app.use(express.json())

app.get('/health', async (_req, res) => {
  const checks = await Promise.all(
    KNOWN_TYPES.map(async t => {
      const html = await fetchTemplate(t).catch(() => null)
      return { type: t, available: html !== null }
    })
  )
  res.json({ ok: true, service: 'template-mcp', version: '1.3.0', templates: checks })
})

app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'template-mcp', version: '1.3.0' })

  server.tool(
    'fill_report',
    'Render a Soapbox report by injecting your computed JSON data into the official template. Returns complete HTML ready to display as an artifact. Do NOT write your own HTML — always use this tool.',
    {
      report_type: z.enum(KNOWN_TYPES)
        .describe("Report type. Use 'rsra' for Rapid Sustainability Risk Assessment."),
      data: z.record(z.unknown())
        .describe('Computed report data object. Injected into the template <script id="report-data"> block.'),
    },
    async ({ report_type, data }) => {
      const html = await fetchTemplate(report_type)
      if (!html) {
        return {
          content: [{ type: 'text' as const, text: `Template not yet available for report type: ${report_type}` }],
          isError: true,
        }
      }
      // Validate required sections that render as invisible when missing
      const warnings: string[] = []
      if (report_type === 'rsra') {
        const d = data as Record<string, unknown>
        const sens = d.decarb_sensitivity
        if (!sens || !Array.isArray(sens) || (sens as unknown[]).length === 0) {
          warnings.push('⚠️ MISSING decarb_sensitivity: the sensitivity chart and table will be hidden. Add 3 rows from decarb_plan (e.g. Phase 1 only / Phase 1+2 / Full plan) with: label, total_spend, spend_per_unit, emissions_reduction_pct, noi_impact_annual, value_delta_pct.')
        }
        if (!d.physical_climate_risk) {
          warnings.push('⚠️ MISSING physical_climate_risk: climate hazard section will be hidden.')
        }
        if (!d.ghg_scoping) {
          warnings.push('⚠️ MISSING ghg_scoping: GHG scope section will be hidden.')
        }
      }
      if (report_type === 'esg-profile') {
        const d = data as Record<string, unknown>
        if (!d.sponsor && !d.fund_overview) {
          warnings.push('⚠️ MISSING sponsor and fund_overview: provide one of the two layout roots.')
        }
        if (d.sponsor && !(d.sponsor as Record<string, unknown>).scorecard) {
          warnings.push('⚠️ MISSING sponsor.scorecard: the 4-pillar scorecard + YoY trend will be hidden.')
        }
        if (d.sponsor && !(d.sponsor as Record<string, unknown>).risk_profile) {
          warnings.push('⚠️ MISSING sponsor.risk_profile: transition/physical risk table will be hidden.')
        }
      }

      const json = JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
      const rendered = html.replace(
        /<script id="report-data"[^>]*>[\s\S]*?<\/script>/,
        `<script id="report-data" type="application/json">${json}</script>`
      )

      const resultText = warnings.length > 0
        ? warnings.join('\n') + '\n\n⛔ Fix the above before showing to user. The HTML is attached below:\n\n' + rendered
        : rendered

      return { content: [{ type: 'text' as const, text: resultText }] }
    }
  )

  server.tool(
    'get_report_template',
    'Get the raw HTML report template with the <script id="report-data"> placeholder. Prefer fill_report instead — use this only if you need to inspect the template structure.',
    {
      report_type: z.enum(KNOWN_TYPES)
        .describe("Report type. Use 'rsra' for Rapid Sustainability Risk Assessment."),
    },
    async ({ report_type }) => {
      const html = await fetchTemplate(report_type)
      if (!html) {
        return {
          content: [{ type: 'text' as const, text: `Template not yet available for report type: ${report_type}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: html }] }
    }
  )

  server.tool(
    'export_report_pdf',
    'Render a Soapbox report or slide deck to a paginated PDF and return a 7-day download URL. "report" mode = continuous document (Paged.js: full-bleed cover on page 1, minimized running header on pages 2+, footer with page numbers, keep-together so nothing splits). "deck" mode = a flip slide deck exported one slide per landscape page. Use the SAME data object you would pass to fill_report; pass {} for a static/baked deck. Prefer this over hand-building a PDF.',
    {
      report_type: z.enum(KNOWN_TYPES).describe('Report type / template name (same as fill_report).'),
      data: z.record(z.unknown()).describe('Computed report data object (same as fill_report). Pass {} for a static deck.'),
      title: z.string().optional().describe('Optional title used for the download file name.'),
      mode: z.enum(['auto', 'report', 'deck']).optional()
        .describe("Layout mode; default 'auto' detects deck vs report from the template."),
    },
    async ({ report_type, data, title, mode }) => {
      const html = await fetchTemplate(report_type)
      if (!html) {
        return { content: [{ type: 'text' as const, text: `Template not available for report type: ${report_type}` }], isError: true }
      }
      const json = JSON.stringify(data)
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
      const injected = html.replace(
        /<script id="report-data"[^>]*>[\s\S]*?<\/script>/,
        `<script id="report-data" type="application/json">${json}</script>`
      )
      try {
        const { pdf, mode: used } = await renderPdf(injected, (mode ?? 'auto') as PdfMode)
        const url = await uploadPdf(pdf, `${title || report_type}.pdf`)
        return { content: [{ type: 'text' as const, text:
          `PDF ready — ${used} mode, ${Math.round(pdf.length / 1024)} KB.\nDownload (link valid 7 days):\n${url}` }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `PDF export failed: ${(e as Error).message}` }], isError: true }
      }
    }
  )

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => transport.close())
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

const PORT = parseInt(process.env.PORT ?? '3000', 10)
app.listen(PORT, () => console.log(`template-mcp v1.2.0 listening on port ${PORT}`))
