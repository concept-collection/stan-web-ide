import type { CustomEditorProvider, WorkspaceFileSystem } from 'minwebide';
import { loadRunData, prettifyParamName, type RunData, type RunVariable } from './runData';
import { dirnameOf } from './sampleConfig';
import './resultsView.css';

// The results dashboard: the default view for <name>.out/run.json (the
// manifest written last by a completed run). Tabs over the run's outputs —
// summary table, histograms, trace plots, scatter, draws, console — reading
// the sibling CSVs, so it works for any output folder in any session. The
// view watches the file system and reloads when the run is replaced.
//
// Plots use plotly (the basic bundle), imported lazily so the app doesn't
// pay for it until a dashboard renders a plot.

const MAX_PLOTS = 24;
const MAX_TRACE_POINTS = 5000;
const MAX_SCATTER_POINTS = 5000;
const MAX_DRAWS_ROWS = 1000;
const RELOAD_DEBOUNCE_MS = 400;

// one distinguishable color per chain (d3 category10), same in both themes
const CHAIN_COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f'];

let plotlyPromise: Promise<typeof import('plotly.js-basic-dist-min')['default']> | undefined;
function loadPlotly() {
	plotlyPromise ??= import('plotly.js-basic-dist-min').then((module) => module.default);
	return plotlyPromise;
}
type PlotlyLib = Awaited<ReturnType<typeof loadPlotly>>;

