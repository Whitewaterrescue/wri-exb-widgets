# WRI Experience Builder Custom Widgets

Built widget bundles hosted on GitHub Pages for registration in ArcGIS Online
(Content > New item > Application > Experience Builder widget > manifest URL).

## Widgets

- **spill-trace** — Spill Trajectory widget. Manifest URL:
  `https://whitewaterrescue.github.io/wri-exb-widgets/spill-trace/manifest.json`

## Embed page (for HOSTED ArcGIS Online ExB — custom widgets are not supported there)

- **`embed/`** — standalone Spill Trajectory app for use via the standard **Embed** widget.
  `https://whitewaterrescue.github.io/wri-exb-widgets/embed/?config=all-grps` (or `?config=snake`)
  Configs live in `configs/*.json`; add one per app. OAuth appid ZTWroggX3c8hdiJo (item 14967d43da434ba1b763b1541d3735c7).

The `spill-trace/` widget bundle remains hosted for ArcGIS ENTERPRISE 11.1+ registration only.

Source lives in the private AppsScript repo (`Initial Response Apps/spill-trace-widget/`)
and the ExB Dev Edition workspace. These are compiled bundles only — no data, no secrets.
