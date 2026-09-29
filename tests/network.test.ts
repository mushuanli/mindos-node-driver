import { HttpTransport } from '../src/transport';
import { it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createFile } from '@itookit/vfs-core';
import { HttpProcessSession, discoverServer, openHttpFileSource } from '../src';

// The server lives in its own repository under tools/; this integration test only runs where that
// Cargo manifest is present. The fixture below must match src/config.rs of that server.
const manifest = resolve('../../tools/fs-agent/Cargo.toml');

it.skipIf(process.platform !== 'linux' || !existsSync(manifest))('reads, conditionally saves and cancels against the real Rust server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'http-vfs-'));
    const root = join(directory, 'data');
    const { mkdir } = await import('node:fs/promises'); await mkdir(root);
    await writeFile(join(root, 'note.txt'), 'original');
    const config = join(directory, 'server.toml');
    // Single-user config: top-level credentials plus a flat export list.
    await writeFile(config, `listen = "127.0.0.1:0"
${process.env.FS_AGENT_PROCESS_TEST === '1' ? 'execution = true\nserver_id = "network-node"' : ''}
username = "test"
password_env = "TEST_FS_PASSWORD"

[[exports]]
alias = "docs"
path = ${JSON.stringify(root)}
access = "rw"
`);
    const password = 'integration-password';
    const child = spawn('cargo', ['run', '--quiet', '--manifest-path', manifest, '--', config],
        { env: { ...process.env, TEST_FS_PASSWORD: password }, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit');
    let owner: Awaited<ReturnType<typeof openHttpFileSource>> | undefined;
    try {
        const endpoint = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fs-server startup timeout')), 60_000);
            let output = '';
            child.stderr.on('data', data => {
                output += data; const match = output.match(/listening on (127\.0\.0\.1:\d+)/);
                if (match) { clearTimeout(timer); resolve(`http://${match[1]}`); }
            });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`fs-server exited ${code}: ${output}`)); });
        });
        owner = await openHttpFileSource({ endpoint, alias: 'docs', username: 'test', credential: () => password });
        const a = createFile(owner.fs, '/note.txt'), b = createFile(owner.fs, '/note.txt');
        expect(await a.read({ encoding: 'utf-8' })).toBe('original'); expect(await b.read({ encoding: 'utf-8' })).toBe('original');
        await a.write('updated');
        await expect(b.write('lost update')).rejects.toMatchObject({ code: 'ECONFLICT', outcome: 'not-committed' });
        expect(await a.read({ encoding: 'utf-8' })).toBe('updated');
        expect(new TextDecoder().decode(await owner.fs.driver.readContent('/note.txt', { encoding: 'binary', offset: 1, length: 3 }))).toBe('pda');
        await owner.fs.driver.createFile({ parentPath: '/', name: 'new.txt', content: 'new' });
        await owner.fs.driver.rename('/new.txt', 'moved.txt');
        await owner.fs.driver.delete(['/moved.txt']);
        const controller = new AbortController(); controller.abort();
        await expect(owner.fs.driver.readContent('/note.txt', { signal: controller.signal })).rejects.toMatchObject({ code: 'ECANCELLED' });
        if (process.env.FS_AGENT_PROCESS_TEST === '1') {
            const transport = new HttpTransport({ endpoint, username: 'test', credential: () => password });
            const caps = await discoverServer(transport);
            expect(caps.process.exec).toBe(true);
            const execution = new HttpProcessSession(transport, { serverId: caps.serverId!, epoch: caps.processEpoch!, cwd: '/workspace',
                mounts: [{ alias: 'docs', path: '', at: '/workspace', access: 'rw' }] });
            await b.read({ encoding: 'utf-8' });
            const result = await execution.nativeShell.exec('/bin/bash', ['-c', 'pwd; echo shell > note.txt']);
            expect(result.stdout.trim()).toBe('/workspace');
            expect(await a.read({ encoding: 'utf-8' })).toBe('shell\n');
            await expect(b.write('stale')).rejects.toMatchObject({ code: 'ECONFLICT' });
            const stop = new AbortController();
            const running = execution.nativeShell.exec('/bin/bash', ['-c', 'sleep 30'], { signal: stop.signal });
            setTimeout(() => stop.abort(), 100);
            await expect(running).rejects.toThrow();
            await execution.release();
        }
        expect((await readdir(root)).filter(name => name.startsWith('.itookit-upload-'))).toEqual([]);
    } finally {
        await owner?.dispose(); child.kill('SIGINT'); await exited; await rm(directory, { recursive: true, force: true });
    }
}, 90_000);
