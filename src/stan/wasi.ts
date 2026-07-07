// Minimal WASI preview1 host for the compiled Stan models: the compile
// server (stan-wasm-wasi) produces pure command modules — exported _start
// and memory, importing only wasi_snapshot_preview1 — that read argv, write
// stdio, and read the clock. No filesystem, no environment, no threads.
//
// The full import surface of a server-compiled model (verified):
//   args_get, args_sizes_get, environ_get, environ_sizes_get,
//   clock_time_get, fd_write, fd_read, fd_close, fd_seek, proc_exit
// Anything else the toolchain might add in the future is stubbed to ENOSYS
// so it fails with a readable error instead of a link error.

export interface WasiRunOptions {
	module: WebAssembly.Module;
	/** argv, excluding argv[0] (the module name). */
	args: string[];
	/** Raw bytes written to stdout (fd 1). */
	onStdout: (bytes: Uint8Array) => void;
	/** Raw bytes written to stderr (fd 2). */
	onStderr: (bytes: Uint8Array) => void;
}

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;
const ERRNO_SPIPE = 70;

/** Thrown by proc_exit to unwind out of _start. */
class ProcExit {
	constructor(readonly code: number) {}
}

/** Instantiates the command module and runs it to completion (this blocks
 *  the calling thread — run it in a worker). Resolves with the exit code. */
export async function runWasiModule({ module, args, onStdout, onStderr }: WasiRunOptions): Promise<number> {
	let memory: WebAssembly.Memory;
	const view = () => new DataView(memory.buffer);
	const mem = () => new Uint8Array(memory.buffer);

	const encoder = new TextEncoder();
	const argv = ['main.wasm', ...args].map((arg) => encoder.encode(arg + '\0'));

	const wasi: Record<string, (...args: never[]) => unknown> = {
		args_sizes_get(argcPtr: number, bufSizePtr: number): number {
			view().setUint32(argcPtr, argv.length, true);
			view().setUint32(bufSizePtr, argv.reduce((size, arg) => size + arg.length, 0), true);
			return ERRNO_SUCCESS;
		},
		args_get(argvPtr: number, bufPtr: number): number {
			for (const arg of argv) {
				view().setUint32(argvPtr, bufPtr, true);
				mem().set(arg, bufPtr);
				argvPtr += 4;
				bufPtr += arg.length;
			}
			return ERRNO_SUCCESS;
		},
		environ_sizes_get(countPtr: number, bufSizePtr: number): number {
			view().setUint32(countPtr, 0, true);
			view().setUint32(bufSizePtr, 0, true);
			return ERRNO_SUCCESS;
		},
		environ_get(): number {
			return ERRNO_SUCCESS;
		},
		clock_time_get(id: number, _precision: bigint, timePtr: number): number {
			// 0 = realtime, 1 = monotonic; nanoseconds as u64
			const nanos = id === 0
				? BigInt(Date.now()) * 1_000_000n
				: BigInt(Math.round(performance.now() * 1e6));
			view().setBigUint64(timePtr, nanos, true);
			return ERRNO_SUCCESS;
		},
		fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			if (fd !== 1 && fd !== 2) {
				return ERRNO_BADF;
			}
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				const ptr = view().getUint32(iovsPtr + i * 8, true);
				const len = view().getUint32(iovsPtr + i * 8 + 4, true);
				if (len > 0) {
					// slice (not subarray): the receiver keeps the bytes
					(fd === 1 ? onStdout : onStderr)(mem().slice(ptr, ptr + len));
					written += len;
				}
			}
			view().setUint32(nwrittenPtr, written, true);
			return ERRNO_SUCCESS;
		},
		fd_read(_fd: number, _iovsPtr: number, _iovsLen: number, nreadPtr: number): number {
			view().setUint32(nreadPtr, 0, true); // EOF
			return ERRNO_SUCCESS;
		},
		fd_close(_fd: number): number {
			return ERRNO_SUCCESS;
		},
		fd_seek(_fd: number, _offset: bigint, _whence: number, _newOffsetPtr: number): number {
			return ERRNO_SPIPE; // stdio is not seekable
		},
		proc_exit(code: number): never {
			throw new ProcExit(code);
		},
	};

	for (const imported of WebAssembly.Module.imports(module)) {
		if (imported.module === 'wasi_snapshot_preview1' && !(imported.name in wasi)) {
			const name = imported.name;
			wasi[name] = () => {
				onStderr(encoder.encode(`wasi: unimplemented syscall ${name}\n`));
				return ERRNO_NOSYS;
			};
		}
	}

	// modules built with -sALLOW_MEMORY_GROWTH import this one benign
	// notification hook; everything else stays pure WASI preview1
	const env = { emscripten_notify_memory_growth: (_index: number) => {} };
	const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi, env });
	memory = instance.exports.memory as WebAssembly.Memory;
	try {
		(instance.exports._start as () => void)();
		return 0;
	} catch (error) {
		if (error instanceof ProcExit) {
			return error.code;
		}
		throw error;
	}
}
