# soapbox-reporting-mcp

MCP server that renders Soapbox report templates for `fill_report` / `get_report_template` / `export_report_pdf`, plus the template library it serves.

This repo was migrated from `soapboxbuild/soapbox-agent` on 2026-08-15. `soapbox-agent` is being retired; this repo receives the still-needed parts of it (the deployed `template-mcp` service and the templates it serves) as a clean starting point. The old repo is untouched and keeps running as the live service until a separate, explicit cutover happens later.

## Report types served

- `decarb-capital-plan`
- `rehab-capital-plan`
- `rsra`
- `portfolio-analysis`
- `crrem`
- `decarb`
- `delivery-presentation`
- `esg-profile`
- `esg-fund-deck`

(`templates/assets/` holds shared image assets — the Audette logomark — used across the templates above; it isn't a report type itself.)

## Layout

- `src/` — the MCP server (formerly `template-mcp/src` in `soapbox-agent`). Exposes `fill_report`, `get_report_template`, and `export_report_pdf` over streamable-HTTP at `/mcp`, plus a `/health` check.
- `templates/` — the HTML report templates above, each a self-contained `layout-agent.html` (JS-driven, populated via a `<script id="report-data">` JSON block) plus `schema.json` / `example-data.json` / `xlsx.json` where applicable.
- `test/` — regression tests for the `decarb-capital-plan` and `decarb` templates (render via jsdom, assert on the populated DOM).
- `Dockerfile`, `package.json`, `tsconfig.json` — the deployed service's build, matching `template-mcp`'s originals.

## Known open item (do not fix here — flagged for the cutover step)

`src/index.ts` and `src/render-pdf.ts` fetch templates and PDF-export assets over HTTP from a hardcoded `REPO` constant pointing at `https://raw.githubusercontent.com/soapboxbuild/soapbox-agent/main` — they do **not** read from this repo's own `templates/` directory at runtime. This was preserved as-is (lift, not a rewrite) so the migrated code's behavior is unchanged. It means this repo's `templates/` currently only serves local tests; the running service still depends on `soapbox-agent` staying up. Repointing `REPO` (and sourcing `skills/report-pdf/assets/print.css` + `paged.polyfill.js`, which were not migrated here since the `report-pdf` skill was dropped) is cutover work, not part of this migration.

## Local development

```bash
npm install
npm run build   # tsc -> dist/
npm start        # node dist/index.js
npm run dev       # tsx src/index.ts, no build step
npm test          # node --test
```
