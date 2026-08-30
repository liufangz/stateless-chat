import { promises as fs } from "node:fs";
import path from "node:path";

// Hard-blocked regardless of anything else - secrets and repo internals must
// never be readable/writable via these tools even if a traversal or symlink
// check is somehow bypassed. Applied as a second, independent layer of
// defense, not the primary jail mechanism.
const HARD_REJECT_PATTERNS = [/(^|\/)\.env($|\/)/, /(^|\/)\.git($|\/)/, /(^|\/)node_modules($|\/)/];

export interface PathJailRoots {
  repoRoot: string;
}

function hasTraversalSegment(rawPath: string): boolean {
  return rawPath.split("/").some((segment) => segment === "..");
}

function rejectIfHardBlocked(resolvedPath: string): void {
  for (const pattern of HARD_REJECT_PATTERNS) {
    if (pattern.test(resolvedPath)) {
      throw new Error(`Access to '${resolvedPath}' is not allowed.`);
    }
  }
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await fs.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function assertWithinRoot(candidate: string, root: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const ancestor = await nearestExistingAncestor(candidate);
  const realAncestor = await fs.realpath(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw new Error(`Path escapes the allowed root: ${candidate}`);
  }
}

const REPO_ALIAS = "/repo";

/**
 * Strip the virtual "/repo" alias used when the worker ran in a sandbox where
 * the project was mounted at /repo. Returns the sub-path under the root, or
 * null if the path doesn't use the alias. The alias is kept for
 * backward-compatibility; on the host the real project path is accepted too.
 */
function stripRepoAlias(rawPath: string): string | null {
  if (rawPath === REPO_ALIAS) return "";
  if (rawPath.startsWith(REPO_ALIAS + "/")) return rawPath.slice(REPO_ALIAS.length);
  return null;
}

/**
 * Map a tool-supplied path to a candidate under the repo root:
 *   - "/repo/..." (sandbox-era alias)  -> repoRoot + sub
 *   - a real absolute path             -> itself (containment checked later)
 *   - a bare relative path             -> repoRoot + "/" + path
 */
function resolveCandidate(rawPath: string, root: string): string {
  const alias = stripRepoAlias(rawPath);
  if (alias !== null) return path.join(root, alias);
  if (rawPath.startsWith("/")) return rawPath;
  return path.join(root, `/${rawPath}`);
}

/**
 * Resolve a tool-supplied read path ("/repo/...", a real absolute path under
 * the project root, or a bare relative path resolved under the project root)
 * to a real, existing, jailed file path. Throws on traversal, hard-blocked
 * names (.env/.git/node_modules), a missing file, an absolute path outside
 * the root, or a symlink that resolves outside the root.
 */
export async function resolveReadPath(rawPath: string, roots: PathJailRoots): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  if (hasTraversalSegment(rawPath)) {
    throw new Error(`path must not contain '..' segments: ${rawPath}`);
  }

  const root = roots.repoRoot;
  const candidate = resolveCandidate(rawPath, root);
  rejectIfHardBlocked(candidate);

  let realPath: string;
  try {
    realPath = await fs.realpath(candidate);
  } catch {
    throw new Error(`File not found: ${rawPath}`);
  }

  const realRoot = await fs.realpath(root);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new Error(`Path escapes the allowed root: ${rawPath}`);
  }
  rejectIfHardBlocked(realPath);

  return realPath;
}

/**
 * Resolve a tool-supplied write/edit path ("/repo/...", a real absolute path
 * under the project root, or a bare relative path) to an absolute path jailed
 * under the project root. The file need not exist yet - symlink escape is
 * checked against the nearest existing ancestor directory instead of the
 * (possibly not-yet-created) target itself. Throws on traversal, absolute
 * paths outside the root, or hard-blocked names.
 */
export async function resolveWritePath(rawPath: string, roots: PathJailRoots): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  if (hasTraversalSegment(rawPath)) {
    throw new Error(`path must not contain '..' segments: ${rawPath}`);
  }

  const root = roots.repoRoot;
  const candidate = resolveCandidate(rawPath, root);
  rejectIfHardBlocked(candidate);
  await assertWithinRoot(candidate, root);

  return candidate;
}
