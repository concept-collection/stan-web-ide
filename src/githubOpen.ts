import { applyThemeToElement, attachGitHubWorkspace, createIndexedDBFileSystem, parseGitHubSpec, type WorkbenchTheme } from 'minwebide';
import { openStanWorkbench, openStartingFile } from './ide';
import './landing.css';

// The #/github/<spec> route: a GitHub repository as a workspace of its own.
// <spec> is anything parseGitHubSpec accepts — owner/repo, owner/repo@ref, or
// a URL-encoded github.com URL. The URL is the identity: nothing is added to
// the project registry. The first visit imports into a per-repo IndexedDB
// database; later visits reopen that local copy, edits included, with the
// Source Control view tracking changes against the imported commit (and
// offering "Reload from GitHub" to start fresh).

/** Handles a #/github/<spec> route. Returns a disposable view (the IDE, or an error screen). */
export async function openGitHubRoute(container: HTMLElement, specText: string, theme: WorkbenchTheme): Promise<{ dispose(): void }> {
	let fs: Awaited<ReturnType<typeof createIndexedDBFileSystem>> | undefined;
	let ide: Awaited<ReturnType<typeof openStanWorkbench>> | undefined;
	try {
		const spec = parseGitHubSpec(specText);
		const name = `${spec.owner}/${spec.repo}`;
		document.title = `${name} — stan web IDE`;
		const dbName = `stan-web-ide-gh-${spec.owner}-${spec.repo}${spec.ref ? `-${spec.ref}` : ''}${spec.dir ? `-${spec.dir}` : ''}`
			.toLowerCase().replace(/[^a-z0-9._-]/g, '-');

		fs = await createIndexedDBFileSystem({ dbName });
		ide = await openStanWorkbench(container, fs, name, theme);
		ide.workbench.statusBar.removeItem('branding');
		ide.workbench.statusBar.setItem('project', 'left', 'Projects', {
			icon: 'arrow-left',
			title: 'Back to projects',
			onClick: () => { location.hash = '#/'; },
		});

		// imports on first visit (status bar progress + GitHub output channel);
		// the README is left to openStartingFile, which prefers stan entry points
		const view = await attachGitHubWorkspace(ide.workbench, fs, spec, { autoOpenReadme: false, appName: 'stan web IDE' });
		await openStartingFile(fs, ide.workbench);

		return {
			dispose() {
				view.dispose();
				ide!.dispose();
				fs!.dispose();
			},
		};
	} catch (error) {
		ide?.dispose();
		fs?.dispose();
		container.textContent = '';
		const message = error instanceof Error ? error.message : String(error);
		return renderErrorScreen(container, theme, `Could not open repository: ${message}`);
	}
}

function renderErrorScreen(container: HTMLElement, theme: WorkbenchTheme, text: string): { dispose(): void } {
	const root = document.createElement('div');
	root.className = 'landing';
	applyThemeToElement(theme, root);
	const inner = document.createElement('div');
	inner.className = 'landing-inner';
	const message = document.createElement('p');
	message.className = 'landing-subtitle';
	message.textContent = text;
	inner.appendChild(message);
	const back = document.createElement('a');
	back.className = 'landing-link';
	back.href = '#/';
	back.textContent = 'Back to projects';
	inner.appendChild(back);
	root.appendChild(inner);
	container.appendChild(root);
	return { dispose: () => root.remove() };
}
