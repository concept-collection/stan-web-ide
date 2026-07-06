// The Stan compilation server: compiling .stan source to WebAssembly needs a
// server (stan-playground's stan-wasm-server; see the README). The URL is a
// user setting persisted in localStorage, shared by all projects.
//
// Note the server's CORS allowlist must include this app's origin. The stock
// docker image (ghcr.io/flatironinstitute/stan-wasm-server) allows
// http://127.0.0.1:3000 and http://127.0.0.1:4173 — which is why dev/preview
// run on those ports.

const SERVER_URL_KEY = 'stan-web-ide.compileServerUrl';

export const DEFAULT_SERVER_URL = 'http://localhost:8083';
export const LOCAL_SERVER_DOCKER_COMMAND =
	'docker run -p 8083:8080 -it ghcr.io/flatironinstitute/stan-wasm-server:latest';

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
