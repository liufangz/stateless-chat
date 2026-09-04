import { promises as fs } from "node:fs";
import path from "node:path";

export interface PathJailRoots {
  /** The one filesystem root exposed to the file tools. */
  root: string;
}

function hasTraversalSegment(rawPath: string): boolean {
  return rawPath.split("/").some((segment) => segment === "..");
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
 * Map a tool-supplied path to a candidate under the allowed root:
 *   - "/repo/..." (legacy alias)       -> root + sub
 *   - a real absolute path             -> itself (containment checked later)
 *   - a bare relative path             -> root + "/" + path
 */
function resolveCandidate(rawPath: string, root: string): string {
  const alias = stripRepoAlias(rawPath);
  if (alias !== null) return path.join(root, alias);
  if (rawPath.startsWith("/")) return rawPath;
  return path.join(root, `/${rawPath}`);
}

/**
 * Resolve a tool-supplied read path ("/repo/...", a real absolute path under
 * the allowed root, or a bare relative path resolved under the allowed root)
 * to a real, existing, jailed file path. Throws on traversal, a missing file,
 * an absolute path outside the root, or a symlink that resolves outside the
 * root. Dotfiles, .env, .git, node_modules, and other paths inside the root
 * are intentionally allowed in full-host mode.
 */
export async function resolveReadPath(rawPath: string, roots: PathJailRoots): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  if (hasTraversalSegment(rawPath)) {
    throw new Error(`path must not contain '..' segments: ${rawPath}`);
  }

  const root = roots.root;
  const candidate = resolveCandidate(rawPath, root);

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

  return realPath;
}

/**
 * Resolve a tool-supplied write/edit path ("/repo/...", a real absolute path
 * under the allowed root, or a bare relative path) to an absolute path jailed
 * under the allowed root. The file need not exist yet - symlink escape is
 * checked against the nearest existing ancestor directory instead of the
 * (possibly not-yet-created) target itself. Throws on traversal or absolute
 * paths outside the root.
 */
export async function resolveWritePath(rawPath: string, roots: PathJailRoots): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  if (hasTraversalSegment(rawPath)) {
    throw new Error(`path must not contain '..' segments: ${rawPath}`);
  }

  const root = roots.root;
  const candidate = resolveCandidate(rawPath, root);
  await assertWithinRoot(candidate, root);

  return candidate;
}

/**
 * Derives the cross-process file-lock identity for an already-jailed target
 * path (the output of resolveWritePath, or resolveReadPath). Two different
 * strings that name the SAME underlying file must produce the SAME key, or
 * the lock provides no real mutual exclusion between them - so this always
 * fully resolves symlinks, exactly like resolveReadPath already must for an
 * existing file.
 *
 * A write/edit target need not exist yet (a brand-new file is a normal
 * write_file call), so this can't simply `realpath()` the target itself -
 * that throws ENOENT. Instead it mirrors assertWithinRoot's own strategy:
 * realpath the nearest EXISTING ancestor directory and append the remaining,
 * not-yet-existing path segments verbatim. This is deliberately the exact
 * same canonicalization rule the path jail already uses (not a second,
 * independently-written one), so the lock key for "/repo/new.txt" is stable
 * across repeated calls whether or not the file exists yet, and converges
 * with the file's own eventual realpath once it's created.
 */
export async function canonicalLockKey(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    const ancestor = await nearestExistingAncestor(targetPath);
    const realAncestor = await fs.realpath(ancestor);
    const suffix = path.relative(ancestor, targetPath);
    return suffix ? path.join(realAncestor, suffix) : realAncestor;
  }
}
