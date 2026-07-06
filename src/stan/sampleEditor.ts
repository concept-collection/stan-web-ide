import { monaco, type CustomEditorProvider, type Workbench, type WorkspaceFileSystem } from 'minwebide';
import { getRunState, onDidChangeRunState, type RunState } from './runEvents';
import { dirnameOf, parseSampleFile, samplingDefaults, updateSampleYaml } from './sampleConfig';
import './sampleEditor.css';

// The default view for .sample files: a form over the YAML (shared text
// model, so 'Reopen as Text Editor', dirty state, and Ctrl+S behave), plus
// the run button and per-chain progress bars fed by runEvents.

interface StopHandle {
	stop(): void;
}

export function createSampleEditorProvider(fs: WorkspaceFileSystem, workbench: Workbench, stopHandle: StopHandle): CustomEditorProvider {
	return {
		viewType: 'stan.sampleView',
		displayName: 'Sampling Run',
		selector: [{ filenamePattern: '*.sample' }],
		priority: 'default',
		async resolveCustomEditor(doc) {
			const model = await doc.getTextModel();
			const uriKey = doc.uri.toString();
			const sampleDir = dirnameOf(doc.uri.path);
			const disposables: { dispose(): void }[] = [];

			const element = el('div', 'sample-editor');
			const inner = el('div', 'sample-editor-inner');
			element.appendChild(inner);

			const fileName = doc.uri.path.split('/').pop() ?? doc.uri.path;
			inner.appendChild(el('h2', undefined, fileName));
			inner.appendChild(el('p', 'sample-editor-subtitle', 'A sampling run: the Stan program, the data, sampling parameters, and where results go. This form edits the underlying YAML (tab menu → Reopen as Text Editor).'));

			const problems = el('div', 'sample-problems');
			problems.style.display = 'none';
			inner.appendChild(problems);

			// --- fields ------------------------------------------------------
			let applyingEdit = false;
			const setKey = (key: string, value: string | number | undefined) => {
				const updated = updateSampleYaml(model.getValue(), key, value);
				if (updated !== model.getValue()) {
					applyingEdit = true;
					try {
						model.pushEditOperations([], [{ range: model.getFullModelRange(), text: updated }], () => null);
					} finally {
						applyingEdit = false;
					}
					refresh();
				}
			};

			const stanField = fileSelect('stan', 'the Stan program', '.stan');
			const dataField = fileSelect('data', 'the data (JSON)', '.json');

			const outputField = el('input');
			outputField.type = 'text';
			outputField.placeholder = 'e.g. out/fit1';
			outputField.addEventListener('change', () => setKey('output_dir', outputField.value.trim() || undefined));
			inner.appendChild(field('output_dir', 'results are written here (replaced on each run)', outputField));

			const params = el('div', 'sample-params');
			inner.appendChild(params);
			const numberField = (key: 'num_chains' | 'num_warmup' | 'num_samples' | 'init_radius' | 'seed', hint: string, opts: { min: number; max?: number; step?: string; optional?: boolean }) => {
				const input = el('input');
				input.type = 'number';
				input.min = String(opts.min);
				if (opts.max !== undefined) {
					input.max = String(opts.max);
				}
				input.step = opts.step ?? '1';
				if (opts.optional) {
					input.placeholder = 'random';
				}
				input.addEventListener('change', () => {
					const raw = input.value.trim();
					if (!raw) {
						setKey(key, opts.optional ? undefined : samplingDefaults[key as keyof typeof samplingDefaults]);
						return;
					}
					const value = Number(raw);
					if (Number.isFinite(value)) {
						setKey(key, value);
					}
				});
				params.appendChild(field(key, hint, input, true));
				return input;
			};
			const chainsInput = numberField('num_chains', 'chains', { min: 1, max: 8 });
			const warmupInput = numberField('num_warmup', 'warmup iterations', { min: 0 });
			const samplesInput = numberField('num_samples', 'draws per chain', { min: 1 });
			const radiusInput = numberField('init_radius', 'init radius', { min: 0, step: '0.1' });
			const seedInput = numberField('seed', 'random seed', { min: 0, optional: true });

			// --- run button + progress ---------------------------------------
			const runRow = el('div', 'sample-run-row');
			const runButton = el('button', 'sample-run-button', 'Run sampling');
			runButton.addEventListener('click', () => {
				const state = getRunState(uriKey);
				if (isRunning(state)) {
					stopHandle.stop();
				} else {
					void workbench.runFile(doc.uri);
				}
			});
			const runStatus = el('span', 'sample-run-status', '');
			runRow.append(runButton, runStatus);
			inner.appendChild(runRow);

			const chainsBox = el('div', 'sample-chains');
			inner.appendChild(chainsBox);

			const renderRunState = (state: RunState) => {
				const running = isRunning(state);
				runButton.textContent = running ? 'Stop' : 'Run sampling';
				runButton.classList.toggle('stop', running);
				runStatus.textContent = state.message ?? '';
				runStatus.className = 'sample-run-status'
					+ (state.phase === 'failed' ? ' error' : state.phase === 'done' ? ' done' : '');
				chainsBox.textContent = '';
				if (state.chains) {
					state.chains.forEach((chain, index) => {
						const row = el('div', 'sample-chain');
						const percent = chain.totalIterations > 0 ? Math.round((chain.iteration / chain.totalIterations) * 100) : 0;
						row.appendChild(el('span', 'sample-chain-label',
							`Chain ${index + 1}  ${chain.iteration} / ${chain.totalIterations}${chain.iteration > 0 ? (chain.warmup ? ' (warmup)' : ' (sampling)') : ''}`));
						const bar = el('div', 'sample-chain-bar');
						const fill = el('div', 'sample-chain-fill' + (chain.warmup ? ' warmup' : ''));
						fill.style.width = `${percent}%`;
						bar.appendChild(fill);
						row.appendChild(bar);
						chainsBox.appendChild(row);
					});
				}
			};
			renderRunState(getRunState(uriKey));
			disposables.push(onDidChangeRunState((key, state) => {
				if (key === uriKey) {
					renderRunState(state);
				}
			}));

			// --- model → form ------------------------------------------------
			const refresh = () => {
				const { config, errors, warnings } = parseSampleFile(model.getValue());
				const messages = [...errors, ...warnings.map(w => `warning: ${w}`)];
				problems.style.display = messages.length ? '' : 'none';
				problems.className = 'sample-problems' + (errors.length ? '' : ' warnings');
				problems.textContent = messages.join('\n');
				runButton.disabled = errors.length > 0;

				setIfNotFocused(stanField.select, config.stan ?? '');
				setIfNotFocused(dataField.select, config.data ?? '');
				setIfNotFocused(outputField, config.output_dir ?? '');
				setIfNotFocused(chainsInput, String(config.num_chains));
				setIfNotFocused(warmupInput, String(config.num_warmup));
				setIfNotFocused(samplesInput, String(config.num_samples));
				setIfNotFocused(radiusInput, String(config.init_radius));
				setIfNotFocused(seedInput, config.seed === undefined ? '' : String(config.seed));
			};

			disposables.push(model.onDidChangeContent(() => {
				if (!applyingEdit) {
					refresh();
				}
			}));

			// keep the .stan/.json dropdowns in sync with the project's files
			const refreshFileLists = async () => {
				const all = await listProjectFiles(fs);
				stanField.setOptions(all.filter(path => path.endsWith('.stan')));
				dataField.setOptions(all.filter(path => path.endsWith('.json')));
				refresh();
			};
			let fileListTimer: ReturnType<typeof setTimeout> | undefined;
			disposables.push(fs.fileService.onDidFilesChange(() => {
				clearTimeout(fileListTimer);
				fileListTimer = setTimeout(() => void refreshFileLists(), 300);
			}));
			await refreshFileLists();

			return {
				element,
				dispose() {
					clearTimeout(fileListTimer);
					for (const disposable of disposables) {
						disposable.dispose();
					}
				},
			};

			// --- helpers scoped to this pane ---------------------------------

			/** A <select> of project files with a given extension, storing
			 *  .sample-dir-relative references in the YAML. */
			function fileSelect(key: 'stan' | 'data', hint: string, extension: string) {
				const select = el('select');
				let options: string[] = [];
				const setOptions = (paths: string[]) => {
					options = paths.map(path => referenceFor(path));
					renderOptions(select.value);
				};
				const renderOptions = (current: string) => {
					select.textContent = '';
					const empty = makeOption('', `— select a ${extension} file —`);
					select.appendChild(empty);
					const seen = new Set<string>();
					for (const reference of options) {
						seen.add(reference);
						select.appendChild(makeOption(reference, reference));
					}
					if (current && !seen.has(current)) {
						select.appendChild(makeOption(current, `${current} (missing)`));
					}
					select.value = current;
				};
				select.addEventListener('change', () => setKey(key, select.value || undefined));
				inner.appendChild(field(key, hint, select));
				return { select, setOptions };
			}

			function referenceFor(path: string): string {
				return path.startsWith(`${sampleDir}/`) && sampleDir !== '/'
					? path.slice(sampleDir.length + 1)
					: (sampleDir === '/' ? path.slice(1) : path);
			}

			function setIfNotFocused(input: HTMLInputElement | HTMLSelectElement, value: string): void {
				if (document.activeElement === input) {
					return;
				}
				if (input instanceof HTMLSelectElement) {
					const has = [...input.options].some(option => option.value === value);
					if (!has && value) {
						input.appendChild(makeOption(value, `${value} (missing)`));
					}
				}
				if (input.value !== value) {
					input.value = value;
				}
			}

			function makeOption(value: string, label: string): HTMLOptionElement {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				return option;
			}
		},
	};

	function isRunning(state: RunState): boolean {
		return state.phase === 'compiling' || state.phase === 'loading' || state.phase === 'sampling' || state.phase === 'writing';
	}
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function field(label: string, hint: string, control: HTMLElement, compact = false): HTMLElement {
	const wrap = el('div', 'sample-field');
	const labelEl = el('label', undefined, label);
	if (!compact) {
		labelEl.appendChild(el('span', 'sample-field-hint', hint));
	} else {
		labelEl.title = hint;
	}
	wrap.append(labelEl, control);
	return wrap;
}

async function listProjectFiles(fs: WorkspaceFileSystem, path = '/'): Promise<string[]> {
	const result: string[] = [];
	const stat = await fs.fileService.resolve(fs.root.with({ path }));
	for (const child of stat.children ?? []) {
		if (child.isDirectory) {
			result.push(...await listProjectFiles(fs, child.resource.path));
		} else {
			result.push(child.resource.path);
		}
	}
	return result.sort();
}
