/**
 * The model file on disk (docs/plugin.md): the plugin's server reads it for the tab, writes what
 * the tab sends back, and notices when something else (git, an editor, StarUML) changes it. The
 * file in the repository is the truth; the tab is a view of it.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unwatchFile,
	watchFile,
	writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { OpenFileParams } from '#lib/bridge/protocol.ts';

export class FileError extends Error {
	constructor(
		readonly code: 'outside' | 'format' | 'not_open' | 'stale' | 'io',
		message: string
	) {
		super(message);
	}
}

export const MODEL_FILE = /\.(mdj|aster|aster\.json)$/i;

interface Open {
	/** As the tab knows it: relative to the root, forward slashes. */
	path: string;
	abs: string;
	/** What the disk holds, as last read or written here; null while the file does not exist. */
	text: string | null;
	diagram?: string;
}

export class DiskFile {
	#open: Open | null = null;
	/** The open file changed on disk and is not what was last written here. */
	onOutside: (params: OpenFileParams) => void = () => {};

	constructor(
		/** Files open inside this folder only: the repository the session runs in. */
		readonly root: string,
		private readonly pollMs = 500
	) {}

	get path(): string | null {
		return this.#open?.path ?? null;
	}
	/** What to send a tab to make it show the open file; null when none is open. */
	get params(): OpenFileParams | null {
		const o = this.#open;
		return o && { path: o.path, name: basename(o.abs), text: o.text, diagram: o.diagram };
	}

	#locate(file: string): { abs: string; path: string } {
		const abs = isAbsolute(file) ? resolve(file) : resolve(this.root, file);
		const rel = relative(this.root, abs);
		if (!rel || rel.startsWith('..') || isAbsolute(rel))
			throw new FileError('outside', `${file} is outside ${this.root}; only files inside it open.`);
		if (!MODEL_FILE.test(abs))
			throw new FileError('format', `${file}: only .mdj, .aster and .aster.json files open.`);
		return { abs, path: rel.split(sep).join('/') };
	}

	#read(abs: string): string | null {
		try {
			return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
		} catch (e) {
			throw new FileError('io', e instanceof Error ? e.message : String(e));
		}
	}

	/** Makes `file` the open file, read fresh from disk (null text when it does not exist yet). */
	open(file: string, diagram?: string): OpenFileParams {
		const { abs, path } = this.#locate(file);
		const text = this.#read(abs);
		this.close();
		this.#open = { path, abs, text, diagram };
		watchFile(abs, { interval: this.pollMs, persistent: false }, () => this.check());
		return this.params!;
	}

	/** Looks at the disk now; tells `onOutside` when the file is no longer what was written here. */
	check(): boolean {
		const o = this.#open;
		if (!o) return false;
		let text: string | null;
		try {
			text = this.#read(o.abs);
		} catch {
			return false;
		}
		// A file that went away (a branch without it) leaves the tab as it is; the next save
		// writes it again.
		if (text === null || text === o.text) return false;
		o.text = text;
		this.onOutside(this.params!);
		return true;
	}

	/** Writes the tab's text. Refuses when the disk moved on: the tab is sent the new file instead. */
	write(path: string, text: string) {
		const o = this.#open;
		if (!o || o.path !== path)
			throw new FileError('not_open', `${path} is not the file open here (${o?.path ?? 'none'}).`);
		if (this.check()) throw new FileError('stale', `${path} changed on disk; the tab reloads it.`);
		if (text === o.text) return;
		try {
			mkdirSync(dirname(o.abs), { recursive: true });
			// Whole or not at all: a reader (git, the watcher) never sees half a file.
			const tmp = `${o.abs}.${process.pid}.tmp`;
			writeFileSync(tmp, text);
			renameSync(tmp, o.abs);
		} catch (e) {
			throw new FileError('io', e instanceof Error ? e.message : String(e));
		}
		o.text = text;
	}

	close() {
		if (this.#open) unwatchFile(this.#open.abs);
		this.#open = null;
	}
}
