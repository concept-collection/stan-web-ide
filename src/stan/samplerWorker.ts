// Web worker that runs ONE MCMC chain: instantiates the compiled Stan model
// (a pure-WASI command module from the compile server) and runs it like a
// CLI. Stan's console output arrives on stderr — progress lines are parsed
// into structured reports, the rest streams back as console messages — and
// the draws arrive on stdout as CSV (param-name header + one row per draw).

import type { ChainRunConfig, Progress, WorkerRequest, WorkerResponse } from './protocol';
import { runWasiModule } from './wasi';

function post(message: WorkerResponse): void {
	self.postMessage(message);
}

// Stan progress lines look like (spacing varies):
//   Iteration:  800 / 2000 [ 40%]  (Warmup)
// There is no "Chain [n]" prefix — each module run is a single chain; the
// chain id comes from this worker's config.
function parseProgress(line: string, chainId: number): Progress | undefined {
	const match = line.match(/^Iteration:\s*(\d+)\s*\/\s*(\d+)\s*\[\s*(\d+)%\]\s*\((Warmup|Sampling)\)/);
	if (!match) {
		return undefined;
	}
	return {
		chain: chainId,
		iteration: parseInt(match[1], 10),
		totalIterations: parseInt(match[2], 10),
		percent: parseInt(match[3], 10),
		warmup: match[4] === 'Warmup',
	};
}

/** Splits a byte stream into decoded lines (UTF-8-safe across chunks). */
function lineSplitter(onLine: (line: string) => void): { push(bytes: Uint8Array): void; flush(): void } {
	const decoder = new TextDecoder();
	let pending = '';
	const drain = () => {
		let index;
		while ((index = pending.indexOf('\n')) >= 0) {
			onLine(pending.slice(0, index));
			pending = pending.slice(index + 1);
		}
	};
	return {
		push(bytes) {
			pending += decoder.decode(bytes, { stream: true });
			drain();
		},
		flush() {
			pending += decoder.decode();
			drain();
			if (pending) {
				onLine(pending);
				pending = '';
			}
		},
	};
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/** The driver's stdout: a param-name header, then one CSV row per draw.
 *  Returns draws[param][draw]. */
function parseDrawsCsv(text: string): { paramNames: string[]; draws: number[][] } {
	const lines = text.split('\n').filter((line) => line.length > 0);
	if (lines.length < 2) {
		throw new Error('the model produced no draws');
	}
	const paramNames = lines[0].split(',');
	const draws: number[][] = paramNames.map(() => new Array<number>(lines.length - 1));
	for (let row = 1; row < lines.length; row++) {
		const values = lines[row].split(',');
		for (let p = 0; p < paramNames.length; p++) {
			draws[p][row - 1] = Number(values[p]);
		}
	}
	return { paramNames, draws };
}

async function runChain(module: WebAssembly.Module, config: ChainRunConfig): Promise<void> {
	const stdoutChunks: Uint8Array[] = [];
	const stderrTail: string[] = [];
	const stderr = lineSplitter((line) => {
		const report = parseProgress(line, config.chainId);
		if (report) {
			post({ type: 'progress', report });
			return;
		}
		if (line.trim()) {
			stderrTail.push(line);
			if (stderrTail.length > 5) {
				stderrTail.shift();
			}
			post({ type: 'console', text: line, level: line.startsWith('error:') ? 'error' : 'log' });
		}
	});

	const exitCode = await runWasiModule({
		module,
		args: [
			config.data,
			String(config.seed),
			String(config.chainId),
			String(config.numWarmup),
			String(config.numSamples),
			String(config.initRadius),
			String(config.refresh),
		],
		onStdout: (bytes) => stdoutChunks.push(bytes),
		onStderr: (bytes) => stderr.push(bytes),
	});
	stderr.flush();

	if (exitCode !== 0) {
		const detail = stderrTail.join('\n');
		post({ type: 'error', message: `chain ${config.chainId} failed (exit code ${exitCode})${detail ? `:\n${detail}` : ''}` });
		return;
	}

	const { paramNames, draws } = parseDrawsCsv(new TextDecoder().decode(concatBytes(stdoutChunks)));
	post({ type: 'done', paramNames, draws });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const { module, config } = event.data;
	runChain(module, config).catch((error) => {
		post({ type: 'error', message: `chain ${config.chainId} failed: ${error}` });
	});
};
