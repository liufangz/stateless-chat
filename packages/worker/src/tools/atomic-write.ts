import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

/**
 * Write content to a file via a temp-file-then-rename dance instead of a
 * direct write. Files created by the uid-1000 bash executor (opc) land as
 * mode 644, and the worker (a different uid, group-read-only on those
 * files) can't overwrite them in place - fs.writeFile hits EACCES.
 * Renaming a new file over the target only needs write permission on the
 * directory, which the worker has.
 */
export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  await fs.writeFile(tmpPath, content, "utf-8");
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
