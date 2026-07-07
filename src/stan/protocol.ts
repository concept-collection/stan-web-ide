// Message protocol between the app and the per-chain sampler workers.

/** One chain's run configuration — maps onto the compiled model's argv:
 *  <data_json> <seed> <chain_id> <num_warmup> <num_samples> <init_radius>
 *  <refresh>. Unset sampler options use the driver's defaults (diagonal
 *  metric, adapt_delta 0.8, max_depth 10, ... — same as tinystan's). */
export interface ChainRunConfig {
	/** Contents of the data JSON file. */
	data: string;
	/** Same seed for every chain; the chain id differentiates the streams
	 *  (CmdStan convention). */
	seed: number;
	/** 1-based. */
	chainId: number;
	numWarmup: number;
	numSamples: number;
	initRadius: number;
	/** Iterations between progress lines. */
	refresh: number;
}

export interface Progress {
	chain: number;
	iteration: number;
	totalIterations: number;
	percent: number;
	warmup: boolean;
}

export type WorkerRequest = {
	type: 'run';
	/** The compiled model (structured-cloned; workers share the compiled
	 *  code and instantiate their own 256 MiB memory). */
	module: WebAssembly.Module;
	config: ChainRunConfig;
};

export type WorkerResponse =
	| { type: 'progress'; report: Progress }
	| { type: 'console'; text: string; level: 'log' | 'error' }
	/** draws[param][draw] for this worker's single chain. */
	| { type: 'done'; paramNames: string[]; draws: number[][] }
	| { type: 'error'; message: string };
