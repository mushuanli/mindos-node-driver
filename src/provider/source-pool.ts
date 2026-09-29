import { checkOperation, FSError, operationScope, type FileSystemSourceOwner, type OperationOptions } from '@itookit/vfs-core';

interface Entry {
    source: Promise<FileSystemSourceOwner>;
    controller: AbortController;
    refs: number;
    closing?: Promise<void>;
}

/** Each subscriber owns its wait; only the final release cancels shared initialization. */
export class SourcePool {
    private readonly entries = new Map<string, Entry>();
    private closed = false;

    async acquire(key: string, open: (signal: AbortSignal) => Promise<FileSystemSourceOwner>, options?: OperationOptions): Promise<FileSystemSourceOwner> {
        if (this.closed) throw new FSError('EACCES', 'HTTP source provider is closed');
        const scope = operationScope(options);
        let entry: Entry | undefined;
        try {
            checkOperation(scope.options);
            entry = this.entries.get(key) ?? this.create(key, open);
            entry.refs++;
            const source = await waitFor(entry.source, scope.options.signal);
            checkOperation({ signal: entry.controller.signal });
            const owned = entry;
            let released = false;
            return { fs: source.fs, dispose: async () => {
                if (released) return;
                released = true;
                await this.release(key, owned);
            } };
        } catch (error) {
            if (entry) void this.release(key, entry).catch(() => {});
            throw error;
        } finally { scope.dispose(); }
    }

    private create(key: string, open: (signal: AbortSignal) => Promise<FileSystemSourceOwner>): Entry {
        const controller = new AbortController();
        const entry: Entry = { controller, refs: 0, source: Promise.resolve().then(() => open(controller.signal)) };
        this.entries.set(key, entry);
        void entry.source.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
        return entry;
    }

    private release(key: string, entry: Entry): Promise<void> {
        if (entry.refs > 0) entry.refs--;
        return entry.refs === 0 ? this.close(key, entry) : Promise.resolve();
    }

    private close(key: string, entry: Entry): Promise<void> {
        if (entry.closing) return entry.closing;
        if (this.entries.get(key) === entry) this.entries.delete(key);
        entry.controller.abort();
        entry.closing = entry.source.then(source => source.dispose(), () => {});
        return entry.closing;
    }

    async dispose(): Promise<void> {
        this.closed = true;
        await Promise.all([...this.entries].map(([key, entry]) => this.close(key, entry)));
    }
}

/** Detach the subscriber even when a host-provided initializer does not observe abort. */
function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    checkOperation({ signal });
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            try { checkOperation({ signal }); } catch (error) { reject(error); }
        };
        signal.addEventListener('abort', abort, { once: true });
        void pending.then(value => {
            checkOperation({ signal });
            resolve(value);
        }).catch(reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
