/**
 * What these tests hold down is the security property, not the ergonomics: the printed
 * challenge is the hash of what is on disk, the file is not readable by anyone else,
 * and the verifier is gone after a pull however that pull ended.
 *
 * The server here is a stub. This is the CLI's half of the exchange; the other half —
 * that Delpat OS accepts this verifier for this challenge — is a hand walk against a
 * dev server and cannot be asserted from here.
 *
 * The CLI is spawned asynchronously rather than with spawnSync, because the stub runs
 * in this process: a synchronous spawn blocks the event loop, so the stub could never
 * answer the request it is waiting on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/delpat-env.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';

/** A throwaway home, so no test can touch the developer's own pending directory. */
function fakeHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delpat-env-home-'));
    return { home, pending: path.join(home, '.delpat-env', 'pending') };
}

function run(home, args, extra = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, ...args], {
            cwd: extra.cwd || process.cwd(),
            env: { ...process.env, HOME: home, USERPROFILE: home, DELPAT_TICKET: '' },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

function challengeFrom(stdout) {
    const m = /^Challenge: (\S+)$/m.exec(stdout);
    assert.ok(m, `no challenge in output:\n${stdout}`);
    return m[1];
}

/** A git repo with a gitignored target, which is all `pull` insists on locally. */
function fakeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delpat-env-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
    return dir;
}

/** Answers with whatever is given, and records the URLs it was asked for. */
async function stubServer(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(req.url);
        handler(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        seen,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => { server.closeAllConnections(); server.close(); },
    };
}

test('begin writes a verifier whose SHA-256 is the challenge it printed', async () => {
    const { home, pending } = fakeHome();
    const r = await run(home, ['begin']);
    assert.equal(r.status, 0, r.stderr);

    const challenge = challengeFrom(r.stdout);
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, 'the challenge must be 43 unpadded base64url characters');

    const verifier = fs.readFileSync(path.join(pending, challenge), 'utf8');
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);

    // The whole point: the verifier is in nothing the model gets to read.
    assert.ok(!r.stdout.includes(verifier), 'begin printed the verifier');
    assert.ok(!r.stderr.includes(verifier));
});

test('begin prints the exact pull command, with the challenge filled in', async () => {
    const { home } = fakeHome();
    const r = await run(home, ['begin']);
    const challenge = challengeFrom(r.stdout);
    assert.ok(
        r.stdout.includes(`pull --ticket <ticket> --challenge ${challenge}`),
        `no runnable pull command in:\n${r.stdout}`
    );
    assert.ok(r.stdout.includes(`"challenge": "${challenge}"`), 'no ticket arguments printed');
});

test('the pending file is 0600', { skip: POSIX ? false : 'Windows ignores the mode bits' }, async () => {
    const { home, pending } = fakeHome();
    const challenge = challengeFrom((await run(home, ['begin'])).stdout);
    assert.equal(fs.statSync(path.join(pending, challenge)).mode & 0o777, 0o600);
});

test('a pending file older than ten minutes is swept', async () => {
    const { home, pending } = fakeHome();
    const fresh = challengeFrom((await run(home, ['begin'])).stdout);

    const stale = path.join(pending, 'A'.repeat(43));
    fs.writeFileSync(stale, 'x');
    const old = Date.now() / 1000 - 11 * 60;
    fs.utimesSync(stale, old, old);

    await run(home, ['begin']);
    assert.ok(!fs.existsSync(stale), 'the stale verifier survived the sweep');
    assert.ok(fs.existsSync(path.join(pending, fresh)), 'the sweep took a fresh verifier');
});

test('pull sends the verifier, and deletes it when the ticket is refused', async () => {
    const { home, pending } = fakeHome();
    const challenge = challengeFrom((await run(home, ['begin'])).stdout);
    const verifier = fs.readFileSync(path.join(pending, challenge), 'utf8');

    const stub = await stubServer((req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
    });
    try {
        const r = await run(home, ['pull', '--ticket', 'tkt_bogus', '--challenge', challenge, '--url', stub.url],
            { cwd: fakeRepo() });
        assert.equal(r.status, 1, r.stdout);
        assert.equal(stub.seen.length, 1);
        assert.ok(stub.seen[0].includes(`verifier=${encodeURIComponent(verifier)}`), stub.seen[0]);
        assert.ok(!fs.existsSync(path.join(pending, challenge)), 'the verifier outlived a refused pull');
    } finally {
        stub.close();
    }
});

test('pull deletes the verifier after a pull that succeeded, and names the environment', async () => {
    const { home, pending } = fakeHome();
    const challenge = challengeFrom((await run(home, ['begin'])).stdout);
    const repo = fakeRepo();

    const stub = await stubServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            project: 'delpat-os', target: 'os prod env', environment: 'production',
            keys: ['MONGODB_URI'], undecryptable: [],
            values: { MONGODB_URI: 'mongodb://a-value-no-test-may-print' },
        }));
    });
    try {
        const r = await run(home, ['pull', '--ticket', 'tkt_ok', '--challenge', challenge, '--url', stub.url],
            { cwd: repo });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(!fs.existsSync(path.join(pending, challenge)), 'the verifier outlived a successful pull');

        assert.ok(r.stdout.includes('(production)'), r.stdout);
        assert.ok(!r.stdout.includes('a-value-no-test-may-print'), 'pull printed a value');
        assert.ok(!r.stderr.includes('a-value-no-test-may-print'));

        const written = fs.readFileSync(path.join(repo, '.env'), 'utf8');
        assert.ok(written.includes('MONGODB_URI=mongodb://a-value-no-test-may-print'));
        assert.ok(written.includes('# Environment: production.'));
        if (POSIX) assert.equal(fs.statSync(path.join(repo, '.env')).mode & 0o777, 0o600);
    } finally {
        stub.close();
    }
});

test('pull refuses a challenge it has no pending file for', async () => {
    const { home } = fakeHome();
    const r = await run(home, ['pull', '--ticket', 'tkt_x', '--challenge', 'B'.repeat(43)], { cwd: fakeRepo() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no pending pull for that challenge/);
});

test('pull refuses a challenge that is not shaped like one', async () => {
    const { home } = fakeHome();
    // A traversal attempt is the case that matters: the challenge becomes a filename.
    const r = await run(home, ['pull', '--ticket', 'tkt_x', '--challenge', '../../.ssh/id_rsa'], { cwd: fakeRepo() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a challenge/);
});

test('pull without a challenge still works, for a browser-minted ticket', async () => {
    const { home } = fakeHome();
    const repo = fakeRepo();
    const stub = await stubServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ project: 'p', target: 't', keys: ['A'], undecryptable: [], values: { A: '1' } }));
    });
    try {
        const r = await run(home, ['pull', '--ticket', 'tkt_browser', '--url', stub.url], { cwd: repo });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(!stub.seen[0].includes('verifier='), 'sent a verifier that does not exist');
        assert.ok(fs.existsSync(path.join(repo, '.env')));
    } finally {
        stub.close();
    }
});
