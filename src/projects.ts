import { createIndexedDBFileSystem, type WorkspaceFileSystem } from 'minwebide';

// The project registry: a small localStorage index of projects, each backed
// by its own IndexedDB database (its own workspace file system).

export interface ProjectInfo {
	readonly id: string;
	name: string;
	createdAt: number;
	lastOpenedAt: number;
}

const REGISTRY_KEY = 'stan-web-ide.projects';

function readRegistry(): ProjectInfo[] {
	try {
		const raw = localStorage.getItem(REGISTRY_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeRegistry(projects: ProjectInfo[]): void {
	localStorage.setItem(REGISTRY_KEY, JSON.stringify(projects));
}

export function projectDbName(id: string): string {
	return `stan-web-ide-project-${id}`;
}

export function listProjects(): ProjectInfo[] {
	return readRegistry().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function getProject(id: string): ProjectInfo | undefined {
	return readRegistry().find(p => p.id === id);
}

/** Picks 'untitled', 'untitled-2', ... skipping names already in use. */
export function nextUntitledName(base = 'untitled'): string {
	const names = new Set(readRegistry().map(p => p.name));
	if (!names.has(base)) {
		return base;
	}
	for (let i = 2; ; i++) {
		if (!names.has(`${base}-${i}`)) {
			return `${base}-${i}`;
		}
	}
}

export function createProject(name: string): ProjectInfo {
	const project: ProjectInfo = {
		id: Math.random().toString(36).slice(2, 10),
		name,
		createdAt: Date.now(),
		lastOpenedAt: Date.now(),
	};
	writeRegistry([...readRegistry(), project]);
	return project;
}

export function renameProject(id: string, name: string): void {
	const projects = readRegistry();
	const project = projects.find(p => p.id === id);
	if (project && name.trim()) {
		project.name = name.trim();
		writeRegistry(projects);
	}
}

export function touchProject(id: string): void {
	const projects = readRegistry();
	const project = projects.find(p => p.id === id);
	if (project) {
		project.lastOpenedAt = Date.now();
		writeRegistry(projects);
	}
}

export async function deleteProject(id: string): Promise<void> {
	writeRegistry(readRegistry().filter(p => p.id !== id));
	await new Promise<void>((resolve) => {
		const request = indexedDB.deleteDatabase(projectDbName(id));
		request.onsuccess = request.onerror = request.onblocked = () => resolve();
	});
}

export async function openProjectFileSystem(id: string): Promise<WorkspaceFileSystem> {
	return createIndexedDBFileSystem({ dbName: projectDbName(id) });
}

/** Copies all files of one project into a brand-new project. */
export async function duplicateProject(id: string): Promise<ProjectInfo | undefined> {
	const source = getProject(id);
	if (!source) {
		return undefined;
	}
	const copy = createProject(nextUntitledName(`${source.name}-copy`));
	const sourceFs = await openProjectFileSystem(source.id);
	const targetFs = await openProjectFileSystem(copy.id);
	try {
		const copyTree = async (path: string): Promise<void> => {
			const stat = await sourceFs.fileService.resolve(sourceFs.root.with({ path }));
			for (const child of stat.children ?? []) {
				if (child.isDirectory) {
					await targetFs.fileService.createFolder(targetFs.root.with({ path: child.resource.path }));
					await copyTree(child.resource.path);
				} else {
					const content = await sourceFs.fileService.readFile(child.resource);
					await targetFs.fileService.writeFile(targetFs.root.with({ path: child.resource.path }), content.value);
				}
			}
		};
		await copyTree('/');
	} finally {
		sourceFs.dispose();
		targetFs.dispose();
	}
	return copy;
}
