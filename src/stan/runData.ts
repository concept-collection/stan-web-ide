import type { WorkspaceFileSystem } from 'minwebide';

// Loads a completed run from its output directory (the files written by
// outputs.ts) into the shape the results dashboard works with. The run.json
// manifest is written last, so its presence means the other files are
// complete.

/** The run.json manifest (the sampling configuration plus format tag). */
export interface RunInfo {
	format?: string;
	stan?: string;
	data?: string;
	num_chains?: number;
	num_warmup?: number;
	num_samples?: number;
	init_radius?: number;
	seed?: number;
	compute_time_sec?: number;
}

export interface RunVariable {
	/** Prettified name: 'beta.1' → 'beta[1]'. */
	name: string;
	/** Sampler diagnostics (lp__, divergent__, ...). */
	isDiagnostic: boolean;
	/** draws[chain][draw]. */
	draws: number[][];
}

export interface RunData {
	info: RunInfo;
	/** Model parameters first, diagnostics last. */
	variables: RunVariable[];
	numChains: number;
	drawsPerChain: number;
	/** Parsed summary.csv: header row + data rows. */
	summary: string[][];
	consoleText: string;
}

export async function loadRunData(fs: WorkspaceFileSystem, outputDir: string): Promise<RunData> {
	const info = JSON.parse(await readText(fs, `${outputDir}/run.json`)) as RunInfo;
	const numChains = info.num_chains ?? 1;

	let paramNames: string[] = [];
	const perChain: number[][][] = []; // [chain][param][draw]
	for (let chain = 1; chain <= numChains; chain++) {
		const text = await readText(fs, `${outputDir}/chain_${chain}.csv`);
		const lines = text.split('\n').filter((line) => line.length > 0);
		if (lines.length < 2) {
			throw new Error(`chain_${chain}.csv has no draws`);
		}
		const names = lines[0].split(',');
		if (chain === 1) {
			paramNames = names;
		} else if (names.length !== paramNames.length) {
			throw new Error(`chain_${chain}.csv has a different parameter set than chain_1.csv`);
		}
		const draws: number[][] = names.map(() => new Array<number>(lines.length - 1));
		for (let row = 1; row < lines.length; row++) {
			const values = lines[row].split(',');
			for (let p = 0; p < names.length; p++) {
				draws[p][row - 1] = Number(values[p]);
			}
		}
		perChain.push(draws);
	}

	const variables: RunVariable[] = paramNames.map((rawName, p) => ({
		name: prettifyParamName(rawName),
		isDiagnostic: rawName.endsWith('__'),
		draws: perChain.map((chain) => chain[p]),
	}));
	// model parameters first, sampler diagnostics last (stable within groups)
	variables.sort((a, b) => Number(a.isDiagnostic) - Number(b.isDiagnostic));

	const summaryText = await readText(fs, `${outputDir}/summary.csv`).catch(() => '');
	const summary = summaryText.split('\n').filter((line) => line.length > 0).map((line) => line.split(','));

	const consoleText = await readText(fs, `${outputDir}/console.txt`).catch(() => '');

	return {
		info,
		variables,
		numChains,
		drawsPerChain: variables[0]?.draws[0]?.length ?? 0,
		summary,
		consoleText,
	};
}

/** TinyStan flattens indices with dots: 'beta.1.2' → 'beta[1,2]'. */
export function prettifyParamName(name: string): string {
	const [base, ...indices] = name.split('.');
	return indices.length > 0 ? `${base}[${indices.join(',')}]` : name;
}

async function readText(fs: WorkspaceFileSystem, path: string): Promise<string> {
	return (await fs.fileService.readFile(fs.root.with({ path }))).value.toString();
}
