import { createWorkbench, type WorkbenchTheme } from 'minwebide';
import { openProjectFileSystem, touchProject, type ProjectInfo } from './projects';
import { createStanRunner } from './stan/runner';
import { createSampleEditorProvider } from './stan/sampleEditor';
import { showServerDialog } from './stan/serverDialog';
import { getServerUrl, onDidChangeServerUrl, probeServer } from './stan/settings';

/** Opens the IDE for a project. Returns a disposable view. */
export async function openIde(container: HTMLElement, project: ProjectInfo, theme: WorkbenchTheme): Promise<{ dispose(): void }> {
	touchProject(project.id);
	document.title = `${project.name} — stan web IDE`;

	const fs = await openProjectFileSystem(project.id);
	const stan = createStanRunner(fs);

	const workbench = createWorkbench(container, {
		fileSystem: fs,
		theme,
		workspaceName: project.name,
	});
	workbench.registerRunner(stan.runner);
	workbench.registerCustomEditor(createSampleEditorProvider(fs, workbench, { stop: stan.stop }));

	// the project indicator: click to go back to the project list
	workbench.statusBar.setItem('project', 'left', project.name, {
		icon: 'folder-opened',
		title: 'Back to projects',
		onClick: () => { location.hash = '#/'; },
	});
	// replace the default branding item with the project indicator
	workbench.statusBar.removeItem('branding');

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

	// open the most useful starting file
	for (const path of ['/fit.sample', '/main.stan', '/README.md']) {
		const uri = fs.root.with({ path });
		if (await fs.fileService.exists(uri)) {
			await workbench.openFile(uri);
			break;
		}
	}

	return {
		dispose() {
			disposed = true;
			serverListener.dispose();
			stan.dispose();
			workbench.dispose();
			fs.dispose();
		},
	};
}
