# stan web IDE

Run [Stan](https://mc-stan.org) sampling in your browser, inside a VS
Code-style IDE built on [minwebide](https://github.com/magland/minwebide).
Projects live in your browser's IndexedDB. Models compile on a remote
[stan-wasm-wasi](https://github.com/magland/stan-wasm-wasi) server to pure
WASI modules; sampling itself runs locally, one web worker per chain, each
invoking the module CLI-style through a small WASI shim.

**Live site:** https://concept-collection.github.io/stan-web-ide/

## How it works

A project holds `.stan` programs, `.json` data files, and `.sample` files. A
`.sample` file is a YAML description of one sampling run:

```yaml
stan: linear.stan      # the Stan program
data: data.json        # the data
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
Stan's console output to the **Output** panel, and writes into the output
directory — always `<name>.out` next to the `.sample` file (so
`fit.sample` → `fit.out`, replaced on each run):

- `chain_1.csv` … one CSV per chain, header = parameter names, one row per draw
- `summary.csv` — mean, MCSE, sd, 5%/50%/95%, ESS, ESS/s, split-Rhat per
  parameter (via [mcmc-stats](https://github.com/flatironinstitute/mcmc-stats.js))
- `console.txt` — the sampler's console output
- `run.json` — the exact configuration used (including the resolved seed);
  written last, so it doubles as the run's completion marker

When a run finishes, a **results dashboard** opens on `run.json`: tabs for
the summary table (Rhat highlighted when > 1.01), histograms, trace plots,
scatter plots, a draws table, and the console — plots via lazily-loaded
[plotly](https://plotly.com/javascript/). It reads the sibling CSVs, so it
reopens in any later session: click **View results** on the `.sample` form,
or `run.json` in the output folder.

The `.stan` editor has syntax highlighting plus diagnostics, hover docs,
completion, and auto-format from
[stan-language-server](https://github.com/tomatitito/stan-language-server)
(stanc3 compiled to JS, running in a worker).

## The compilation server

Compiling Stan to WebAssembly needs a server; everything else is local. The
status bar shows the configured server (click it to change; persisted in the
browser). The default is `https://stan-wasm-wasi.fly.dev`, a hosted
[stan-wasm-wasi](https://github.com/magland/stan-wasm-wasi) instance — it
allows any origin (CORS), caches compiled models by source hash, and
auto-stops when idle, so the first compile after an idle period pays a
~30 s cold start. To run one locally instead:

```sh
docker build -t stan-wasm-wasi https://github.com/magland/stan-wasm-wasi.git
docker run --rm -p 8083:8080 stan-wasm-wasi
```

then set the server URL to `http://localhost:8083`.

The compiled models are pure-WASI command modules (`main.wasm`): each run of
the module executes one MCMC chain (CmdStan seed/chain-id convention), with
draws on stdout as CSV and Stan's console on stderr. Chains run in parallel
workers, so no threads, no `SharedArrayBuffer`, and no cross-origin
isolation are needed.

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
- `npm run smoke` — headless end-to-end test against the built bundle; when
  the default compile server is reachable it also compiles and samples for
  real
- `node scripts/dev-check.mjs` — quick checks against a running dev server

CI checks out `magland/minwebide` next to this repo, installs both, builds,
and publishes `dist/` to GitHub Pages.
