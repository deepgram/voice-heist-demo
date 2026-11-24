# Deepgram brand UI assets

These files are copied from Deepgram's brand UI kit, `@deepgram-devs/dg-brand-ui` **v0.6.0** (`assets/` in the kit repo). They're committed here because the kit repo is private, so the Docker build and CI can't fetch it.

| File | What it is |
| --- | --- |
| `brand.css` | The kit's theme as plain CSS: color and font tokens (`var(--color-magenta)`, `var(--font-mono)`), the `label`, `glass`, and `stage-glow` utilities. Loads Work Sans and Azeret Mono from Google Fonts. |
| `textures/` | The stage and landing textures `brand.css` points at. |
| `logos/deepgram.svg` | The Deepgram logo, light, for dark backgrounds. |
| `ring-element/deepgram-voice-ring.js` | `<deepgram-voice-ring>`, the kit's voice ring as a Web Component (Three.js bundled in). |

Vite copies `client/public/` into `dist/` as is, so the pages link these at `/vdui/...`.

Don't edit these files. To upgrade the kit, copy the same files again from the new tag's `assets/` folder (or run `npx vdui-assets client/public/vdui` in a checkout that has the kit installed) and update the version above.
