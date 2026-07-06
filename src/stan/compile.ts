// Client for the stan-wasm-server compile endpoint (the same protocol as
// stan-playground): POST the .stan source, get a model id, and reference the
// compiled emscripten module at /download/{model_id}/main.js. The server
// caches compilations by source hash; on top of that we keep a small
// in-session cache so re-running an unchanged model skips the round trip
// (validated with a HEAD request, since server redeploys invalidate ids).

export interface CompileResult {
	mainJsUrl?: string;
	error?: string;
}

const cache = new Map<string, string>();

export async function compileStanProgram(
	serverUrl: string,
	stanProgram: string,
	onStatus: (message: string) => void,
): Promise<CompileResult> {
	const cacheKey = `${serverUrl}\0${stanProgram}`;

	const cached = cache.get(cacheKey);
	if (cached && await urlExists(cached)) {
		onStatus('compiled (cached)');
		return { mainJsUrl: cached };
	}

	try {
		onStatus('compiling...');
		const response = await fetch(`${serverUrl}/compile`, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				// the stan-wasm-server passcode (fixed, same as stan-playground)
				'Authorization': 'Bearer 1234',
			},
			body: stanProgram,
		});
		if (!response.ok) {
			return { error: `compilation failed: ${await messageOrStatus(response)}` };
		}
		const { model_id } = await response.json();
		const mainJsUrl = `${serverUrl}/download/${model_id}/main.js`;

		onStatus('checking download of main.js');
		if (!await urlExists(mainJsUrl)) {
			return { error: `compiled, but main.js is not downloadable from ${mainJsUrl}` };
		}

		cache.set(cacheKey, mainJsUrl);
		onStatus('compiled');
		return { mainJsUrl };
	} catch (error) {
		return { error: `compilation request failed: ${error} (is the compile server at ${serverUrl} running, and does its CORS allowlist include this origin?)` };
	}
}

async function urlExists(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, { method: 'HEAD' });
		return response.ok;
	} catch {
		return false;
	}
}

async function messageOrStatus(response: Response): Promise<string> {
	try {
		const body = await response.json();
		return body?.message ?? response.statusText;
	} catch {
		return response.statusText;
	}
}
