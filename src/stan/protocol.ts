// Message protocol between the app and the sampler web worker.

/** The config passed to tinystan's model.sample() (unset options use
 *  tinystan defaults: diagonal metric, adapt_delta 0.8, max_depth 10, ...). */
export interface StanSampleConfig {
	/** Contents of the data JSON file. */
	data: string;
	num_chains: number;
	num_warmup: number;
	num_samples: number;
	init_radius: number;
	seed: number;
	/** Iterations between progress lines. */
	refresh: number;
	/** One thread per chain runs chains in parallel (needs SharedArrayBuffer). */
	num_threads: number;
}

export interface Progress {
	chain: number;
	iteration: number;
	totalIterations: number;
	percent: number;
	warmup: boolean;
}

export type WorkerRequest =
	| { type: 'load'; mainJsUrl: string }
	| { type: 'sample'; config: StanSampleConfig };

export type WorkerResponse =
	| { type: 'loaded'; stanVersion: string }
	| { type: 'progress'; report: Progress }
	| { type: 'console'; text: string; level: 'log' | 'error' }
	| { type: 'done'; draws: number[][]; paramNames: string[] }
	| { type: 'error'; message: string };
