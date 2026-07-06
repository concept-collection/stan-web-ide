import type { WorkspaceFileSystem } from 'minwebide';
import {
	effective_sample_size,
	mean,
	percentile,
	split_potential_scale_reduction,
	std_deviation,
} from 'mcmc-stats';

// Writes a completed run into the .sample file's output directory:
//
//   <output_dir>/chain_1.csv ...   one CSV per chain, header = parameter names
//   <output_dir>/summary.csv       mean, MCSE, sd, percentiles, ESS, Rhat
//   <output_dir>/sampling_opts.json  the exact configuration used
//   <output_dir>/console.txt       sampler console output
//
// (the per-chain CSV layout matches stan-playground's "download multiple
// CSVs" export)

export interface RunOutputs {
	/** draws[param][draw], chains concatenated along the draw axis (tinystan). */
	draws: number[][];
	paramNames: string[];
	numChains: number;
	consoleText: string;
	samplingOpts: Record<string, unknown>;
	computeTimeSec: number;
}

export async function writeRunOutputs(fs: WorkspaceFileSystem, outputDir: string, run: RunOutputs): Promise<string[]> {
	const written: string[] = [];
	const write = async (name: string, contents: string) => {
		const path = `${outputDir}/${name}`;
		await fs.writeFile(path, contents);
		written.push(path);
	};

	// clear previous results so the directory holds exactly this run
	await fs.deleteFile(outputDir);

	const numDraws = run.draws[0]?.length ?? 0;
	const perChain = Math.floor(numDraws / run.numChains);

	for (let chain = 0; chain < run.numChains; chain++) {
		const lines = [run.paramNames.join(',')];
		for (let draw = chain * perChain; draw < (chain + 1) * perChain; draw++) {
			lines.push(run.draws.map(paramDraws => String(paramDraws[draw])).join(','));
		}
		await write(`chain_${chain + 1}.csv`, lines.join('\n') + '\n');
	}

	await write('summary.csv', summaryCsv(run));
	await write('sampling_opts.json', JSON.stringify(run.samplingOpts, null, 2) + '\n');
	await write('console.txt', run.consoleText);

	return written;
}

function summaryCsv(run: RunOutputs): string {
	const numDraws = run.draws[0]?.length ?? 0;
	const perChain = Math.floor(numDraws / run.numChains);

	// model parameters first, sampler diagnostics (lp__, divergent__, ...) last
	const order = [...run.paramNames.keys()].sort((a, b) =>
		Number(run.paramNames[a].endsWith('__')) - Number(run.paramNames[b].endsWith('__')));

	const lines = ['parameter,mean,mcse,sd,p5,median,p95,ess,ess_per_sec,rhat'];
	for (const index of order) {
		const flat = run.draws[index];
		const byChain = Array.from({ length: run.numChains }, (_, chain) =>
			flat.slice(chain * perChain, (chain + 1) * perChain));
		const sorted = [...flat].sort((a, b) => a - b);

		const ess = safe(() => effective_sample_size(byChain));
		const sd = safe(() => std_deviation(sorted));
		const row = [
			safe(() => mean(sorted)),
			sd / Math.sqrt(ess),
			sd,
			safe(() => percentile(sorted, 0.05)),
			safe(() => percentile(sorted, 0.5)),
			safe(() => percentile(sorted, 0.95)),
			ess,
			run.computeTimeSec > 0 ? ess / run.computeTimeSec : NaN,
			safe(() => split_potential_scale_reduction(byChain)),
		];
		lines.push([run.paramNames[index], ...row.map(formatStat)].join(','));
	}
	return lines.join('\n') + '\n';
}

function safe(compute: () => number): number {
	try {
		return compute();
	} catch {
		return NaN;
	}
}

function formatStat(value: number): string {
	return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : 'NaN';
}
