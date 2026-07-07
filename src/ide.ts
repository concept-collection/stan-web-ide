import { createWorkbench, type AppWorkbench, type WorkbenchTheme, type WorkspaceFileSystem } from 'minwebide';
import { createCsvTableProvider } from './csvTable';
import { createResultsViewProvider } from './stan/resultsView';
import { createStanRunner } from './stan/runner';
import { createSampleEditorProvider } from './stan/sampleEditor';
import { showServerDialog } from './stan/serverDialog';
import { getServerUrl, onDidChangeServerUrl, probeServer } from './stan/settings';

/**
 * Assembles the Stan workbench (runner, custom editors, compile-server status
 * item) on a file system. Used by the project-app shell for both project IDEs
 * and GitHub repo IDEs; does not own `fs` — the caller disposes it.
 */
export async function openStanWorkbench(container: HTMLElement, fs: WorkspaceFileSystem, workspaceName: string, theme: WorkbenchTheme): Promise<AppWorkbench> {
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
