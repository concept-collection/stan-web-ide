import { loadBuiltinTheme, registerBuiltinLanguages } from 'minwebide';
import { openIde } from './ide';
import { renderLanding } from './landing';
import { registerStanLanguage } from './stan/language';
import { registerStanLsp } from './stan/lsp';
import { getProject } from './projects';

// Routes:
//   #/                     project picker (landing page)
//   #/project/<id>         the IDE, opened on that project's file system

async function start(): Promise<void> {
	// dev never uses a service worker (isolation comes from server headers) —
	// unregister any stale coi-serviceworker left over from a production
	// build or an earlier version, since a controlling stale SW can block
	// module workers with mismatched COEP headers
	if (import.meta.env.DEV && 'serviceWorker' in navigator) {
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
