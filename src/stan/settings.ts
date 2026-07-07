// The Stan compilation server: compiling .stan source to WebAssembly needs a
// server (stan-wasm-wasi; see the README). The URL is a user setting
// persisted in localStorage, shared by all projects.
//
// The default is the hosted instance on fly.io. It allows any origin (CORS),
// caches compiled models by source hash, and auto-stops when idle — the
// first compile after an idle period pays a ~30 s cold start.

const SERVER_URL_KEY = 'stan-web-ide.compileServerUrl';

export const DEFAULT_SERVER_URL = 'https://stan-wasm-wasi.fly.dev';
export const LOCAL_SERVER_DOCKER_COMMAND =
	'docker build -t stan-wasm-wasi https://github.com/magland/stan-wasm-wasi.git && docker run --rm -p 8083:8080 stan-wasm-wasi';

type Listener = (url: string) => void;
const listeners = new Set<Listener>();

export function getServerUrl(): string {
	return localStorage.getItem(SERVER_URL_KEY) || DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string): void {
	const trimmed = url.trim().replace(/\/+$/, '');
	if (trimmed) {
		localStorage.setItem(SERVER_URL_KEY, trimmed);
	} else {
		localStorage.removeItem(SERVER_URL_KEY);
	}
	for (const listener of listeners) {
		listener(getServerUrl());
	}
}

export function onDidChangeServerUrl(listener: Listener): { dispose(): void } {
	listeners.add(listener);
	return { dispose: () => listeners.delete(listener) };
}

/** GET {serverUrl}/probe — true when the compile server is reachable. */
export async function probeServer(url: string): Promise<boolean> {
	if (!url.startsWith('http://') && !url.startsWith('https://')) {
		return false;
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		const response = await fetch(`${url}/probe`, { signal: controller.signal });
		clearTimeout(timer);
		return response.ok;
	} catch {
		return false;
	}
}
