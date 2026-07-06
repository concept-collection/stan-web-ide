// Web worker that loads a compiled Stan model (the emscripten module built
// by the compile server) via tinystan and runs NUTS-HMC sampling. Mirrors
// stan-playground's StanModelWorker: progress is parsed out of Stan's
// stdout lines; everything else streams back as console messages.

import StanModel from 'tinystan';
import type { Progress, WorkerRequest, WorkerResponse } from './protocol';

let model: StanModel | undefined;

function post(message: WorkerResponse): void {
	self.postMessage(message);
}

// The compiled models are threaded emscripten ES6 builds: they spawn their
// pthread pool with new Worker(new URL('main.js', import.meta.url)), which
// throws for a cross-origin script (the compile server). Workers cannot be
// *constructed* from a cross-origin URL, but a module worker may *import*
// one via CORS — so route cross-origin worker scripts through a same-origin
// blob trampoline.
const NativeWorker = Worker;
(self as { Worker: unknown }).Worker = class extends NativeWorker {
	constructor(scriptUrl: string | URL, options?: WorkerOptions) {
		const resolved = new URL(scriptUrl, self.location.href);
		if (resolved.origin !== self.location.origin) {
			const blob = new Blob([`import ${JSON.stringify(resolved.href)};`], { type: 'text/javascript' });
			super(URL.createObjectURL(blob), options);
		} else {
			super(scriptUrl, options);
		}
	}
};

// Stan progress lines look like (spacing varies):
//   Chain [1] Iteration: 2000 / 2000 [100%]  (Sampling)
//   Chain [2] Iteration:  800 / 2000 [ 40%]  (Warmup)
// With a single chain the "Chain [x]" prefix is omitted.
function parseProgress(line: string): Progress {
	if (line.startsWith('Iteration:')) {
		line = 'Chain [1] ' + line;
	}
	line = line.replace(/\[|\]/g, '');
	const parts = line.split(/\s+/);
	return {
		chain: parseInt(parts[1], 10),
		iteration: parseInt(parts[3], 10),
		totalIterations: parseInt(parts[5], 10),
		percent: parseInt(parts[6].slice(0, -1), 10),
		warmup: parts[7] === '(Warmup)',
	};
}

function onPrint(text: string): void {
	if (!text) {
		return;
	}
	if (text.startsWith('Chain') || text.startsWith('Iteration:')) {
		const report = parseProgress(text);
		if (Number.isFinite(report.chain) && Number.isFinite(report.iteration)) {
			post({ type: 'progress', report });
			return;
		}
	}
	post({ type: 'console', text, level: 'log' });
}

function onPrintError(text: string): void {
	if (text) {
		post({ type: 'console', text, level: 'error' });
	}
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	const message = event.data;
	switch (message.type) {
		case 'load': {
			if (!self.crossOriginIsolated) {
				post({
					type: 'console',
					text: 'warning: not cross-origin isolated — SharedArrayBuffer is unavailable and the threaded Stan module may fail to load',
					level: 'error',
				});
			}
			(async () => {
				const js = await import(/* @vite-ignore */ message.mainJsUrl);
				model = await StanModel.load(js.default, onPrint, onPrintError);
				post({ type: 'loaded', stanVersion: model.stanVersion() });
			})().catch((error) => {
				post({ type: 'error', message: `failed to load compiled model: ${error}` });
			});
			break;
		}
		case 'sample': {
			if (!model) {
				post({ type: 'error', message: 'model is not loaded' });
				return;
			}
			try {
				const { paramNames, draws } = model.sample(message.config);
				post({ type: 'done', draws, paramNames });
			} catch (error) {
				post({ type: 'error', message: String(error) });
			}
			break;
		}
	}
};
