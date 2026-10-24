# @delpat/env

The command-line half of **Dead Drop**, the credential system in Delpat OS. Two short
commands write a working env file. No secret value is ever printed, and every pull is
on record.

A dead drop is how a secret changes hands without the two parties ever meeting. This
script is the collection point: a model can ask for a ticket and run the command, and
the file lands on disk without the model ever seeing what is in it.

> Secrets go **server → script → disk**. Never **server → model → disk**.
>
> That is why this is a package and not a `curl` one-liner. A model can ask for a
> ticket and run this command; it cannot see what the command wrote.

## Install

As a dependency, never vendored into a repo — one copy of the secret-handling code, one
place to fix a bug:

```json
"devDependencies": {
  "@delpat/env": "github:Delpat-Tech/delpat-env#v2.0.0"
}
```

## The manifest, which is optional

Without one, `pull` writes to `.env`, or to wherever `--out` says:

```
npx delpat-env pull --ticket tkt_... --out .env.local
```

Either way the file must be gitignored; that check is not optional, and it is what
actually protects you rather than the manifest did.

Add `.delpat-env.json` at the repo root when the repo has something to say that the
server cannot know: which file the env belongs in, and which keys it expects. It is
committed, and contains no secrets:

```json
{
  "project": "delpat-os",
  "target": ".env.local",
  "keys": ["MONGODB_URI", "JWT_SECRET", "SECRETS_MASTER_KEY", "RESEND_API_KEY"]
}
```

It is a convenience, not a control. It is a committed file this script reads, so a
hijacked session edits it first; what it is good for is naming the target file and
making `check` possible. What actually contains the blast radius is the grant's 30-day
idle expiry, server side.

## Use

### An agent: two commands

The ticket is a bearer value, and a model is a thing that writes its reasoning down. So
the ticket alone is not enough to pull: it is bound to a secret the model never sees.

`begin` makes a random **verifier** on this machine, keeps it in
`~/.delpat-env/pending/` at mode 0600, and prints only its SHA-256 — the **challenge**.
The challenge goes to Delpat OS with the ticket request. `pull` reads the verifier back
and sends it with the ticket. A ticket that leaks into a transcript, a log, an issue or
a URL is worthless to anyone who is not on this machine.

```
npx -y github:Delpat-Tech/delpat-env#v2.0.0 begin
```

It prints the challenge, the `request_env_ticket` arguments to send, and the exact
command to run next. Ask Delpat OS for the ticket with that challenge, then run the
command it printed, within the ticket's 60 seconds:

```
npx -y github:Delpat-Tech/delpat-env#v2.0.0 pull --ticket tkt_... --challenge <challenge>
```

The verifier is deleted however that pull ends — written, refused or thrown — because a
verifier that outlives its use has stopped being single-use. A verifier nobody spent is
swept after ten minutes.

### A person with a browser-minted ticket: one command

A ticket you minted yourself in Delpat OS needs no challenge. You chose where it went,
so there is nobody to prove the machine to:

```
npx delpat-env pull --ticket tkt_...
```

### Either way

```
npx delpat-env check
```

`pull` redeems the ticket and writes the target, reporting how many keys it wrote, to
where, and which environment they came from. `check` compares the key names already in
the target against the manifest — no server, no ticket, no values.

A ticket lasts 60 seconds, works once, and covers one vault. Ask Claude Code (the
`request_env_ticket` MCP tool) or Delpat OS for one.

Configuration, all optional:

| | |
|---|---|
| `--ticket`, `DELPAT_TICKET` | the ticket |
| `--challenge` | the challenge `begin` printed, for an agent pull |
| `--out` | where to write, when there is no manifest |
| `--url`, `DELPAT_OS_URL` | the Delpat OS base URL, default `https://os.delpat.in` |

## What it guarantees

- **No code path prints a value.** There is no `--show`, no debug flag, and an HTTP
  failure is reported by status code — the response body is never echoed.
- **Atomic write.** A temp file in the target's own directory, `fsync`, then a rename.
  A crash halfway leaves the previous file intact, never a half-written one.
- **Mode 0600**, set at creation rather than chmod'ed after, so the file never exists
  world-readable. (Windows ignores the mode bits; use NTFS permissions there.)
- **Refuses any target outside the repo root**, resolved rather than string-matched.
- **Refuses a target git would track.** Not gitignored, or gitignored but already
  tracked, and it stops with the line to add to `.gitignore`.
- **Prints key names only**, plus how many were written, which environment they came
  from, and anything the manifest expected that the vault did not have.
- **The verifier never leaves the machine.** `begin` prints its hash and nothing else,
  and `pull` deletes the file however the pull ended. There is no persistent secret
  here and nothing to provision.

## Exit codes

| | |
|---|---|
| 0 | wrote the file, and the manifest's keys were all present |
| 1 | refused, or the server refused |
| 2 | wrote the file, but keys the manifest expects are missing (or `check` found gaps) |

## If you need to see a value

Reveal it in Delpat OS. That writes an audit row with your name on it, which is the
point.
