import { monaco, type FileRunner, type RunContext, type WorkspaceFileSystem } from 'minwebide';
import { compileStanProgram } from './compile';
import { writeRunOutputs } from './outputs';
import type { ChainRunConfig, WorkerResponse } from './protocol';
import { setRunState, updateChainProgress } from './runEvents';
import { dirnameOf, outputDirFor, parseSampleFile, resolveProjectPath, type SampleFileConfig } from './sampleConfig';
import { getServerUrl } from './settings';

// The .sample runner: compile the referenced Stan program on the compile
// server (to a pure-WASI module), run NUTS-HMC sampling locally — one web
// worker per chain, each invoking the module CLI-style — stream progress to
// the output channel (and to the .sample view's progress bars via
// runEvents), then write draws + summary into the output directory.

interface ActiveRun {
	uriKey: string;
	workers: Worker[];
	/** Resolves the run() promise; the workers are terminated afterwards. */
	finish: () => void;
	stopped: boolean;
}

export interface StanRunner {
	runner: FileRunner;
	/** Stops the in-flight run, if any. */
	stop(): void;
	dispose(): void;
}

export function createStanRunner(fs: WorkspaceFileSystem, openFile: (path: string) => Promise<unknown>): StanRunner {
	let active: ActiveRun | undefined;

	const run = async ({ uri, getText, output }: RunContext): Promise<void> => {
		const uriKey = uri.toString();
		const fail = (message: string): void => {
			output.error(message);
			setRunState(uriKey, { phase: 'failed', message });
		};

		output.appendLine('');
		output.info(`run ${uri.path}`);

		// 1. the .sample config
		const { config, errors, warnings } = parseSampleFile(await getText());
		for (const warning of warnings) {
			output.warn(warning);
		}
		if (errors.length > 0) {
			for (const error of errors) {
				output.error(error);
			}
			setRunState(uriKey, { phase: 'failed', message: errors[0] });
			return;
		}

		// 2. referenced files; the output directory is derived from the
		// .sample file's name (fit.sample → fit.out next to it)
		const sampleDir = dirnameOf(uri.path);
		const stanPath = resolveProjectPath(sampleDir, config.stan!);
		const dataPath = resolveProjectPath(sampleDir, config.data!);
		const outputDir = outputDirFor(uri.path);
		for (const [name, path] of [['stan file', stanPath], ['data file', dataPath]] as const) {
			if (path === outputDir || path.startsWith(`${outputDir}/`)) {
				return fail(`the output directory (${outputDir}) would overwrite the ${name} (${path}) — move it out of ${outputDir}`);
			}
		}

		const stanText = await readProjectText(fs, stanPath);
		if (stanText === undefined) {
			return fail(`Stan program not found: ${stanPath}`);
		}
		const dataText = await readProjectText(fs, dataPath);
		if (dataText === undefined) {
			return fail(`data file not found: ${dataPath}`);
		}
		try {
			JSON.parse(dataText);
		} catch (error) {
			return fail(`data file ${dataPath} is not valid JSON: ${error instanceof Error ? error.message : error}`);
		}

		// 3. compile (server-side, cached by source hash)
		setRunState(uriKey, { phase: 'compiling', message: 'compiling...' });
		const serverUrl = getServerUrl();
		output.info(`compiling ${stanPath} (server: ${serverUrl})`);
		const compiled = await compileStanProgram(serverUrl, stanText, (status) => {
			output.info(`[compile] ${status}`);
			setRunState(uriKey, { phase: 'compiling', message: status });
		});
		if (!compiled.mainWasmUrl) {
			return fail(compiled.error ?? 'compilation failed');
		}

		// 4. download + compile the wasm module once; WebAssembly.Module is
		// structured-cloneable, so the chain workers share the compiled code
		setRunState(uriKey, { phase: 'loading', message: 'loading model...' });
		let module: WebAssembly.Module;
		let moduleBytes = 0;
		try {
			const response = await fetch(compiled.mainWasmUrl);
			if (!response.ok) {
				return fail(`failed to download compiled model: ${response.status} ${response.statusText}`);
			}
			const buffer = await response.arrayBuffer();
			moduleBytes = buffer.byteLength;
			module = await WebAssembly.compile(buffer);
		} catch (error) {
			return fail(`failed to load compiled model: ${error}`);
		}

		// 5. sample: one worker per chain (CmdStan convention — same seed,
		// chain ids 1..n differentiate the streams)
		const seed = config.seed ?? Math.floor(Math.random() * Math.pow(2, 32));
		output.info(`model loaded (${(moduleBytes / 1024).toFixed(0)} kB wasm); sampling: ${config.num_chains} chains × (${config.num_warmup} warmup + ${config.num_samples} samples), seed ${seed}`);
		setRunState(uriKey, { phase: 'sampling', message: 'sampling...' });

		const workers = Array.from({ length: config.num_chains }, () =>
			new Worker(new URL('./samplerWorker.ts', import.meta.url), { type: 'module' }));
		const chainResults: ({ paramNames: string[]; draws: number[][] } | undefined)[] = new Array(config.num_chains);
		const consoleLines: string[] = [];
		let failed = false;
		const samplingStarted = performance.now();

		const current: ActiveRun = { uriKey, workers, finish: () => {}, stopped: false };
		await new Promise<void>((resolve) => {
			current.finish = resolve;
			active = current;
			let remaining = config.num_chains;

			workers.forEach((worker, index) => {
				const chainId = index + 1;
				worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
					if (current.stopped || failed) {
						return;
					}
					const message = event.data;
					switch (message.type) {
						case 'progress': {
							const r = message.report;
							updateChainProgress(uriKey, config.num_chains, r);
							const line = `Chain ${r.chain} Iteration: ${r.iteration} / ${r.totalIterations} [${String(r.percent).padStart(3)}%] (${r.warmup ? 'Warmup' : 'Sampling'})`;
							consoleLines.push(line);
							output.appendLine(line);
							break;
						}
						case 'console': {
							const line = config.num_chains > 1 ? `[chain ${chainId}] ${message.text}` : message.text;
							consoleLines.push(line);
							output.appendLine(line);
							break;
						}
						case 'done': {
							chainResults[index] = { paramNames: message.paramNames, draws: message.draws };
							remaining -= 1;
							if (remaining === 0) {
								resolve();
							}
							break;
						}
						case 'error': {
							failed = true;
							fail(message.message);
							resolve();
							break;
						}
					}
				};
				worker.onerror = (event) => {
					if (!current.stopped && !failed) {
						failed = true;
						fail(`worker error: ${event.message ?? 'failed to load'}`);
						resolve();
					}
				};
				const chainConfig: ChainRunConfig = {
					data: dataText,
					seed,
					chainId,
					numWarmup: config.num_warmup,
					numSamples: config.num_samples,
					initRadius: config.init_radius,
					refresh: reasonableRefreshRate(config),
				};
				worker.postMessage({ type: 'run', module, config: chainConfig });
			});
		}).finally(() => {
			for (const worker of workers) {
				worker.terminate();
			}
			if (active === current) {
				active = undefined;
			}
		});

		if (current.stopped || failed) {
			return; // already reported
		}
		if (chainResults.some((result) => !result)) {
			return; // finished early without all chains (e.g. disposed mid-run)
		}

		// 6. merge chains and write outputs: draws[param][draw], chains
		// concatenated along the draw axis (the layout outputs.ts expects)
		const computeTimeSec = (performance.now() - samplingStarted) / 1000;
		const results = chainResults as { paramNames: string[]; draws: number[][] }[];
		const paramNames = results[0].paramNames;
		const draws = paramNames.map((_, p) => {
			const merged: number[] = [];
			for (const chain of results) {
				merged.push(...chain.draws[p]);
			}
			return merged;
		});

		setRunState(uriKey, { phase: 'writing', message: 'writing outputs...' });
		try {
			const written = await writeRunOutputs(fs, outputDir, {
				draws,
				paramNames,
				numChains: config.num_chains,
				consoleText: consoleLines.join('\n') + '\n',
				samplingOpts: {
					stan: stanPath,
					data: dataPath,
					output_dir: outputDir,
					num_chains: config.num_chains,
					num_warmup: config.num_warmup,
					num_samples: config.num_samples,
					init_radius: config.init_radius,
					seed,
					compute_time_sec: Number(computeTimeSec.toFixed(3)),
				},
				computeTimeSec,
			});
			output.info(`sampling completed in ${computeTimeSec.toFixed(2)}s — wrote ${written.length} files to ${outputDir}`);
			setRunState(uriKey, { phase: 'done', message: `completed in ${computeTimeSec.toFixed(2)}s → ${outputDir}`, computeTimeSec });
			// open (or refresh) the results dashboard
			openFile(`${outputDir}/run.json`).catch(() => {});
		} catch (error) {
			fail(`failed to write outputs: ${error}`);
		}
	};

	const stop = (): void => {
		if (active) {
			active.stopped = true;
			setRunState(active.uriKey, { phase: 'failed', message: 'stopped' });
			active.finish();
		}
	};

	return {
		runner: {
			id: 'stan.sample',
			displayName: 'Run sampling',
			selector: [{ filenamePattern: '*.sample' }],
			run,
			stop,
		},
		stop,
		dispose(): void {
			active?.finish();
		},
	};
}

/** Progress lines roughly every 2.5% of a chain's iterations (min every 15). */
function reasonableRefreshRate(config: SampleFileConfig): number {
	const total = config.num_samples + config.num_warmup;
	const nearestTen = Math.round(Math.floor(total / 40) / 10) * 10;
	return Math.max(15, nearestTen);
}

/** Reads a project file as text, preferring an open editor's contents. */
async function readProjectText(fs: WorkspaceFileSystem, path: string): Promise<string | undefined> {
	const uri = fs.root.with({ path });
	const model = monaco.editor.getModel(uri);
	if (model) {
		return model.getValue();
	}
	if (!(await fs.fileService.exists(uri))) {
		return undefined;
	}
	return (await fs.fileService.readFile(uri)).value.toString();
}