export function createResultsViewProvider(fs: WorkspaceFileSystem): CustomEditorProvider {
	return {
		viewType: 'stan.results',
		displayName: 'Sampling Results',
		selector: [{ filenamePattern: '**/*.out/run.json' }],
		priority: 'default',
		resolveCustomEditor(doc) {
			const outputDir = dirnameOf(doc.uri.path);
			const runName = outputDir.split('/').pop() ?? outputDir;

			const element = el('div', 'results-view');
			const inner = el('div', 'results-inner');
			element.appendChild(inner);
			inner.appendChild(el('h2', undefined, runName));
			const subtitle = el('p', 'results-subtitle', 'loading...');
			inner.appendChild(subtitle);
			const tabsRow = el('div', 'results-tabs');
			const body = el('div', 'results-body');
			inner.append(tabsRow, body);

			let disposed = false;
			let data: RunData | undefined;
			let plotly: PlotlyLib | undefined;
			const plotDivs = new Set<HTMLElement>();

			const tabs: { id: string; label: string; render: (container: HTMLElement, run: RunData) => void }[] = [
				{ id: 'summary', label: 'Summary', render: renderSummary },
				{ id: 'histograms', label: 'Histograms', render: renderHistograms },
				{ id: 'trace', label: 'Trace plots', render: renderTrace },
				{ id: 'scatter', label: 'Scatter', render: renderScatter },
				{ id: 'draws', label: 'Draws', render: renderDraws },
				{ id: 'console', label: 'Console', render: renderConsole },
			];
			let activeTab = 'summary';
			const renderedTabs = new Map<string, HTMLElement>();

			const tabButtons = new Map<string, HTMLButtonElement>();
			for (const tab of tabs) {
				const button = el('button', 'results-tab', tab.label);
				button.addEventListener('click', () => selectTab(tab.id));
				tabButtons.set(tab.id, button);
				tabsRow.appendChild(button);
			}

			function selectTab(id: string): void {
				activeTab = id;
				for (const [tabId, button] of tabButtons) {
					button.classList.toggle('active', tabId === id);
				}
				for (const [tabId, container] of renderedTabs) {
					container.style.display = tabId === id ? '' : 'none';
				}
				if (!renderedTabs.has(id) && data) {
					const container = el('div', 'results-tab-content');
					renderedTabs.set(id, container);
					body.appendChild(container);
					tabs.find((tab) => tab.id === id)?.render(container, data);
				}
			}

			async function reload(): Promise<void> {
				let loaded: RunData | undefined;
				let error: string | undefined;
				try {
					loaded = await loadRunData(fs, outputDir);
				} catch (cause) {
					error = String(cause instanceof Error ? cause.message : cause);
				}
				if (disposed) {
					return;
				}
				data = loaded;
				for (const container of renderedTabs.values()) {
					container.remove();
				}
				renderedTabs.clear();
				plotDivs.clear();
				body.textContent = '';
				if (!data) {
					subtitle.textContent = 'no results';
					body.appendChild(el('div', 'results-error',
						`could not load results from ${outputDir}: ${error}\n\nResults appear here when a sampling run completes.`));
					return;
				}
				subtitle.textContent = describeRun(data);
				selectTab(activeTab);
			}

			// reload when the run is replaced (writes are debounced into one
			// reload; run.json is written last, so the reload sees a complete run)
			let reloadTimer: ReturnType<typeof setTimeout> | undefined;
			const watcher = fs.fileService.onDidFilesChange(() => {
				clearTimeout(reloadTimer);
				reloadTimer = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
			});
			void reload();

			return {
				element,
				layout(): void {
					for (const div of plotDivs) {
						if (div.isConnected && div.offsetParent !== null) {
							plotly?.Plots.resize(div);
						}
					}
				},
				dispose(): void {
					disposed = true;
					clearTimeout(reloadTimer);
					watcher.dispose();
					for (const div of plotDivs) {
						plotly?.purge(div);
					}
				},
			};

			// --- tabs ----------------------------------------------------------

			function renderSummary(container: HTMLElement, run: RunData): void {
				if (run.summary.length < 2) {
					container.appendChild(el('div', 'results-note', 'no summary available'));
					return;
				}
				const [header, ...rows] = run.summary;
				const rhatColumn = header.indexOf('rhat');
				const table = el('table', 'results-table');
				const head = el('tr');
				for (const cell of header) {
					head.appendChild(el('th', undefined, cell));
				}
				table.appendChild(head);
				for (const row of rows) {
					const tr = el('tr');
					row.forEach((cell, column) => {
						const td = el('td', column === 0 ? 'name' : 'num', column === 0 ? prettifyParamName(cell) : cell);
						if (column === rhatColumn) {
							const rhat = Number(cell);
							if (rhat > 1.05) {
								td.classList.add('bad');
							} else if (rhat > 1.01) {
								td.classList.add('warn');
							}
						}
						tr.appendChild(td);
					});
					table.appendChild(tr);
				}
				const scroll = el('div', 'results-table-scroll');
				scroll.appendChild(table);
				container.appendChild(scroll);
			}

			function renderHistograms(container: HTMLElement, run: RunData): void {
				const variables = limited(container, run.variables);
				const grid = el('div', 'results-grid');
				container.appendChild(grid);
				const accent = accentColor(container);
				for (const variable of variables) {
					const { card, plot } = plotCard(variable.name);
					grid.appendChild(card);
					const pooled = variable.draws.flat();
					const bins = binize(pooled);
					void makePlot(plot, [{
						type: 'bar',
						x: bins.x,
						y: bins.y,
						width: bins.width,
						marker: { color: accent },
						hovertemplate: '%{x}: %{y:.3f}<extra></extra>',
					}], {
						bargap: 0.05,
						yaxis: { title: { text: 'probability', font: { size: 10 } } },
					});
				}
			}

			function renderTrace(container: HTMLElement, run: RunData): void {
				container.appendChild(chainLegend(run.numChains));
				const variables = limited(container, run.variables);
				for (const variable of variables) {
					const { card, plot } = plotCard(variable.name, 'wide');
					container.appendChild(card);
					void makePlot(plot, variable.draws.map((draws, chain) => {
						const { x, y } = decimate(draws, MAX_TRACE_POINTS);
						return {
							type: 'scatter',
							mode: 'lines',
							name: `chain ${chain + 1}`,
							line: { color: CHAIN_COLORS[chain % CHAIN_COLORS.length], width: 1 },
							x,
							y,
						};
					}), {
						xaxis: { title: { text: 'draw', font: { size: 10 } } },
					});
				}
			}

			function renderScatter(container: HTMLElement, run: RunData): void {
				const controls = el('div', 'results-controls');
				const xSelect = variableSelect(run.variables, 0);
				const ySelect = variableSelect(run.variables, Math.min(1, run.variables.length - 1));
				controls.append(labelFor('x', xSelect), labelFor('y', ySelect));
				container.appendChild(controls);
				container.appendChild(chainLegend(run.numChains));
				const { card, plot } = plotCard('', 'tall');
				container.appendChild(card);

				const draw = () => {
					const x = run.variables[Number(xSelect.value)];
					const y = run.variables[Number(ySelect.value)];
					void makePlot(plot, x.draws.map((xDraws, chain) => {
						const stride = Math.max(1, Math.ceil(xDraws.length / MAX_SCATTER_POINTS));
						const xs: number[] = [], ys: number[] = [];
						for (let i = 0; i < xDraws.length; i += stride) {
							xs.push(xDraws[i]);
							ys.push(y.draws[chain][i]);
						}
						return {
							type: 'scatter',
							mode: 'markers',
							name: `chain ${chain + 1}`,
							marker: { color: CHAIN_COLORS[chain % CHAIN_COLORS.length], size: 3, opacity: 0.5 },
							x: xs,
							y: ys,
						};
					}), {
						xaxis: { title: { text: x.name, font: { size: 10 } } },
						yaxis: { title: { text: y.name, font: { size: 10 } } },
					});
				};
				xSelect.addEventListener('change', draw);
				ySelect.addEventListener('change', draw);
				draw();
			}

			function renderDraws(container: HTMLElement, run: RunData): void {
				const controls = el('div', 'results-controls');
				const chainSelect = el('select');
				for (let chain = 1; chain <= run.numChains; chain++) {
					const option = el('option', undefined, `chain ${chain}`);
					option.value = String(chain - 1);
					chainSelect.appendChild(option);
				}
				controls.appendChild(labelFor('chain', chainSelect));
				const note = el('span', 'results-note', '');
				controls.appendChild(note);
				container.appendChild(controls);
				const scroll = el('div', 'results-table-scroll');
				container.appendChild(scroll);

				const draw = () => {
					const chain = Number(chainSelect.value);
					const total = run.drawsPerChain;
					const shown = Math.min(total, MAX_DRAWS_ROWS);
					note.textContent = shown < total
						? `showing ${shown.toLocaleString()} of ${total.toLocaleString()} draws — open chain_${chain + 1}.csv for all of them`
						: `${total.toLocaleString()} draws`;
					const table = el('table', 'results-table');
					const head = el('tr');
					head.appendChild(el('th', undefined, '#'));
					for (const variable of run.variables) {
						head.appendChild(el('th', undefined, variable.name));
					}
					table.appendChild(head);
					for (let row = 0; row < shown; row++) {
						const tr = el('tr');
						tr.appendChild(el('td', 'name', String(row + 1)));
						for (const variable of run.variables) {
							tr.appendChild(el('td', 'num', formatValue(variable.draws[chain][row])));
						}
						table.appendChild(tr);
					}
					scroll.textContent = '';
					scroll.appendChild(table);
				};
				chainSelect.addEventListener('change', draw);
				draw();
			}

			function renderConsole(container: HTMLElement, run: RunData): void {
				const pre = el('pre', 'results-console');
				pre.textContent = run.consoleText || '(no console output)';
				container.appendChild(pre);
			}

			// --- plot helpers ----------------------------------------------------

			async function makePlot(div: HTMLElement, traces: unknown[], layout: Record<string, unknown>): Promise<void> {
				try {
					const lib = await loadPlotly();
					if (disposed || !div.isConnected) {
						return;
					}
					plotly = lib;
					await lib.newPlot(div, traces, { ...baseLayout(div), ...layout, ...mergeAxes(div, layout) }, {
						displaylogo: false,
						responsive: true,
						modeBarButtonsToRemove: ['lasso2d', 'select2d'],
					});
					plotDivs.add(div);
				} catch (error) {
					div.textContent = `plot failed: ${error}`;
				}
			}

			function baseLayout(div: HTMLElement): Record<string, unknown> {
				const style = getComputedStyle(div);
				const fg = style.getPropertyValue('--vscode-foreground').trim() || '#cccccc';
				const bg = style.getPropertyValue('--vscode-editor-background').trim() || '#1f1f1f';
				return {
					paper_bgcolor: bg,
					plot_bgcolor: bg,
					font: { color: fg, size: 11, family: 'system-ui, sans-serif' },
					margin: { l: 55, r: 10, t: 10, b: 40 },
					showlegend: false,
				};
			}

			/** Axis defaults (grid color, no zero line), merged under any
			 *  axis overrides the caller passed in `layout`. */
			function mergeAxes(div: HTMLElement, layout: Record<string, unknown>): Record<string, unknown> {
				const grid = 'rgba(128, 128, 128, 0.25)';
				const axis = { gridcolor: grid, zeroline: false };
				return {
					xaxis: { ...axis, ...(layout.xaxis as object | undefined) },
					yaxis: { ...axis, ...(layout.yaxis as object | undefined) },
				};
			}

			function plotCard(title: string, kind?: 'wide' | 'tall'): { card: HTMLElement; plot: HTMLElement } {
				const card = el('div', `results-plot-card${kind ? ` ${kind}` : ''}`);
				if (title) {
					card.appendChild(el('div', 'results-plot-title', title));
				}
				const plot = el('div', 'results-plot');
				card.appendChild(plot);
				return { card, plot };
			}

			/** Caps how many parameters get a plot; adds a note when truncated. */
			function limited(container: HTMLElement, variables: RunVariable[]): RunVariable[] {
				if (variables.length > MAX_PLOTS) {
					container.appendChild(el('div', 'results-note',
						`showing the first ${MAX_PLOTS} of ${variables.length} parameters`));
					return variables.slice(0, MAX_PLOTS);
				}
				return variables;
			}

			function variableSelect(variables: RunVariable[], selected: number): HTMLSelectElement {
				const select = el('select');
				variables.forEach((variable, index) => {
					const option = el('option', undefined, variable.name);
					option.value = String(index);
					select.appendChild(option);
				});
				select.value = String(Math.max(0, selected));
				return select;
			}
		},
	};
}

