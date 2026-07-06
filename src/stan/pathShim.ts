// Browser stand-in for node's 'path', aliased in vite.config.ts:
// stan-language-server imports { join } for #include resolution.

export function join(...parts: string[]): string {
	return parts.join('/').replace(/\/{2,}/g, '/');
}

export default { join };
