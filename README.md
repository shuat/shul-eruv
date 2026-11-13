# Brookwood 1 Eruv

Interactive eruv map for Jackson, NJ, built with React, TypeScript, Vite, and Leaflet.

[Open the live map](https://shul-eruv.vercel.app)

## How It Works

- **Print letter** opens a preview for 8.5 x 11 paper with adjustable map zoom.
- **Edit map** lets you move lines and text boxes, edit labels, and snap points to roads. Uncheck **Lock map position** to pan.
- **Export JSON** downloads your changes; **Import JSON** loads them again. Live-site edits stay in your browser session and do not change the published map.
- To publish a configuration, replace `src/eruvConfig.json`, then rebuild and deploy.

Confirm current eruv status and exact boundaries with the eruv committee before relying on the map.

## Run Locally

```sh
npm install
npm run dev
```

Checks: `npm test` (Node.js 22.6+), `npm run build`.

## Author and License

Author: Yehoshua Talansky.

The application source code is copyright © 2026 Yehoshua Talansky and is licensed under the [GNU General Public License, version 3](LICENSE) (`GPL-3.0-only`).

OpenStreetMap data, including `src/roads.json`, is credited to [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) and licensed under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Third-party dependencies retain their own licenses.

The app's **Source code** link points to the deployed commit on GitHub when Vercel provides the Git metadata. For other deployments, set `VITE_SOURCE_CODE_URL` at build time to a public URL for the source matching that build.