function describeRun(run: RunData): string {
	const info = run.info;
	const parts = [
		info.stan,
		info.data,
		`${run.numChains} chains × (${info.num_warmup ?? '?'} warmup + ${info.num_samples ?? '?'} samples)`,
		info.seed !== undefined ? `seed ${info.seed}` : undefined,
		info.compute_time_sec !== undefined ? `sampled in ${info.compute_time_sec} s` : undefined,
	];
	return parts.filter(Boolean).join(' · ');
}

function chainLegend(numChains: number): HTMLElement {
	const legend = el('div', 'results-chain-legend');
	for (let chain = 0; chain < numChains; chain++) {
		const chip = el('span', 'results-chain-chip', `chain ${chain + 1}`);
		const swatch = el('span', 'results-chain-swatch');
		swatch.style.backgroundColor = CHAIN_COLORS[chain % CHAIN_COLORS.length];
		chip.prepend(swatch);
		legend.appendChild(chip);
	}
	return legend;
}

function labelFor(text: string, control: HTMLElement): HTMLElement {
	const label = el('label', 'results-control');
	label.append(el('span', undefined, text), control);
	return label;
}

function accentColor(div: HTMLElement): string {
	return getComputedStyle(div).getPropertyValue('--vscode-progressBar-background').trim() || '#0e70c0';
}

