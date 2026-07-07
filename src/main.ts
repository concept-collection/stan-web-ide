import { loadBuiltinTheme, registerBuiltinLanguages } from 'minwebide';
import { openGitHubRoute } from './githubOpen';
import { openIde } from './ide';
import { renderLanding } from './landing';
import { registerStanLanguage } from './stan/language';
import { registerStanLsp } from './stan/lsp';
import { getProject } from './projects';

// Routes:
//   #/                     project picker (landing page)
//   #/project/<id>         the IDE, opened on that project's file system
//   #/github/<spec>        a GitHub repo as its own workspace (owner/repo[@ref],
//                          or a URL-encoded github.com URL); imports on first
//                          visit, then keeps a local editable copy — the URL
//                          stays on this route and no project is created

async function start(): Promise<void> {
	// this app no longer uses a service worker (pure-WASI sampling needs no
	// cross-origin isolation) — unregister the coi-serviceworker that earlier
	// deployed versions registered, since a stale controlling SW keeps
	// rewriting response headers
	if ('serviceWorker' in navigator) {
		const registrations = await navigator.serviceWorker.getRegistrations();
		if (registrations.length > 0) {
			await Promise.all(registrations.map(r => r.unregister()));
			if (navigator.serviceWorker.controller) {
				location.reload();
				return;
			}
		}
	}

	const app = document.getElementById('app')!;

	// one-time global setup: theme + languages are shared by all views;
	// Stan registers last so it owns .stan (and .sample maps to YAML)
	const theme = await loadBuiltinTheme('dark_modern');
	await registerBuiltinLanguages(theme);
	registerStanLanguage();
	// the Stan language server (diagnostics, hover, completion, format) runs
	// in one worker for the whole session, across projects
	registerStanLsp();

	let current: { dispose(): void } | undefined;
	let navigating = false;

	const route = async () => {
		if (navigating) {
			return;
		}
		navigating = true;
		try {
			current?.dispose();
			current = undefined;
			app.textContent = '';

			const github = location.hash.match(/^#\/github\/(.+)$/);
			if (github) {
				current = await openGitHubRoute(app, decodeURIComponent(github[1]), theme);
				return;
			}

			const match = location.hash.match(/^#\/project\/([a-z0-9]+)/i);
			if (match) {
				const project = getProject(match[1]);
				if (project) {
					current = await openIde(app, project, theme);
					return;
				}
				// unknown project id: fall through to the landing page
				history.replaceState(null, '', '#/');
			}
			current = renderLanding(app, theme);
		} finally {
			navigating = false;
		}
	};

	window.addEventListener('hashchange', route);
	await route();
}

start();
