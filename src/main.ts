import { loadBuiltinTheme, registerBuiltinLanguages, startProjectApp, type ProjectAppConfig } from 'minwebide';
import { openStanWorkbench } from './ide';
import { registerStanLanguage } from './stan/language';
import { registerStanLsp } from './stan/lsp';
import { emptyWorkspace, sampleWorkspace } from './sampleWorkspace';

const config: ProjectAppConfig = {
	appId: 'stan-web-ide',
	appName: 'stan web IDE',
	assembleWorkbench: openStanWorkbench,
	startingFiles: ['/fit.sample', '/main.stan', '/README.md'],
	landing: {
		subtitle: 'Run Stan sampling in your browser. Projects are stored locally, in your browser.',
		links: [
			{ label: 'mc-stan.org', href: 'https://mc-stan.org' },
			{ label: 'stan-playground', href: 'https://stan-playground.flatironinstitute.org' },
			{ label: 'github.com/concept-collection/stan-web-ide', href: 'https://github.com/concept-collection/stan-web-ide' },
		],
		sampleWorkspace,
		sampleButtonTitle: 'Seeded with a linear-regression model, data, and ready-to-run .sample configs',
		emptyWorkspace: () => emptyWorkspace,
	},
};

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

	// one-time global setup: theme + languages are shared by all views;
	// Stan registers last so it owns .stan (and .sample maps to YAML)
	const theme = await loadBuiltinTheme('dark_modern');
	await registerBuiltinLanguages(theme);
	registerStanLanguage();
	// the Stan language server (diagnostics, hover, completion, format) runs
	// in one worker for the whole session, across projects
	registerStanLsp();

	await startProjectApp(document.getElementById('app')!, theme, config);
}

start();
