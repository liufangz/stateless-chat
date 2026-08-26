# FEATURE — read_file / write_file / edit_file Tools for the Worker Tool Loop

**Status: implemented.** `packages/worker/src/tools/read-file.ts`,
`write-file.ts`, `edit-file.ts`, `file-path-jail.ts`, `atomic-write.ts`.

This doc **supersedes `docs/FEATURE-file-tools-analysis.md` wherever the two
disagree.** The analysis doc proposed routing `write_file`/`edit_file`
through a `docker run` sandbox (mirroring `bash.ts`) to work around a uid
mismatch between the worker process and the container that also writes
`/work`. The implementation instead does **all three tools in-process**, and
fixes the same uid-mismatch problem with a temp-file-then-rename write
instead of a subprocess. See "Deviations from the analysis doc" below for
why.

## What

Three tools let the model interact with the project repo (`/repo`, host path
`REPO_ROOT`) directly, without shelling out through `bash` for every file
operation:

- `read_file` — read a text file, with `offset`/`limit` pagination.
- `write_file` — create or overwrite a file under the project root.
- `edit_file` — replace one exact, unique string match in a file under the
  project root.

There is a single root — the project repo — pi-style. The scratch workspace
(`/work`, host path `WORKSPACE_DIR`) is bash-only territory: it's still
mounted read-write into the `bash` tool's docker sandbox, but these three
tools no longer address it at all. `/work/...` paths are rejected the same
as any other path outside the root.

All three run directly in the worker process (no `docker run`), gated behind
their own env flag, following the `TOOL_BASH_ENABLED` precedent.

## Schemas

```jsonc
// read_file
{
  "name": "read_file",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description":
        "File path. Relative paths resolve under the project root. Absolute paths must start with /repo/." },
      "offset": { "type": "number", "description": "1-indexed line to start reading from" },
      "limit": { "type": "number", "description": "Max number of lines to read" }
    },
    "required": ["path"]
  }
}

// write_file
{
  "name": "write_file",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description":
        "File path under the project root. Relative paths resolve under the project root; absolute paths must start with /repo/. Writes to .env, .git, or node_modules are rejected." },
      "content": { "type": "string", "description": "Full file content (overwrites if the file exists)" }
    },
    "required": ["path", "content"]
  }
}

// edit_file
{
  "name": "edit_file",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "File path under the project root (same rules as write_file)" },
      "old_string": { "type": "string", "description": "Exact text to replace. Must match exactly once in the file." },
      "new_string": { "type": "string", "description": "Replacement text" }
    },
    "required": ["path", "old_string", "new_string"]
  }
}
```

