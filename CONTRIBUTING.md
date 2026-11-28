# Contributing to BugXHunter

Thanks for wanting to help. This file says how to get the code running, what a pull request
needs, and which parts of the code get a closer look.

Found a security problem in BugXHunter itself? Do not open an issue or a pull request for it:
report it privately, as [SECURITY.md](SECURITY.md) describes.

## Set up

You need Node 22 or newer. Docker is only needed if you change the images.

```bash
git clone https://github.com/<you>/bugxhunter-runner.git
cd bugxhunter-runner
npm install          # also installs OpenCode
npm run dev          # backend on :8790, web on :5190, both with hot reload
```

Open http://localhost:5190. The app starts without a model key; anything that calls a model
needs one (see the README's install section). Never commit a key: `.env` is ignored by
git, and so is the vault.

## Before you open a pull request

Run what CI runs:

```bash
npm run check        # typecheck, lint (warnings fail) and the unit tests
npm run build        # the web app and the server, as the Docker image ships them
```

Then:

1. **Branch from `master`**, on your fork, and keep the pull request to one change. A small
   pull request is reviewed sooner than a large one.
2. **Add a test** for a behaviour you add or a bug you fix. The logic lives in pure modules
   (`server/src/*.ts`, `web/src/*.ts`) with a `*.test.ts` beside each; nothing needs a browser
   or a model to test.
3. **Update the docs** you made untrue: `README.md`, and `docs/recon-security.md` for anything
   in supervised recon.
4. **Fill in the pull request template.** Say what you checked and, just as plainly, what you
   did not. "Not run against a real target" is a useful sentence.

A maintainer's approval starts CI on a first-time contributor's pull request. Pull requests are
squash-merged, so the title becomes the commit: write it as `type(area): what changed`, for
example `fix(recon): count a retry as one round`.

## Things that are easy to get wrong

- **The recon agents are defined twice.** `reconAgents()` in `server/src/recon.ts` and
  `docker/opencode.json` must say the same thing, and a test fails if they do not. Change the
  code, then change the JSON to match.
- **The server and the browser share types** in `shared/`. A change there has to compile on
  both sides.
- **Line endings.** The repository stores LF (`.gitattributes`); PowerShell scripts are CRLF.

## Changes that get a closer look

These decide what runs without a person and what stays secret, so a pull request that touches
them needs tests for the new behaviour and for what must still be refused:

- the approval gate and the scope check (`server/src/recon.ts`, `reconGateDecision` in
  `recon-driver.ts`);
- the vault, sign-in and anything sealed with the vault key (`vault.ts`, `auth.ts`,
  `playground-store.ts`, `recon-memory.ts`, `recon-session.ts`);
- any route reachable without a sign-in, and anything that writes into a project folder;
- the Docker images, the egress filter, and the release and signing scripts.

The reasoning behind recon's rules is in [docs/recon-security.md](docs/recon-security.md). If a
change weakens one of them, say so in the pull request and say why it is worth it.

## What we will not take

- Features for testing systems without their owner's authorisation, for evading detection, or
  for causing damage. BugXHunter is for authorised testing.
- Code copied from a project whose licence does not allow it here. BugXHunter is MIT: code
  under the GPL or AGPL cannot be brought in, however good it is. Ideas are fine; say where
  one came from.
- A new runtime dependency without a reason. Each one is something every install has to trust.

## AI-assisted contributions

Welcome, and much of this codebase was written that way. You are responsible for what you
submit: read it, run it, and describe in the pull request what was actually checked.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE),
like the rest of the project.

## Releases

Maintainers cut releases: they are signed with an offline key that only maintainers hold. A
merged change ships in the next one.
