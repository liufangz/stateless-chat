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

Three tools let the model interact with the complete trusted-user home tree
(`/home/ubuntu`) directly, without shelling out through `bash` for every file
operation:

- `read_file` — read a text file, with `offset`/`limit` pagination.
- `write_file` — create or overwrite a file under `/home/ubuntu`.
- `edit_file` — replace one exact, unique string match in a file under
  `/home/ubuntu`.

There is a single root — the whole `/home/ubuntu` tree. Bare relative paths
resolve there, real absolute paths under it are accepted, and `/repo/...` is
retained as a legacy alias for the same root. Paths outside `/home/ubuntu`
remain unavailable to these three APIs; the unrestricted `bash` tool can reach
them because it runs as the host `ubuntu` account.

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
        "File path. Relative paths resolve under /home/ubuntu. Absolute paths must stay under /home/ubuntu." },
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
        "File path under /home/ubuntu. Relative paths resolve there; absolute paths must stay under /home/ubuntu. No filename class is blocked inside the allowed root." },
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
      "path": { "type": "string", "description": "File path under /home/ubuntu (same rules as write_file)" },
      "old_string": { "type": "string", "description": "Exact text to replace. Must match exactly once in the file." },
      "new_string": { "type": "string", "description": "Replacement text" }
    },
    "required": ["path", "old_string", "new_string"]
  }
}
```

No `edits[]` array, no BOM/line-ending/Unicode-fuzzy-match handling (unlike
pi-source's `edit.ts`) — a single exact old/new pair per call is enough.

## Jail + host-access boundary

Read and write/edit paths share `file-path-jail.ts`, both jailed to a single
root — `/home/ubuntu`, represented as `PathJailRoots { root }`:

- **Virtual-path convention**: `/repo/...` or a bare relative path resolves
  under `/home/ubuntu`. An absolute path must resolve inside `/home/ubuntu`.
- **`..` traversal** is rejected as a literal path segment, before resolution.
- **No filename-class denylist**: `.env`, `.git/`, `node_modules`, dotfiles,
  credentials, and other paths inside `/home/ubuntu` are intentionally
  accessible. The worker's in-process file APIs already run with the worker's
  host privileges, and bash is explicitly unrestricted in this mode.
- **Symlink escape**: `resolveReadPath` and `resolveWritePath` realpath the
  target or nearest existing ancestor and verify it falls under
  `/home/ubuntu`; a symlink pointing outside the home root is rejected.
- **`write_file`/`edit_file` can write anywhere under `/home/ubuntu`**. The
  remaining checks are only traversal and symlink containment; they are not an
  OS-level security boundary because bash can use sudo and operate outside it.

### Bash execution mode

`bash.ts` runs commands as `ubuntu`, with `HOME=/home/ubuntu` and default cwd
`/home/ubuntu`. This replaces the former `opc` privilege drop. On the reference
host, `ubuntu` has passwordless sudo and Docker access, so a bash command can
read or mutate the whole machine. This feature must only be enabled for a
trusted single-user/operator deployment. The model is instructed to require an
explicit user request for destructive or security-sensitive changes, but this
is behavioral guidance rather than technical containment.
## Atomic writes

`write_file`/`edit_file` operate directly on `/home/ubuntu`. The former
uid-mismatch scenario that motivated the atomic-write implementation is no
longer relevant to a separate sandbox: bash now runs as the same `ubuntu`
account, while the temp-file-then-rename approach remains useful general
robustness against partial writes and non-writable target file modes.

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
<file path="/home/ubuntu/notes.txt" lines="1-50">
...content...
</file>
```

This mitigates prompt injection: a file under the home root could contain
text engineered to look like tool-call instructions (e.g. planted by an
earlier, less-trusted turn). The delimiter is a hint to the model, not a security
boundary — the path jail above is only a structural containment check. Bash is
unrestricted in this deployment. Continuation-hint
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

- Relative and `/repo/` path resolution under the single allowed-root fixture.
- `/work/...` and other absolute paths outside the root are rejected.
- `.env`, `.git/`, and `node_modules` inside the allowed root are readable and
  writable, proving there is no filename denylist.
- Writing/editing under an explicit `/repo/...` path succeeds as a legacy alias.
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

Run the worker tests with `npm test -w packages/worker`.

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
- The schemas, edit uniqueness requirement, limits, and lack of an `apply_diff`
  tool carried through unchanged. The former hard-reject filename list was
  deliberately removed when access expanded to the whole home tree.

**Later change:** the former repo-only model was replaced with a whole-home
root, `/home/ubuntu`, and unrestricted host bash — see "Jail + host-access
boundary" and "Bash execution mode". The `/repo` spelling is retained only as
a compatibility alias.
