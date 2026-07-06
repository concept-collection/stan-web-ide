import { monaco } from 'minwebide';

// Stan editor smarts: connects the stan-language-server worker (diagnostics
// from stanc3, hover docs, completions, auto-format) to monaco. VS Code's
// monaco build has no built-in LSP client, so this is a small purpose-built
// one: JSON-RPC over worker postMessage (the wire format of
// vscode-languageserver's browser transport).

const MARKER_OWNER = 'stan-language-server';
const DEBOUNCE_MS = 300;

interface JsonRpcMessage {
	jsonrpc: '2.0';
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

class LspClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly notificationHandlers = new Map<string, (params: any) => void>();
	private readonly requestHandlers = new Map<string, (params: any) => unknown>();

	constructor(private readonly worker: Worker) {
		worker.onmessage = (event: MessageEvent<JsonRpcMessage>) => this.dispatch(event.data);
	}

	request<T = unknown>(method: string, params: unknown): Promise<T> {
		const id = this.nextId++;
		this.worker.postMessage({ jsonrpc: '2.0', id, method, params });
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
		});
	}

	notify(method: string, params: unknown): void {
		this.worker.postMessage({ jsonrpc: '2.0', method, params });
	}

	onNotification(method: string, handler: (params: any) => void): void {
		this.notificationHandlers.set(method, handler);
	}

	onRequest(method: string, handler: (params: any) => unknown): void {
		this.requestHandlers.set(method, handler);
	}

	private dispatch(message: JsonRpcMessage): void {
		if (message.method !== undefined && message.id !== undefined) {
			// server → client request
			const handler = this.requestHandlers.get(message.method);
			if (handler) {
				Promise.resolve(handler(message.params)).then(
					(result) => this.worker.postMessage({ jsonrpc: '2.0', id: message.id, result }),
					(error) => this.worker.postMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } }),
				);
			} else {
				this.worker.postMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unhandled method ${message.method}` } });
			}
		} else if (message.method !== undefined) {
			this.notificationHandlers.get(message.method)?.(message.params);
		} else if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (pending) {
				if (message.error) {
					pending.reject(new Error(message.error.message));
				} else {
					pending.resolve(message.result);
				}
			}
		}
	}
}

/**
 * Starts the Stan language server and wires it to every 'stan' monaco model
 * (current and future). Call once at startup; returns a disposable.
 */
export function registerStanLsp(): { dispose(): void } {
	const worker = new Worker(new URL('./lspWorker.ts', import.meta.url), { type: 'module' });
	const client = new LspClient(worker);
	const disposables: { dispose(): void }[] = [];
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	client.onRequest('workspace/configuration', (params: { items: unknown[] }) =>
		params.items.map(() => ({ warnPedantic: false })));
	client.onNotification('window/logMessage', () => { /* quiet */ });

	interface LspDiagnostic {
		range: LspRange;
		message: string;
		severity?: number;
		source?: string;
		code?: string | number;
	}

	const applyDiagnostics = (model: monaco.editor.ITextModel, diagnostics: LspDiagnostic[]): void => {
		monaco.editor.setModelMarkers(model, MARKER_OWNER, diagnostics.map((diagnostic) => ({
			...toMonacoRange(diagnostic.range),
			message: diagnostic.message,
			severity: toMarkerSeverity(diagnostic.severity),
			source: diagnostic.source ?? MARKER_OWNER,
			code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
		})));
	};

	// the server implements LSP 3.17 pull diagnostics (textDocument/diagnostic),
	// so the client asks after every (debounced) change
	const diagnosticGeneration = new Map<string, number>();
	const pullDiagnostics = async (model: monaco.editor.ITextModel): Promise<void> => {
		const uri = model.uri.toString();
		const generation = (diagnosticGeneration.get(uri) ?? 0) + 1;
		diagnosticGeneration.set(uri, generation);
		const result = await client.request<{ kind: string; items?: LspDiagnostic[] } | null>('textDocument/diagnostic', {
			textDocument: { uri },
		}).catch(() => null);
		if (result?.items && !model.isDisposed() && diagnosticGeneration.get(uri) === generation) {
			applyDiagnostics(model, result.items);
		}
	};

	// push diagnostics too, in case a future server version publishes them
	client.onNotification('textDocument/publishDiagnostics', (params: { uri: string; diagnostics: LspDiagnostic[] }) => {
		const model = findModel(params.uri);
		if (model) {
			applyDiagnostics(model, params.diagnostics);
		}
	});

	const initialized = client.request('initialize', {
		processId: null,
		rootUri: null,
		workspaceFolders: null,
		capabilities: {
			textDocument: {
				publishDiagnostics: {},
				hover: { contentFormat: ['markdown', 'plaintext'] },
				completion: { completionItem: { documentationFormat: ['markdown', 'plaintext'] } },
				formatting: {},
			},
			workspace: {
				configuration: true,
				didChangeConfiguration: {},
			},
		},
	}).then(() => {
		client.notify('initialized', {});
	}).catch((error) => {
		console.warn('stan language server failed to initialize', error);
	});

	// --- document sync ----------------------------------------------------

	const opened = new Set<string>();

	const openModel = (model: monaco.editor.ITextModel): void => {
		if (model.getLanguageId() !== 'stan' || opened.has(model.uri.toString())) {
			return;
		}
		const uri = model.uri.toString();
		opened.add(uri);
		void initialized.then(() => {
			client.notify('textDocument/didOpen', {
				textDocument: { uri, languageId: 'stan', version: model.getVersionId(), text: model.getValue() },
			});
			void pullDiagnostics(model);
		});
		const changeListener = model.onDidChangeContent(() => {
			clearTimeout(timers.get(uri));
			timers.set(uri, setTimeout(() => {
				client.notify('textDocument/didChange', {
					textDocument: { uri, version: model.getVersionId() },
					contentChanges: [{ text: model.getValue() }],
				});
				void pullDiagnostics(model);
			}, DEBOUNCE_MS));
		});
		const disposeListener = model.onWillDispose(() => {
			changeListener.dispose();
			disposeListener.dispose();
			clearTimeout(timers.get(uri));
			timers.delete(uri);
			opened.delete(uri);
			client.notify('textDocument/didClose', { textDocument: { uri } });
		});
	};

	for (const model of monaco.editor.getModels()) {
		openModel(model);
	}
	disposables.push(monaco.editor.onDidCreateModel(openModel));
	disposables.push(monaco.editor.onDidChangeModelLanguage(({ model }) => openModel(model)));

	// --- providers ----------------------------------------------------------

	disposables.push(monaco.languages.registerHoverProvider('stan', {
		async provideHover(model, position) {
			const result = await client.request<{ contents: unknown; range?: LspRange } | null>('textDocument/hover', {
				textDocument: { uri: model.uri.toString() },
				position: toLspPosition(position),
			}).catch(() => null);
			if (!result) {
				return null;
			}
			return {
				contents: toMarkdownStrings(result.contents),
				range: result.range ? toMonacoRange(result.range) : undefined,
			};
		},
	}));

	disposables.push(monaco.languages.registerCompletionItemProvider('stan', {
		triggerCharacters: ['~', '.'],
		async provideCompletionItems(model, position) {
			const result = await client.request<unknown>('textDocument/completion', {
				textDocument: { uri: model.uri.toString() },
				position: toLspPosition(position),
			}).catch(() => null);
			const items = Array.isArray(result) ? result : (result as { items?: unknown[] } | null)?.items ?? [];
			const word = model.getWordUntilPosition(position);
			const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
			return {
				suggestions: (items as {
					label: string;
					kind?: number;
					detail?: string;
					documentation?: unknown;
					insertText?: string;
					sortText?: string;
				}[]).map((item) => ({
					label: item.label,
					kind: toMonacoCompletionKind(item.kind),
					detail: item.detail,
					documentation: toDocumentation(item.documentation),
					insertText: item.insertText ?? item.label,
					sortText: item.sortText,
					range,
				})),
			};
		},
	}));

	disposables.push(monaco.languages.registerDocumentFormattingEditProvider('stan', {
		async provideDocumentFormattingEdits(model) {
			const edits = await client.request<{ range: LspRange; newText: string }[] | null>('textDocument/formatting', {
				textDocument: { uri: model.uri.toString() },
				options: { tabSize: 2, insertSpaces: true },
			}).catch(() => null);
			return (edits ?? []).map((edit) => ({
				range: toMonacoRange(edit.range),
				text: edit.newText,
			}));
		},
	}));

	return {
		dispose(): void {
			for (const disposable of disposables) {
				disposable.dispose();
			}
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			worker.terminate();
		},
	};
}

// --- LSP ↔ monaco conversions ---------------------------------------------

interface LspRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

function toLspPosition(position: monaco.IPosition): { line: number; character: number } {
	return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toMonacoRange(range: LspRange): monaco.IRange {
	return {
		startLineNumber: range.start.line + 1,
		startColumn: range.start.character + 1,
		endLineNumber: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

function toMarkerSeverity(severity: number | undefined): monaco.editor.IMarkerData['severity'] {
	switch (severity) {
		case 1: return monaco.MarkerSeverity.Error;
		case 2: return monaco.MarkerSeverity.Warning;
		case 3: return monaco.MarkerSeverity.Info;
		case 4: return monaco.MarkerSeverity.Hint;
		default: return monaco.MarkerSeverity.Error;
	}
}

function toMarkdownStrings(contents: unknown): { value: string }[] {
	const toValue = (entry: unknown): string => {
		if (typeof entry === 'string') {
			return entry;
		}
		if (entry && typeof entry === 'object' && 'value' in entry) {
			return String((entry as { value: unknown }).value);
		}
		return '';
	};
	const list = Array.isArray(contents) ? contents : [contents];
	return list.map(toValue).filter(Boolean).map(value => ({ value }));
}

function toDocumentation(documentation: unknown): string | { value: string } | undefined {
	if (documentation === undefined || documentation === null) {
		return undefined;
	}
	if (typeof documentation === 'string') {
		return documentation;
	}
	return { value: String((documentation as { value?: unknown }).value ?? '') };
}

function toMonacoCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
	const kinds = monaco.languages.CompletionItemKind;
	// LSP CompletionItemKind → monaco's (different numberings)
	switch (kind) {
		case 2: return kinds.Method;
		case 3: return kinds.Function;
		case 4: return kinds.Constructor;
		case 5: return kinds.Field;
		case 6: return kinds.Variable;
		case 7: return kinds.Class;
		case 8: return kinds.Interface;
		case 9: return kinds.Module;
		case 10: return kinds.Property;
		case 12: return kinds.Value;
		case 13: return kinds.Enum;
		case 14: return kinds.Keyword;
		case 15: return kinds.Snippet;
		case 21: return kinds.Constant;
		case 22: return kinds.Struct;
		default: return kinds.Text;
	}
}

function findModel(uri: string): monaco.editor.ITextModel | undefined {
	return monaco.editor.getModels().find(model => model.uri.toString() === uri);
}
