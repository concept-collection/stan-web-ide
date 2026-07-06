# stan web IDE

Run [Stan](https://mc-stan.org) sampling in your browser, inside a VS
Code-style IDE built on [minwebide](https://github.com/magland/minwebide).
Projects live in your browser's IndexedDB. Models compile on a remote
[stan-wasm-server](https://github.com/flatironinstitute/stan-playground/tree/main/backend);
sampling itself runs locally in a web worker with
[tinystan](https://github.com/WardBrian/tinystan), chains in parallel
threads.

**Live site:** https://concept-collection.github.io/stan-web-ide/

## How it works

A project holds `.stan` programs, `.json` data files, and `.sample` files. A
`.sample` file is a YAML description of one sampling run:

```yaml
stan: linear.stan      # the Stan program
data: data.json        # the data
output_dir: out/fit    # results are written here (replaced on each run)
num_chains: 4          # optional; defaults 4 / 1000 / 1000 / 2.0 / random
num_warmup: 1000
num_samples: 1000
init_radius: 2.0
seed: 42               # omit for a random seed
```

Paths are relative to the `.sample` file (leading `/` = project root).
Opening a `.sample` file shows a **form view** — file pickers, sampling
parameters, a Run button, and per-chain progress bars. The form edits the
underlying YAML (tab menu → *Reopen as Text Editor* for the raw file); the
tab bar's ▶/⏹ runs and stops the same way. Runs use current editor contents,
saved or not.

A run compiles the program (server-side, cached by source hash), streams
Stan's console output to the **Output** panel, and writes into
`output_dir`:

- `chain_1.csv` … one CSV per chain, header = parameter names, one row per draw
- `summary.csv` — mean, MCSE, sd, 5%/50%/95%, ESS, ESS/s, split-Rhat per
  parameter (via [mcmc-stats](https://github.com/flatironinstitute/mcmc-stats.js))
- `sampling_opts.json` — the exact configuration used (including the
  resolved seed)
- `console.txt` — the sampler's console output

The `.stan` editor has syntax highlighting plus diagnostics, hover docs,
completion, and auto-format from
[stan-language-server](https://github.com/tomatitito/stan-language-server)
(stanc3 compiled to JS, running in a worker).

## The compilation server

Compiling Stan to WebAssembly needs a server; everything else is local. The
status bar shows the configured server (click it to change; persisted in the
browser). The default is `http://localhost:8083` — run one with:

```sh
docker run -p 8083:8080 -it ghcr.io/flatironinstitute/stan-wasm-server:latest
```

**CORS**: the server's allowlist must include the page's origin. The stock
image allows `http://127.0.0.1:3000` and `http://127.0.0.1:4173`, which
match this app's dev and preview ports — open the `127.0.0.1` URL, not
`localhost`. To serve other origins (like the live site above), host a
server whose allowlist includes them.

Threaded sampling requires cross-origin isolation (`SharedArrayBuffer`):
dev/preview send COOP/COEP headers; the GitHub Pages deployment uses
`coi-serviceworker.js`, injected at build time only.

## Development

minwebide is consumed as a sibling checkout (`file:../minwebide`):

```sh
git clone https://github.com/magland/minwebide ../minwebide
(cd ../minwebide && npm install)   # fetches the pinned VS Code source
npm install
npm run dev                        # http://127.0.0.1:3000
```

- `npm run build` — static bundle in `dist/`
- `npm run typecheck` — typechecks app code (vendor diagnostics suppressed)
- `npm run smoke` — headless end-to-end test against the built bundle; with
  a compile server on `localhost:8083` it also compiles and samples for real
- `node scripts/dev-check.mjs` — quick checks against a running dev server

CI checks out `magland/minwebide` next to this repo, installs both, builds,
and publishes `dist/` to GitHub Pages.
