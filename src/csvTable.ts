import type { CustomEditorProvider } from 'minwebide';
import './csvTable.css';

// The default view for .csv files: a table with a sticky header, row
// numbers, right-aligned numeric columns, and click-to-sort headers (nice
// for ranking summary.csv by ESS or Rhat). Shares the text model with the
// built-in editor, so it follows edits live and the tab menu offers
// 'Reopen as Text Editor' for the raw file.

const MAX_RENDERED_ROWS = 10_000;
const DEBOUNCE_MS = 300;

export function createCsvTableProvider(): CustomEditorProvider {
	return {
		viewType: 'stan.csvTable',
		displayName: 'CSV Table',
		selector: [{ filenamePattern: '*.csv' }],
		priority: 'default',
		async resolveCustomEditor(doc) {
			const model = await doc.getTextModel();

			const element = el('div', 'csv-view');
			const meta = el('div', 'csv-view-meta');
			const scroll = el('div', 'csv-view-scroll');
			element.append(meta, scroll);

			// sort state: column index, or -1 for file order
			let sortColumn = -1;
			let sortAscending = true;

			const render = () => {
				const rows = parseCsv(model.getValue());
				scroll.textContent = '';
				if (rows.length === 0 || (rows.length === 1 && rows[0].every(cell => cell === ''))) {
					meta.textContent = 'empty file';
					scroll.appendChild(el('div', 'csv-view-empty', 'This CSV file is empty.'));
					return;
				}

				const header = rows[0];
				const body = rows.slice(1).map(row =>
					row.length === header.length
						? row
						: [...row, ...Array(Math.max(0, header.length - row.length)).fill('')].slice(0, header.length));

				const numeric = header.map((_, column) =>
					body.length > 0 && body.every(row => row[column] === '' || isNumeric(row[column])));

				if (sortColumn >= 0) {
					const column = sortColumn;
					const direction = sortAscending ? 1 : -1;
					body.sort((a, b) => {
						if (numeric[column]) {
							const left = a[column].trim() === '' ? NaN : Number(a[column]);
							const right = b[column].trim() === '' ? NaN : Number(b[column]);
							// NaN/empty cells sort last in either direction
							if (Number.isNaN(left) !== Number.isNaN(right)) {
								return Number.isNaN(left) ? 1 : -1;
							}
							return direction * (left - right);
						}
						return direction * a[column].localeCompare(b[column]);
					});
				}

				const truncated = body.length > MAX_RENDERED_ROWS;
				const shown = truncated ? body.slice(0, MAX_RENDERED_ROWS) : body;
				meta.textContent = `${body.length.toLocaleString()} rows × ${header.length} columns`
					+ (truncated ? ` — showing the first ${MAX_RENDERED_ROWS.toLocaleString()}` : '')
					+ (sortColumn >= 0 ? ` — sorted by ${header[sortColumn] || `column ${sortColumn + 1}`}` : '');

				const table = el('table', 'csv-table');
				const thead = table.createTHead();
				const headRow = thead.insertRow();
				headRow.appendChild(el('th', 'csv-rownum', ''));
				header.forEach((name, column) => {
					const th = el('th', numeric[column] ? 'num' : undefined, name);
					if (sortColumn === column) {
						th.appendChild(el('span', 'csv-sort', sortAscending ? '▲' : '▼'));
					}
					th.title = 'Click to sort';
					th.addEventListener('click', () => {
						if (sortColumn !== column) {
							sortColumn = column;
							sortAscending = true;
						} else if (sortAscending) {
							sortAscending = false;
						} else {
							sortColumn = -1; // third click: back to file order
						}
						render();
					});
					headRow.appendChild(th);
				});

				const tbody = table.createTBody();
				shown.forEach((row, index) => {
					const tr = tbody.insertRow();
					tr.appendChild(el('td', 'csv-rownum', String(index + 1)));
					row.forEach((cell, column) => {
						tr.appendChild(el('td', numeric[column] ? 'num' : undefined, cell));
					});
				});
				scroll.appendChild(table);
			};
			render();

			let timer: ReturnType<typeof setTimeout> | undefined;
			const changeListener = model.onDidChangeContent(() => {
				clearTimeout(timer);
				timer = setTimeout(render, DEBOUNCE_MS);
			});

			return {
				element,
				dispose() {
					clearTimeout(timer);
					changeListener.dispose();
				},
			};
		},
	};
}

function isNumeric(value: string): boolean {
	if (value === 'NaN' || value === 'Inf' || value === '-Inf') {
		return true; // summary.csv sentinel values
	}
	return value.trim() !== '' && Number.isFinite(Number(value));
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, newlines in quotes. */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ',') {
			row.push(field);
			field = '';
		} else if (char === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else if (char !== '\r') {
			field += char;
		}
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
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
