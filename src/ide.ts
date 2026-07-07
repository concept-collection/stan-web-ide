import { attachGitHubSourceControl, createWorkbench, type Workbench, type WorkbenchTheme, type WorkspaceFileSystem } from 'minwebide';
import { createCsvTableProvider } from './csvTable';
import { openProjectFileSystem, touchProject, type ProjectInfo } from './projects';
import { createResultsViewProvider } from './stan/resultsView';
import { createStanRunner } from './stan/runner';
import { createSampleEditorProvider } from './stan/sampleEditor';
import { showServerDialog } from './stan/serverDialog';
import { getServerUrl, onDidChangeServerUrl, probeServer } from './stan/settings';

export interface StanWorkbench {
	readonly workbench: Workbench;
	dispose(): void;
}

/**
 * Assembles the Stan workbench (runner, custom editors, compile-server status
 * item) on a file system. Shared by project IDEs and GitHub repo IDEs; does
 * not own `fs` — the caller disposes it.
 */
export async function openStanWorkbench(container: HTMLElement, fs: WorkspaceFileSystem, workspaceName: string, theme: WorkbenchTheme): Promise<StanWorkbench> {
	const workbench = createWorkbench(container, {
		fileSystem: fs,
		theme,
		workspaceName,
	});
	const stan = createStanRunner(fs, (path) => workbench.openFile(fs.root.with({ path })));
	workbench.registerRunner(stan.runner);
	workbench.registerCustomEditor(createSampleEditorProvider(fs, workbench, { stop: stan.stop }));
	workbench.registerCustomEditor(createResultsViewProvider(fs));
	workbench.registerCustomEditor(createCsvTableProvider());

	// compile-server status: shows connectivity, click to change the URL
	let disposed = false;
	const refreshServerItem = async () => {
		const url = getServerUrl();
		workbench.statusBar.setItem('stan-server', 'right', 'Stan server: checking...', {
			icon: 'server',
			title: `${url}\nClick to change the compilation server`,
			onClick: () => showServerDialog(container),
		});
		const ok = await probeServer(url);
		if (disposed || url !== getServerUrl()) {
			return;
		}
		workbench.statusBar.setItem('stan-server', 'right', `Stan server: ${ok ? 'connected' : 'offline'}`, {
			icon: ok ? 'server' : 'warning',
			title: `${url} — ${ok ? 'connected' : 'not reachable'}\nClick to change the compilation server`,
			onClick: () => showServerDialog(container),
		});
	};
	void refreshServerItem();
	const serverListener = onDidChangeServerUrl(() => void refreshServerItem());

	return {
		workbench,
		dispose() {
			disposed = true;
			serverListener.dispose();
			stan.dispose();
			workbench.dispose();
		},
	};
}

/** Opens the most useful starting file, if any. */
export async function openStartingFile(fs: WorkspaceFileSystem, workbench: Workbench): Promise<void> {
	for (const path of ['/fit.sample', '/main.stan', '/README.md']) {
		const uri = fs.root.with({ path });
		if (await fs.fileService.exists(uri)) {
			await workbench.openFile(uri);
			return;
		}
	}
}

/** Opens the IDE for a project. Returns a disposable view. */
export async function openIde(container: HTMLElement, project: ProjectInfo, theme: WorkbenchTheme): Promise<{ dispose(): void }> {
	touchProject(project.id);
	document.title = `${project.name} — stan web IDE`;

	const fs = await openProjectFileSystem(project.id);
	const ide = await openStanWorkbench(container, fs, project.name, theme);

	// the project indicator: click to go back to the project list
	ide.workbench.statusBar.setItem('project', 'left', project.name, {
		icon: 'folder-opened',
		title: 'Back to projects',
		onClick: () => { location.hash = '#/'; },
	});
	// replace the default branding item with the project indicator
	ide.workbench.statusBar.removeItem('branding');

	// source control: publish this project to a new GitHub repo, or — once
	// published — track changes and push
	const sourceControl = await attachGitHubSourceControl(ide.workbench, fs, {
		appName: 'stan web IDE',
		defaultRepoName: project.name,
		// after publishing, the repo's own route is the canonical place to work
		onPublished: ({ owner, repo }) => { location.hash = `#/github/${owner}/${repo}`; },
	});

	await openStartingFile(fs, ide.workbench);

	return {
		dispose() {
			sourceControl.dispose();
			ide.dispose();
			fs.dispose();
		},
	};
}