No `edits[]` array, no BOM/line-ending/Unicode-fuzzy-match handling (unlike
pi-source's `edit.ts`) — `/work` files are worker-drafted scratch content, so
a single exact old/new pair per call is enough.

## Jail + hard-rejects

Read and write/edit paths share `file-path-jail.ts`, both jailed to a single
root — `REPO_ROOT`, `PathJailRoots { repoRoot }`:

- **Virtual-path convention**: `/repo/...` or a bare relative path →
  `REPO_ROOT`. Any other absolute path — including `/work/...` — is rejected
  before any I/O. There is no second root; the scratch workspace is bash-only
  now (see "What" above).
- **`..` traversal** is rejected as a literal path segment, before
  resolution.
- **Hard-reject patterns**: `.env`, `.git/`, `node_modules` — checked both on
  the raw candidate path and again on the `realpath`-resolved path, so a
  symlink can't launder past the string check. This is the control that
  actually matters: the worker process owns `REPO_ROOT` (including `.env`)
  outright, so filesystem permissions don't protect secrets from an
  in-process read the way they'd protect them from the docker-sandboxed
  `bash` tool.
- **Symlink escape**: `resolveReadPath` and `resolveWritePath` both
  `realpath` the nearest existing ancestor and verify it falls under
  `REPO_ROOT`; a symlink planted in the repo pointing outside the jail is
  rejected with "escapes the allowed root" rather than silently followed.
- **`write_file`/`edit_file` can now write anywhere under the project root**
  (still subject to the hard-reject patterns above) — there is no more
  `/work`-only restriction, since `/work` is no longer addressable by these
  tools at all.

## Atomic writes

`write_file`/`edit_file` now operate on `REPO_ROOT` directly instead of the
docker-shared `WORKSPACE_DIR`, so the original uid-mismatch scenario this
mechanism was built for (the `bash` container, uid 1000, creating files in
`/work` that the worker's own uid can only group-read) no longer applies to
these tools — `REPO_ROOT` is mounted **read-only** into that container
(`bash.ts`'s `-v ${REPO_ROOT}:/repo:ro`), so the container never writes there
at all. The temp-file-then-rename approach is kept anyway as general
robustness: it avoids partial writes on failure and still degrades gracefully
if a target file ever ends up non-writable by the worker for some other
reason (e.g. mode bits left over from a prior process).

Mechanism (`packages/worker/src/tools/atomic-write.ts`, used by both `write_file`
and `edit_file`): write content to a temp file in the **same directory**
(`.<basename>.<pid>.<random>.tmp`) and `fs.rename` it over the target.
`rename` only requires write permission on the *directory*, not the target
file itself, which the worker has. The temp name is unique per call
(`process.pid` + a random suffix) so concurrent workers touching the same
directory don't collide; if the rename itself fails, the temp file is
unlinked before the error propagates.

## Untrusted-content delimiter

`read_file`'s result wraps file content in an explicit delimiter before it
re-enters the conversation as a `role: "tool"` message:

```
<file path="/repo/notes.txt" lines="1-50">
...content...
</file>
```

This mitigates prompt injection: a file under the project root could contain
text engineered to look like tool-call instructions (e.g. planted by an
earlier, less-trusted turn). The delimiter is a hint to the model, not a security
boundary — the path jail above is the actual control. Continuation-hint
suffixes (`[Showing lines X-Y of Z. Use offset=N to continue.]`) are tool
metadata, not file content, and are kept **outside** the `<file>` block.

`edit_file`'s success confirmation includes a small `-`/`+` diff of the
replaced text (`Successfully replaced 1 occurrence in <path>:\n- <old>\n+
<new>`) so the model can verify the change without a follow-up `read_file`
call.

## Limits

| Concern | Value |
|---|---|
| `read_file` output | 200 lines or 4000 chars, whichever hits first, with `offset`/`limit` pagination and a continuation hint |
| `write_file` content size | `MAX_WRITE_BYTES = 256 * 1024` (256 KB), rejected before any I/O |
| `edit_file` match requirement | `old_string` must match exactly once — zero matches is a "not found" error, more than one is an "ambiguous, add more context" error |

## Tests

`packages/worker/test/read-file-tool.test.ts`,
`write-file-tool.test.ts`, `edit-file-tool.test.ts` (real temp-directory
fixtures, no docker fake needed since these tools don't spawn a subprocess):

- Relative/`/repo/` path resolution under the single project-root fixture.
- `/work/...` rejected for both read and write/edit — it's outside the root
  now, not a second valid zone.
- `.env`, `.git/`, `node_modules` rejected even under `/repo` (the
  highest-priority regression test in this feature — it stays a positive
  "reject a secret path under the tools' own writable root" case now that
  `/repo` is writable).
- Writing/editing under an explicit `/repo/...` path succeeds (positive test
  — this is new capability now that there's only one root).
- `..` traversal rejected.
- Symlink escape rejected via `realpath`.
- `read_file`: offset/limit pagination, truncation + continuation hint,
  not-found, directory-instead-of-file, offset-beyond-EOF, and the
  `<file path="..." lines="...">...</file>` delimiter wrapping with the
  continuation hint kept outside it.
- `write_file`/`edit_file`: oversized content rejected before writing, path
  outside the root rejected before writing, symlinked directory escape
  rejected, and — the atomic-write regression — a successful write/edit to a
  target file that is `chmod`'d non-writable, proving the rename-based write
  doesn't require write permission on the file itself.
- `edit_file`: zero matches → "not found"; multiple matches → "ambiguous";
  confirmation message includes the old/new diff lines.

`npm test -w packages/worker` — 66 tests passing.

## Rollout

Three independent env flags, following `TOOL_BASH_ENABLED`'s exact
precedent (`packages/shared/src/env.ts`):

```
TOOL_READ_FILE_ENABLED=true
TOOL_WRITE_FILE_ENABLED=true
TOOL_EDIT_FILE_ENABLED=true
```

Read at process start (same as every other `env.ts` value) — each flag
needs a worker restart to take effect. `write_file`/`edit_file` are wired in
`packages/worker/src/tools/index.ts`'s `DEFAULT_TOOLS` the same way as
`BASH_TOOL`. Nothing enforces it, but `write_file`/`edit_file` shouldn't be
enabled without `read_file` in practice — the model needs to read back
content it wrote to verify it before telling the user a change is done.

## Deviations from the analysis doc

`docs/FEATURE-file-tools-analysis.md` recommended routing `write_file` and
`edit_file` through a `docker run` sandbox (a fixed, worker-authored Node
harness fed a JSON payload over stdin, mirroring `bash.ts`), reasoning that
the worker process couldn't write `WORKSPACE_DIR` at all and that the
container's mount namespace would provide symlink/traversal containment "for
free." The implementation instead runs all three tools in-process:

- **Atomic rename instead of a subprocess.** The uid mismatch turned out to
  be fixable with a `rename`-over-target instead of an in-place write (see
  above), which needs no new privilege-crossing mechanism and no ~1s
  `docker run` tax per call.
- **Explicit jail instead of mount-namespace containment.** Since
  `write_file`/`edit_file` no longer get symlink/traversal protection for
  free from a container boundary, `file-path-jail.ts`'s `resolveWritePath`
  does the same `realpath`-and-verify check `resolveReadPath` already needs
  for `read_file` — one jail implementation shared by all three tools
  instead of two different containment strategies.
- Everything else in the analysis doc (schemas, hard-reject list, edit
  uniqueness requirement, limits, no `apply_diff` tool) carried through
  unchanged into the implementation.

**Later change:** the two-zone `/work` + `/repo` model above was replaced
with a single root, `REPO_ROOT`, pi-style — see "Jail + hard-rejects". The
scratch workspace (`/work`) is now exclusively addressed through the `bash`
tool; `read_file`/`write_file`/`edit_file` no longer know it exists.
