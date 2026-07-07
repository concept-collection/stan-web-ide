import { parse, parseDocument } from 'yaml';

// .sample files: a YAML description of one sampling run —
//
//   stan: linear.stan        # the Stan program
//   data: data.json          # the data file
//   num_chains: 4            # optional, with stan-playground's defaults
//   num_warmup: 1000
//   num_samples: 1000
//   init_radius: 2.0
//   seed: 42                 # omit for a random seed
//
// File references are relative to the .sample file's directory; a leading
// '/' means the project root. Results go to a directory derived from the
// file's name (see outputDirFor), not configured in the YAML.

export interface SampleFileConfig {
	stan?: string;
	data?: string;
	num_chains: number;
	num_warmup: number;
	num_samples: number;
	init_radius: number;
	seed?: number;
}

export const samplingDefaults = {
	num_chains: 4,
	num_warmup: 1000,
	num_samples: 1000,
	init_radius: 2.0,
} as const;

export const KNOWN_KEYS = ['stan', 'data', 'num_chains', 'num_warmup', 'num_samples', 'init_radius', 'seed'] as const;

/** The run's output directory, derived from the .sample file's path:
 *  /a/b/fit.sample → /a/b/fit.out (replaced on each run). */
export function outputDirFor(samplePath: string): string {
	const dir = dirnameOf(samplePath);
	const name = samplePath.split('/').pop() ?? '';
	const stem = name.endsWith('.sample') ? name.slice(0, -'.sample'.length) : name;
	return `${dir === '/' ? '' : dir}/${stem || 'run'}.out`;
}

export interface ParsedSampleFile {
	config: SampleFileConfig;
	/** Problems that make the config unrunnable. */
	errors: string[];
	/** Non-fatal issues (unknown keys, ...). */
	warnings: string[];
}

export function parseSampleFile(text: string): ParsedSampleFile {
	const errors: string[] = [];
	const warnings: string[] = [];
	const config: SampleFileConfig = { ...samplingDefaults };

	let raw: unknown;
	try {
		raw = parse(text);
	} catch (error) {
		return { config, errors: [`invalid YAML: ${error instanceof Error ? error.message : error}`], warnings };
	}
	if (raw === null || raw === undefined) {
		raw = {};
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		return { config, errors: ['the .sample file must be a YAML mapping'], warnings };
	}
	const record = raw as Record<string, unknown>;

	for (const key of Object.keys(record)) {
		if (key === 'output_dir') {
			warnings.push("'output_dir' is no longer configurable (ignored) — results go to <sample-file-name>.out");
		} else if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
			warnings.push(`unknown key '${key}' (ignored)`);
		}
	}

	const str = (key: 'stan' | 'data'): string | undefined => {
		const value = record[key];
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value !== 'string' || !value.trim()) {
			errors.push(`'${key}' must be a non-empty string`);
			return undefined;
		}
		return value.trim();
	};
	config.stan = str('stan');
	config.data = str('data');

	const num = (key: 'num_chains' | 'num_warmup' | 'num_samples' | 'init_radius' | 'seed', opts: { min: number; max?: number; integer: boolean }): number | undefined => {
		const value = record[key];
		if (value === undefined || value === null) {
			return undefined;
		}
		if (typeof value !== 'number' || !Number.isFinite(value)
			|| (opts.integer && !Number.isInteger(value))
			|| value < opts.min || (opts.max !== undefined && value > opts.max)) {
			const range = opts.max !== undefined ? `${opts.min}..${opts.max}` : `>= ${opts.min}`;
			errors.push(`'${key}' must be ${opts.integer ? 'an integer' : 'a number'} (${range})`);
			return undefined;
		}
		return value;
	};
	config.num_chains = num('num_chains', { min: 1, max: 8, integer: true }) ?? samplingDefaults.num_chains;
	config.num_warmup = num('num_warmup', { min: 0, integer: true }) ?? samplingDefaults.num_warmup;
	config.num_samples = num('num_samples', { min: 1, integer: true }) ?? samplingDefaults.num_samples;
	config.init_radius = num('init_radius', { min: 0, integer: false }) ?? samplingDefaults.init_radius;
	config.seed = num('seed', { min: 0, integer: true });

	if (!config.stan) {
		errors.push("missing 'stan': the Stan program to compile and run");
	} else if (!config.stan.endsWith('.stan')) {
		errors.push("'stan' must reference a .stan file");
	}
	if (!config.data) {
		errors.push("missing 'data': the JSON data file");
	}

	return { config, errors, warnings };
}

/**
 * Sets (or, with undefined, removes) one top-level key in the YAML text,
 * preserving comments and formatting of everything else.
 */
export function updateSampleYaml(text: string, key: string, value: string | number | undefined): string {
	const doc = parseDocument(text);
	if (doc.contents === null || doc.contents === undefined) {
		// empty document: build a fresh mapping
		return value === undefined ? text : `${key}: ${JSON.stringify(value)}\n`;
	}
	if (value === undefined) {
		doc.delete(key);
	} else {
		doc.set(key, value);
	}
	return doc.toString();
}

/**
 * Resolves a file reference from a .sample file: relative to the .sample
 * file's directory, or from the project root with a leading '/'.
 * Returns a normalized absolute project path.
 */
export function resolveProjectPath(sampleFileDir: string, reference: string): string {
	const joined = reference.startsWith('/') ? reference : `${sampleFileDir}/${reference}`;
	const parts: string[] = [];
	for (const part of joined.split('/')) {
		if (part === '' || part === '.') {
			continue;
		}
		if (part === '..') {
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return '/' + parts.join('/');
}

/** The directory of a project file path ('/a/b/c.sample' → '/a/b'). */
export function dirnameOf(path: string): string {
	const index = path.lastIndexOf('/');
	return index <= 0 ? '/' : path.slice(0, index);
}