function binize(values: number[]): { x: number[]; y: number[]; width: number } {
	let min = Infinity;
	let max = -Infinity;
	for (const value of values) {
		if (value < min) min = value;
		if (value > max) max = value;
	}
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		return { x: [], y: [], width: 1 };
	}
	if (min === max) {
		return { x: [min], y: [1], width: 1 };
	}
	const numBins = Math.max(5, Math.min(200, Math.ceil(1.5 * Math.sqrt(values.length))));
	const width = (max - min) / numBins;
	const counts = new Array<number>(numBins).fill(0);
	for (const value of values) {
		counts[Math.min(numBins - 1, Math.floor((value - min) / width))]++;
	}
	return {
		x: counts.map((_, bin) => min + (bin + 0.5) * width),
		y: counts.map((count) => count / values.length),
		width,
	};
}

/** Every stride-th point so trace plots stay responsive on huge runs. */
function decimate(draws: number[], maxPoints: number): { x: number[]; y: number[] } {
	const stride = Math.max(1, Math.ceil(draws.length / maxPoints));
	const x: number[] = [];
	const y: number[] = [];
	for (let i = 0; i < draws.length; i += stride) {
		x.push(i + 1);
		y.push(draws[i]);
	}
	return { x, y };
}

function formatValue(value: number): string {
	return Number.isFinite(value) ? String(Number(value.toPrecision(6))) : String(value);
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
