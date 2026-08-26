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

/**
 * Resolve a virtual read path ("/repo/...", or a bare relative path resolved
 * under the project root) to a real, existing, jailed file path. Throws on
 * traversal, hard-blocked names (.env/.git/node_modules), a missing file, or
 * a symlink that resolves outside the root.
 */
export async function resolveReadPath(rawPath: string, roots: PathJailRoots): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  if (hasTraversalSegment(rawPath)) {
    throw new Error(`path must not contain '..' segments: ${rawPath}`);
  }

  let sub: string;
  if (rawPath === "/repo" || rawPath.startsWith("/repo/")) {
    sub = rawPath.slice("/repo".length);
  } else if (rawPath.startsWith("/")) {
    throw new Error(`Absolute paths must start with /repo/, got: ${rawPath}`);
  } else {
    sub = `/${rawPath}`;
  }

  const root = roots.repoRoot;
  const candidate = path.join(root, sub);
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
 * Resolve a virtual write/edit path ("/repo/..." or a bare relative path) to
 * an absolute path jailed under the project root. The file need not exist
 * yet - symlink escape is checked against the nearest existing ancestor
 * directory instead of the (possibly not-yet-created) target itself. Throws
 * on traversal, non-root absolute paths, or hard-blocked names.
 */
export async function resolveWritePath(rawPath: string, roots: PathJailRoots): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  if (hasTraversalSegment(rawPath)) {
    throw new Error(`path must not contain '..' segments: ${rawPath}`);
  }

  let sub: string;
  if (rawPath === "/repo" || rawPath.startsWith("/repo/")) {
    sub = rawPath.slice("/repo".length);
  } else if (rawPath.startsWith("/")) {
    throw new Error(`Cannot write outside the project root. Path must be relative or start with /repo/, got: ${rawPath}`);
  } else {
    sub = `/${rawPath}`;
  }

  const root = roots.repoRoot;
  const candidate = path.join(root, sub);
  rejectIfHardBlocked(candidate);
  await assertWithinRoot(candidate, root);

  return candidate;
}
