# @delpat/env

The command-line half of **Dead Drop**, the credential system in Delpat OS. One command
writes a working env file. No secret value is ever printed, and every pull is on record.

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
  "@delpat/env": "github:Delpat-Tech/env-cli#v1.0.0"
}
```

## The manifest

`.delpat-env.json`, committed at the repo root. It contains no secrets:

```json
{
  "project": "delpat-os",
  "target": ".env.local",
  "keys": ["MONGODB_URI", "JWT_SECRET", "ADMIN_PASSWORD", "RESEND_API_KEY"]
}
```

It is a convenience, not a control. It is a committed file this script reads, so a
hijacked session edits it first; what it is good for is naming the target file and
making `check` possible. What actually contains the blast radius is the grant's 30-day
idle expiry, server side.

## Use

```
npx delpat-env pull --ticket tkt_...
npx delpat-env check
```

`pull` redeems the ticket and writes the target. `check` compares the key names already
in the target against the manifest — no server, no ticket, no values.

A ticket lasts 60 seconds, works once, and covers one project. Ask Claude Code (the
`request_access` MCP tool) or Delpat OS for one.

Configuration, all optional:

| | |
|---|---|
| `--ticket`, `DELPAT_TICKET` | the ticket |
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
- **Prints key names only**, plus how many were written and anything the manifest
  expected that the vault did not have.

## Exit codes

| | |
|---|---|
| 0 | wrote the file, and the manifest's keys were all present |
| 1 | refused, or the server refused |
| 2 | wrote the file, but keys the manifest expects are missing (or `check` found gaps) |

## If you need to see a value

Reveal it in Delpat OS. That writes an audit row with your name on it, which is the
point.
