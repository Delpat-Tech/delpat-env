#!/usr/bin/env node
/**
 * @delpat/env — writes a working env file from Delpat OS.
 *
 * This is a package rather than a curl one-liner because of the guarantees below, each
 * of which is a thing a one-liner gets wrong:
 *
 *   - no code path prints a value: no --show, no debug flag, and an HTTP failure is
 *     reported by status code, never by echoing the response body
 *   - atomic write: a temp file in the target's own directory, then a rename
 *   - mode 0600
 *   - refuses any target outside the repo root
 *   - refuses to write a target that git would track
 *   - prints key names only
 *
 * Part of Dead Drop, the credential system in Delpat OS (its design doc lives in
 * that private repo). The rule the whole system follows is: secrets go
 * server -> script -> disk, never server -> model -> disk. This file is the "script".
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MANIFEST = '.delpat-env.json';
const DEFAULT_BASE = 'https://os.delpat.in';

/* The command an agent is told to run: printed by `begin`, and named in the server's
   refusal when a challenge is missing. Pinned, because an agent following an unpinned
   line would be running whatever main happened to be. */
const PKG_REF = 'github:Delpat-Tech/delpat-env#v2.0.0';

/* --- output ---------------------------------------------------------------- */

/* Every write to stdout goes through here. There is deliberately no counterpart that
   takes a value, so there is no function in this file that could print one. */
const say = (line = '') => process.stdout.write(line + '\n');
function die(message, hint) {
    process.stderr.write(`delpat-env: ${message}\n`);
    if (hint) process.stderr.write(`            ${hint}\n`);
    process.exit(1);
}

/* --- locating the repo ------------------------------------------------------ */

