// Files seeded into new projects.

const readme = `# stan sample project

Bayesian linear regression, run entirely in your browser.

- \`linear.stan\` — the model (with syntax checking, hover docs, completion,
  and auto-format from the Stan language server).
- \`data.json\` — the data: 20 noisy points around y = 2 + 1.5 x.
- \`fit.sample\` — a sampling run: which program, which data, sampling
  parameters, and the output directory. Opens as a form; press
  **Run sampling** there (or ▶ in the tab bar). Reopen as raw YAML via the
  tab context menu.
- \`quick.sample\` — the same fit with fewer iterations and a random seed.

Compiling the Stan program needs a **compilation server** (sampling itself
runs locally, in a web worker). The status bar shows the configured server;
click it to change. To run one on your machine:

    docker run -p 8083:8080 -it ghcr.io/flatironinstitute/stan-wasm-server:latest

When a run finishes, its output directory (e.g. \`out/fit/\`) appears in the
Explorer: \`chain_*.csv\` (one row per draw), \`summary.csv\` (mean, sd,
percentiles, ESS, Rhat per parameter), \`sampling_opts.json\`, and
\`console.txt\`.

Edits save with **Ctrl+S** and persist in your browser. Runs use current
editor contents, saved or not.
`;

const linearStan = `// Bayesian linear regression: y ~ normal(alpha + beta * x, sigma)
data {
  int<lower=0> N;
  vector[N] x;
  vector[N] y;
}
parameters {
  real alpha;
  real beta;
  real<lower=0> sigma;
}
model {
  alpha ~ normal(0, 5);
  beta ~ normal(0, 5);
  sigma ~ normal(0, 2);
  y ~ normal(alpha + beta * x, sigma);
}
generated quantities {
  // posterior predictive draw at x = 6
  real y_at_6 = normal_rng(alpha + beta * 6, sigma);
}
`;

const dataJson = `{
  "N": 20,
  "x": [0.17, 0.41, 0.77, 0.96, 1.23, 1.46, 1.66, 1.8, 2.01, 2.32,
        2.59, 3.05, 3.21, 3.45, 3.61, 3.83, 4.03, 4.52, 4.75, 5.0],
  "y": [2.13, 2.9, 3.51, 3.69, 3.41, 4.05, 4.56, 3.9, 3.5, 5.17,
        6.14, 6.62, 6.55, 7.31, 7.34, 6.33, 8.81, 8.79, 8.56, 9.16]
}
`;

const fitSample = `# A sampling run. This file opens as a form; use the tab context menu to
# edit the raw YAML. Paths are relative to this file.
stan: linear.stan
data: data.json
output_dir: out/fit
num_chains: 4
num_warmup: 1000
num_samples: 1000
seed: 42
`;

const quickSample = `# A quicker look: fewer iterations, random seed each run.
stan: linear.stan
data: data.json
output_dir: out/quick
num_chains: 2
num_warmup: 200
num_samples: 200
`;

export const sampleWorkspace: Record<string, string> = {
	'/README.md': readme,
	'/linear.stan': linearStan,
	'/data.json': dataJson,
	'/fit.sample': fitSample,
	'/quick.sample': quickSample,
};

const emptyStan = `// Write your Stan program here.
parameters {
  real mu;
}
model {
  mu ~ normal(0, 1);
}
`;

export const emptyWorkspace: Record<string, string> = {
	'/main.stan': emptyStan,
	'/data.json': '{}\n',
	'/fit.sample': `stan: main.stan\ndata: data.json\noutput_dir: out/fit\n`,
};
