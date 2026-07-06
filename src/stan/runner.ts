import { monaco, type FileRunner, type RunContext, type WorkspaceFileSystem } from 'minwebide';
import { compileStanProgram } from './compile';
import { writeRunOutputs } from './outputs';
import type { StanSampleConfig, WorkerResponse } from './protocol';
import { setRunState, updateChainProgress } from './runEvents';
import { dirnameOf, parseSampleFile, resolveProjectPath, type SampleFileConfig } from './sampleConfig';
import { getServerUrl } from './settings';

// The .sample runner: compile the referenced Stan program on the compile
// server, run NUTS-HMC sampling in a web worker (tinystan), stream progress
// to the output channel (and to the .sample view's progress bars via
// runEvents), then write draws + summary into the output directory.

interface ActiveRun {
	uriKey: string;
	worker: Worker;
	/** Resolves the run() promise; the worker is terminated afterwards. */
	finish: () => void;
	stopped: boolean;
}

export interface StanRunner {
	runner: FileRunner;
	/** Stops the in-flight run, if any. */
	stop(): void;
	dispose(): void;
}

export function createStanRunner(fs: WorkspaceFileSystem): StanRunner {
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

		// 2. referenced files
		const sampleDir = dirnameOf(uri.path);
		const stanPath = resolveProjectPath(sampleDir, config.stan!);
		const dataPath = resolveProjectPath(sampleDir, config.data!);
		const outputDir = resolveProjectPath(sampleDir, config.output_dir!);
		if (outputDir === '/') {
			return fail("'output_dir' must not be the project root (its contents are replaced on each run)");
		}
		for (const [name, path] of [['.sample file', uri.path], ['stan file', stanPath], ['data file', dataPath]] as const) {
			if (path === outputDir || path.startsWith(`${outputDir}/`)) {
				return fail(`'output_dir' (${outputDir}) would overwrite the ${name} (${path})`);
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
		if (!compiled.mainJsUrl) {
			return fail(compiled.error ?? 'compilation failed');
		}

		// 4. sample in a fresh worker
		const seed = config.seed ?? Math.floor(Math.random() * Math.pow(2, 32));
		const sampleConfig: StanSampleConfig = {
			data: dataText,
			num_chains: config.num_chains,
			num_warmup: config.num_warmup,
			num_samples: config.num_samples,
			init_radius: config.init_radius,
			seed,
			refresh: reasonableRefreshRate(config),
			// one thread per chain: chains run in parallel (issue mirrors
			// stan-playground's setting)
			num_threads: config.num_chains,
		};

		setRunState(uriKey, { phase: 'loading', message: 'loading model...' });
		const worker = new Worker(new URL('./samplerWorker.ts', import.meta.url), { type: 'module' });
		const consoleLines: string[] = [];
		let samplingStarted = 0;
		let computeTimeSec = 0;

		await new Promise<void>((resolve) => {
			const current: ActiveRun = { uriKey, worker, finish: resolve, stopped: false };
			active = current;

			worker.onmessage = async (event: MessageEvent<WorkerResponse>) => {
				if (current.stopped) {
					return;
				}
				const message = event.data;
				switch (message.type) {
					case 'loaded': {
						output.info(`model loaded (Stan v${message.stanVersion}); sampling: ${config.num_chains} chains × (${config.num_warmup} warmup + ${config.num_samples} samples), seed ${seed}`);
						setRunState(uriKey, { phase: 'sampling', message: 'sampling...' });
						samplingStarted = performance.now();
						worker.postMessage({ type: 'sample', config: sampleConfig });
						break;
					}
					case 'progress': {
						const r = message.report;
						updateChainProgress(uriKey, config.num_chains, r);
						const line = `Chain ${r.chain} Iteration: ${r.iteration} / ${r.totalIterations} [${String(r.percent).padStart(3)}%] (${r.warmup ? 'Warmup' : 'Sampling'})`;
						consoleLines.push(line);
						output.appendLine(line);
						break;
					}
					case 'console': {
						consoleLines.push(message.text);
						output.appendLine(message.text);
						break;
					}
					case 'done': {
						computeTimeSec = (performance.now() - samplingStarted) / 1000;
						setRunState(uriKey, { phase: 'writing', message: 'writing outputs...' });
						try {
							const written = await writeRunOutputs(fs, outputDir, {
								draws: message.draws,
								paramNames: message.paramNames,
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
						} catch (error) {
							fail(`failed to write outputs: ${error}`);
						}
						resolve();
						break;
					}
					case 'error': {
						fail(message.message);
						resolve();
						break;
					}
				}
			};
			worker.onerror = (event) => {
				fail(`worker error: ${event.message ?? 'failed to load'}`);
				resolve();
			};
			worker.postMessage({ type: 'load', mainJsUrl: compiled.mainJsUrl });
		}).finally(() => {
			worker.terminate();
			if (active?.worker === worker) {
				active = undefined;
			}
		});
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

/** Progress lines roughly every 2.5% of total iterations (min every 15). */
function reasonableRefreshRate(config: SampleFileConfig): number {
	const total = (config.num_samples + config.num_warmup) * config.num_chains;
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
