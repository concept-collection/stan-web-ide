// Shared run state per .sample file, connecting the runner (which drives a
// run) with the form editor view (which shows the run button, per-chain
// progress bars, and status). Keyed by the file URI.

import type { Progress } from './protocol';

export type RunPhase = 'idle' | 'compiling' | 'loading' | 'sampling' | 'writing' | 'done' | 'failed';

export interface ChainProgress {
	iteration: number;
	totalIterations: number;
	warmup: boolean;
}

export interface RunState {
	phase: RunPhase;
	/** Status detail or error message. */
	message?: string;
	/** Per-chain progress (index 0 = chain 1), while sampling. */
	chains?: ChainProgress[];
	computeTimeSec?: number;
}

type Listener = (uriKey: string, state: RunState) => void;

const states = new Map<string, RunState>();
const listeners = new Set<Listener>();

export function getRunState(uriKey: string): RunState {
	return states.get(uriKey) ?? { phase: 'idle' };
}

export function setRunState(uriKey: string, state: RunState): void {
	states.set(uriKey, state);
	for (const listener of listeners) {
		listener(uriKey, state);
	}
}

export function updateChainProgress(uriKey: string, numChains: number, report: Progress): void {
	const state = getRunState(uriKey);
	const chains = state.chains ?? Array.from({ length: numChains }, () => ({
		iteration: 0,
		totalIterations: report.totalIterations,
		warmup: true,
	}));
	if (report.chain >= 1 && report.chain <= chains.length) {
		chains[report.chain - 1] = {
			iteration: report.iteration,
			totalIterations: report.totalIterations,
			warmup: report.warmup,
		};
	}
	setRunState(uriKey, { ...state, phase: 'sampling', chains });
}

export function onDidChangeRunState(listener: Listener): { dispose(): void } {
	listeners.add(listener);
	return { dispose: () => listeners.delete(listener) };
}
