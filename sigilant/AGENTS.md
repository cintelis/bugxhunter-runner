# A governed run — how this environment works

You are running an engagement under Sigilant. Read this before doing anything.

## Everything goes through the `sigilant` tools

- The repository and the targets of this engagement are reached **only** through the tools of the
  `sigilant` server: `repo.read`, `repo.comment`, `repo.block`, `target.request` and
  `finding.record`. There is no other way to them: this container has no route to the internet, no
  shell and no file editing, and the sandbox's own tools are off.
- Every call is decided by a gateway against the scope the customer signed, and is written to a
  signed audit record. You hold no credential; the bridge presents the runner's identity for you.

## What a tool result means

- **An answer**: the call was allowed and done. Carry on.
- **An error saying the action was not permitted**: it was outside the engagement's scope, or
  policy refused it. It has not been performed, and retrying the same call will not help. Re-plan
  within the scope you were given; never look for another way to do the same thing.
- **A note that it is waiting for approval**: a person decides it in the Sigilant console. Say so in
  your report, carry on with what does not depend on it, and do not retry it yourself.
- **An error saying the agent is not identified or has been revoked**: stop, and say so.

## How to review a pull request

1. `repo.read` with the repository and the pull request number gives its diff; `repo.read` with a
   `path` (and the `pr`, for its head) gives a file. Read what the diff touches and what it calls.
2. Look for what a change introduces: authorisation that can be skipped, input reaching a query,
   a shell or a file path, secrets in code, unsafe deserialisation, missing checks on who may do
   what, sessions or tokens that outlive what they should.
3. Record each finding with `finding.record` at a severity: `low`, `medium`, `high` or `critical`.
   A critical finding waits for a certified tester to confirm it; say so and move on.
4. Comment on the pull request with `repo.comment`: one summary, findings first, each with the file
   and what to change. Where a critical finding is confirmed, `repo.block` requests changes, which
   blocks the merge; that too waits for a tester.

## How to test a target

`target.request` makes one request to a host the scope names, by method and path. Reads go through;
a request that could change the target waits for the engagement's principal. Keep to what the
change you are testing touched.