function findUp(startDir, name) {
    let dir = path.resolve(startDir);
    for (;;) {
        if (fs.existsSync(path.join(dir, name))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function repoRootFrom(cwd) {
    const gitDir = findUp(cwd, '.git');
    if (gitDir) return gitDir;
    // Without git there is no gitignore check to make, and the gitignore check is one
    // of the guarantees. Refuse rather than quietly drop it.
    die('this is not a git repository.',
        'delpat-env writes into a repo, and checks the target is gitignored before it does.');
}

/**
 * The manifest is optional, and exists for the things only the repo knows: which file
 * the env belongs in, and which keys it expects. A repo that just wants its .env does
 * not need one - requiring a file to be created before a single pull can happen made
 * the common case the awkward one. Returns null when there is none.
 */
function readManifest(repoRoot) {
    const file = path.join(repoRoot, MANIFEST);
    if (!fs.existsSync(file)) return null;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        die(`${MANIFEST} is not valid JSON (${err.message}).`);
    }
    if (!parsed || typeof parsed !== 'object') die(`${MANIFEST} must be a JSON object.`);
    if (!parsed.target || typeof parsed.target !== 'string') {
        die(`${MANIFEST} needs a "target", for example ".env.local".`);
    }
    return {
        project: typeof parsed.project === 'string' ? parsed.project : null,
        target: parsed.target,
        keys: Array.isArray(parsed.keys) ? parsed.keys.filter((k) => typeof k === 'string') : [],
    };
}

/* --- the two refusals ------------------------------------------------------- */

/**
 * The target must be inside the repo. Resolved, not matched as a string: "../../.ssh/id"
 * and an absolute path both resolve out, and a separator is required on the prefix so
 * that a sibling directory named like the repo plus a suffix does not pass.
 */
function resolveTarget(repoRoot, target) {
    const root = path.resolve(repoRoot);
    const abs = path.resolve(root, target);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
        die(`the target "${target}" resolves outside the repo (${abs}).`,
            'delpat-env only writes inside the repo it is run in.');
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        die(`the target "${target}" is a directory.`);
    }
    return abs;
}

/** Fails loudly when the target is not gitignored, which is the point of the check. */
function assertGitignored(repoRoot, absTarget) {
    const rel = path.relative(repoRoot, absTarget).split(path.sep).join('/');
    let ignored = false;
    try {
        execFileSync('git', ['check-ignore', '--quiet', '--', rel], {
            cwd: repoRoot, stdio: 'ignore',
        });
        ignored = true;
    } catch (err) {
        // Exit 1 means "not ignored" — which a tracked file also is, even when .gitignore
        // names it, and that is the case worth refusing. Anything else means git could
        // not answer, and an
        // unanswered question is not a yes.
        if (err && err.status !== 1) {
            die(`git could not tell whether ${rel} is ignored (exit ${err.status ?? '?'}).`,
                'Fix the repository, or run this where git works.');
        }
    }
    if (!ignored) {
        die(`${rel} is not gitignored.`,
            `Add "${rel}" to .gitignore before pulling into it. Refusing to write a file git would track.`);
    }
}

/* --- writing ---------------------------------------------------------------- */

/**
 * Plain `KEY=value` while the value is simple; otherwise double quotes with the
 * `\\ \" \$ \n \r \t` escapes that lib/envFileParser.ts — the parser Delpat OS reads
 * blobs back with — expands. Single quotes are not used: they are literal in every
 * dotenv dialect, so a value containing one could not be escaped at all.
 *
 * `$` is escaped rather than left alone. Next loads .env through dotenv-expand, which
 * reads `$NAME` inside double quotes as a variable reference — so an unescaped
 * password of `pa$word` would arrive as `pa`, silently, and the first symptom would be
 * a failed login somewhere else entirely. Both readers take `\$` as a literal dollar.
 *
 * The value is handled here and never displayed; this function returns the file, and
 * the caller writes it to disk without looking at it.
 */
function renderEnv(values, header) {
    const lines = [header, ''];
    for (const key of Object.keys(values).sort()) {
        const v = String(values[key]);
        // A bare `$` is not simple: unquoted, dotenv-expand would read it too.
        const simple = v !== '' && /^[A-Za-z0-9_./:@+=,~-]*$/.test(v);
        const quoted = `"${v
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\$/g, '\\$')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t')}"`;
        lines.push(`${key}=${simple ? v : quoted}`);
    }
    return lines.join('\n') + '\n';
}

/**
 * Temp file in the target's own directory, then rename. Same directory so the rename
 * cannot cross a filesystem and silently become a copy, and a crash halfway leaves the
 * old file intact rather than a half-written one.
 *
 * The temp file is created 0600 by `mode`, not chmod'ed after, so there is no window in
 * which it exists world-readable.
 */
function writeAtomic(absTarget, contents) {
    const dir = path.dirname(absTarget);
    const tmp = path.join(dir, `.${path.basename(absTarget)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        fs.writeFileSync(fd, contents, { encoding: 'utf8' });
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, absTarget);
        // Windows ignores the mode bits; on POSIX this reasserts them after the rename.
        try { fs.chmodSync(absTarget, 0o600); } catch { /* not fatal */ }
    } catch (err) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        die(`could not write ${absTarget}: ${err.code || err.message}`);
    }
}

/* --- the pending verifier ---------------------------------------------------

   `begin` mints a random verifier here and prints only its SHA-256. The ticket the
   model then asks for is bound to that hash, so a ticket that leaks into a transcript,
   a log, an issue or a URL cannot be redeemed by anyone who does not also hold this
   file. The verifier itself never goes near the model and never leaves the machine.

   Home rather than the repo: nothing to gitignore, and two agents working in one
   checkout cannot collide, because the challenge is the filename. */

const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

function pendingDir() {
    return path.join(os.homedir(), '.delpat-env', 'pending');
}

/* A challenge arrives on the command line and becomes a filename, so it is held to the
   exact shape `begin` writes before it is ever joined to a path. */
function pendingFileFor(challenge) {
    if (!CHALLENGE_RE.test(String(challenge))) {
        die('that is not a challenge.',
            'A challenge is the 43-character value begin prints. Run begin again.');
    }
    return path.join(pendingDir(), challenge);
}

/**
 * A verifier is single-use, so one left behind by an abandoned `begin` is a nonce
 * nobody ever spent. Ten minutes is far longer than the 60-second ticket it belongs
 * to, so a sweep cannot race a pull that is still in flight.
 */
function sweepPending() {
    let names;
    try { names = fs.readdirSync(pendingDir()); } catch { return; }
    const cutoff = Date.now() - PENDING_MAX_AGE_MS;
    for (const name of names) {
        const file = path.join(pendingDir(), name);
        try {
            if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
        } catch { /* a file another run has already taken is not an error */ }
    }
}

function forgetPending(file) {
    try { fs.unlinkSync(file); } catch { /* already gone is the outcome we wanted */ }
}

/* --- the server ------------------------------------------------------------- */

/**
 * The only place a response body is touched. A failure is reported by status alone:
 * echoing a server error is exactly how a value ends up in a transcript.
 */
async function redeem(baseUrl, ticket, verifier) {
    /* The verifier is the same class of value as the ticket already in the query:
       single-use, and spent on arrival whether or not it matches. */
    const query = `ticket=${encodeURIComponent(ticket)}`
        + (verifier ? `&verifier=${encodeURIComponent(verifier)}` : '');
    const url = `${baseUrl.replace(/\/+$/, '')}/api/env/pull?${query}`;
    let res;
    try {
        res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'delpat-env' } });
    } catch (err) {
        die(`could not reach ${baseUrl} (${err.cause?.code || err.message}).`);
    }
    if (!res.ok) {
        const reason = {
            401: 'that ticket is not valid. Tickets last 60 seconds and work once — ask for a new one.',
            403: 'you do not have access to this project. Delpat OS has filed a request with an admin.',
            404: 'no vault for that ticket.',
            409: 'that vault is not linked to a project, so it cannot be pulled. Link it in Delpat OS first.',
            429: 'too many requests. Wait a minute.',
        }[res.status];
        die(`the server refused the pull (HTTP ${res.status}).`, reason);
    }
    let body;
    try {
        body = await res.json();
    } catch {
        die('the server sent something that was not JSON.');
    }
    if (!body || typeof body.values !== 'object' || body.values === null) {
        die('the server sent no values.');
    }
    return body;
}

/* --- commands --------------------------------------------------------------- */

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--ticket' || a === '--url' || a === '--out' || a === '--challenge') {
            const value = argv[++i];
            /* Without this a trailing --challenge is silently dropped, and the pull
               quietly falls back to the one-step path instead of saying so. */
            if (value === undefined) die(`${a} needs a value.`);
            out[a.slice(2)] = value;
        }
        else if (a.startsWith('--challenge=')) out.challenge = a.slice(12);
        else if (a.startsWith('--ticket=')) out.ticket = a.slice(9);
        else if (a.startsWith('--url=')) out.url = a.slice(6);
        else if (a.startsWith('--out=')) out.out = a.slice(6);
        else if (a === '-h' || a === '--help') out.help = true;
        else if (a.startsWith('-')) die(`unknown option "${a}".`, 'Run delpat-env --help.');
        else out._.push(a);
    }
    return out;
}

/** Key names present in an env file. Values are not parsed and not kept. */
function keyNamesIn(file) {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
            const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
            return m ? m[1] : null;
        })
        .filter(Boolean);
}

/**
 * Half of a PKCE exchange, with the model standing where the network used to: it is
 * handed the challenge and never the verifier, so the ticket it carries is redeemable
 * only on this machine. There is no persistent secret here — the verifier is a nonce
 * that `pull` deletes.
 */
function cmdBegin() {
    sweepPending();

    /* 32 bytes is 43 base64url characters with no padding: inside verifyPkce's 43..128
       bound and within its unreserved alphabet, so the server hashes it unchanged. */
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const dir = pendingDir();
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // 'wx' with the mode given at creation, so the file never exists readable to
        // anyone else, not even for the moment between a write and a chmod.
        const fd = fs.openSync(path.join(dir, challenge), 'wx', 0o600);
        fs.writeFileSync(fd, verifier, { encoding: 'utf8' });
        fs.closeSync(fd);
    } catch (err) {
        die(`could not write the pending verifier (${err.code || err.message}).`);
    }
    // Windows ignores the mode bits; on POSIX this reasserts them.
    try { fs.chmodSync(path.join(dir, challenge), 0o600); } catch { /* not fatal */ }

    say(`Challenge: ${challenge}`);
    say('');
    say('1. Ask Delpat OS for a ticket. Call request_env_ticket with:');
    say(`     { "projectId": "<the project>", "environment": "<development|staging|production>", "challenge": "${challenge}" }`);
    say('');
    say('2. Within 60 seconds of receiving the ticket, run exactly this, in this repository:');
    say(`     npx -y ${PKG_REF} pull --ticket <ticket> --challenge ${challenge}`);
    say('');
    say('The verifier stays on this machine. Never fetch the ticket URL yourself.');
}

async function cmdPull(args) {
    sweepPending();

    /* The verifier is claimed before anything else happens, and deleted however this
       run ends — written, refused, or thrown. A verifier still on disk after a run
       that read it is a nonce that stopped being single-use.

       Without --challenge none of this happens: a browser-minted ticket carries no
       challenge, and keeping that path one step is deliberate. */
    let verifier;
    if (args.challenge) {
        const pending = pendingFileFor(args.challenge);
        process.on('exit', () => forgetPending(pending));
        try {
            verifier = fs.readFileSync(pending, 'utf8').trim();
        } catch {
            die('no pending pull for that challenge; run `begin` again.');
        }
    }

    const ticket = args.ticket || process.env.DELPAT_TICKET;
    if (!ticket) {
        die('no ticket.', 'Pass --ticket <ticket>, or set DELPAT_TICKET. Ask Claude Code for one, or use Delpat OS.');
    }
    const base = args.url || process.env.DELPAT_OS_URL || DEFAULT_BASE;

    const repoRoot = repoRootFrom(process.cwd());
    const manifest = readManifest(repoRoot);

    /* --out wins, then the manifest, then .env. The default is a guess, but a safe
       one: the gitignore check below is what actually protects you, and it refuses
       whatever the target turned out to be if git would track it. */
    const target = args.out || manifest?.target || '.env';
    const abs = resolveTarget(repoRoot, target);
    assertGitignored(repoRoot, abs);

    const body = await redeem(base, ticket, verifier);
    const keys = Object.keys(body.values).sort();
    if (!keys.length) die('that vault has no keys in it yet.');

    /* A name, never a value. Which environment the file came from is the one thing a
       reader cannot work out from the key names, and getting it wrong is how a
       production database ends up behind a development server. */
    const environment = typeof body.environment === 'string' && body.environment ? body.environment : null;

    const header = `# Written by delpat-env from Delpat OS on ${new Date().toISOString()}.`
        + (environment ? `\n# Environment: ${environment}.` : '')
        + '\n# Do not commit. Re-run `npx delpat-env pull --ticket <ticket>` to refresh.';
    writeAtomic(abs, renderEnv(body.values, header));

    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    say(`Wrote ${keys.length} keys${environment ? ` (${environment})` : ''} to ${rel} (mode 0600).`);
    for (const k of keys) say(`  ${k}`);

    if (Array.isArray(body.undecryptable) && body.undecryptable.length) {
        say('');
        say('Stored but could not be decrypted, and so NOT written:');
        for (const k of body.undecryptable) say(`  ${k}`);
    }

    if (!manifest) {
        say('');
        say(`No ${MANIFEST} here, so nothing was checked against an expected key list.`);
        say(`Add one if you want that: { "project": "<slug>", "target": "${path.relative(repoRoot, abs).split(path.sep).join('/')}", "keys": [...] }`);
        return;
    }

    const expected = new Set(manifest.keys);
    const got = new Set(keys);
    const missing = [...expected].filter((k) => !got.has(k)).sort();
    const extra = [...got].filter((k) => !expected.has(k)).sort();
    if (missing.length || extra.length) say('');
    if (missing.length) {
        say(`Expected by ${MANIFEST} but not in the vault:`);
        for (const k of missing) say(`  ${k}`);
    }
    if (extra.length) {
        say(`In the vault but not listed in ${MANIFEST}:`);
        for (const k of extra) say(`  ${k}`);
    }
    if (missing.length) process.exitCode = 2;
}

function cmdCheck() {
    const repoRoot = repoRootFrom(process.cwd());
    const manifest = readManifest(repoRoot);
    /* `check` compares what is on disk against what the repo says it expects, so
       unlike `pull` it has nothing to do without a manifest. Said plainly here rather
       than left to fail on a null a line later. */
    if (!manifest) {
        die(`no ${MANIFEST} at the repo root (${repoRoot}), and check has nothing to compare against.`,
            `Create one: { "project": "<slug>", "target": ".env", "keys": ["..."] }`);
    }
    const abs = resolveTarget(repoRoot, manifest.target);
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');

    const present = keyNamesIn(abs);
    if (present === null) {
        say(`${rel} does not exist. Expected ${manifest.keys.length} keys:`);
        for (const k of [...manifest.keys].sort()) say(`  ${k}`);
        process.exitCode = 2;
        return;
    }
    const got = new Set(present);
    const missing = manifest.keys.filter((k) => !got.has(k)).sort();
    const extra = present.filter((k) => !manifest.keys.includes(k)).sort();

    say(`${rel}: ${got.size} keys set, ${manifest.keys.length} expected.`);
    if (missing.length) {
        say('Missing:');
        for (const k of missing) say(`  ${k}`);
    }
    if (extra.length) {
        say('Set but not in the manifest:');
        for (const k of extra) say(`  ${k}`);
    }
    if (!missing.length && !extra.length) say('Everything the manifest expects is set.');
    if (missing.length) process.exitCode = 2;
}

const HELP = `delpat-env — write a working env file from Delpat OS.

For an agent, two commands. begin mints a verifier on this machine and prints only its
hash; the ticket you then ask Delpat OS for is bound to that hash, so the ticket is
worthless to anyone who does not hold the verifier:

  delpat-env begin                                   print a challenge and the next command
  delpat-env pull --ticket <t> --challenge <c>       redeem it and write the target file

For a person holding a ticket minted in Delpat OS in a browser, one command — you chose
where that ticket went, so there is nothing to bind:

  delpat-env pull --ticket <t>

And, with no server and no ticket:

  delpat-env check                    compare the target file's key names against ${MANIFEST}

Options
  --ticket <t>      the ticket, from Delpat OS or the request_env_ticket MCP tool.
                    Also DELPAT_TICKET.
  --challenge <c>   the challenge begin printed. The verifier it stands for is read from
                    ~/.delpat-env/pending/<challenge> and deleted on any outcome.
  --out <path>      where to write, if there is no ${MANIFEST}. Default .env.
  --url <u>         the Delpat OS base URL. Also DELPAT_OS_URL. Default ${DEFAULT_BASE}.

${MANIFEST}, committed at the repo root, no secrets in it:

  { "project": "delpat-os", "target": ".env.local",
    "keys": ["MONGODB_URI", "JWT_SECRET"] }

This tool never prints a secret value, and has no option that would make it. If you
need to see one, reveal it in Delpat OS, where doing so is recorded.`;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    if (args.help || !cmd) { say(HELP); return; }
    if (cmd === 'begin') return cmdBegin();
    if (cmd === 'pull') return cmdPull(args);
    if (cmd === 'check') return cmdCheck();
    die(`unknown command "${cmd}".`, 'Run delpat-env --help.');
}

main().catch((err) => die(err?.message || String(err)));
