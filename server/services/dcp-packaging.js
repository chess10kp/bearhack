import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function walkFiles(root, out) {
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    const st = fs.statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      walkFiles(full, out);
      continue;
    }
    if (st.isFile()) {
      out.push({
        relPath: path.relative(root, full),
        size: st.size,
      });
    }
  }
}

function digestForFiles(root, files) {
  const h = createHash("sha256");
  for (const f of files.sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    h.update(f.relPath);
    h.update("\n");
    const full = path.join(root, f.relPath);
    const fd = fs.openSync(full, "r");
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      let n;
      // eslint-disable-next-line no-cond-assign
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        h.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return h.digest("hex");
}

/**
 * Build a deterministic manifest for a checkpoint directory.
 * @param {string} checkpointDir
 */
export function buildManifest(checkpointDir) {
  const root = path.resolve(checkpointDir);
  if (!fs.existsSync(root)) {
    throw new Error(`checkpoint dir missing: ${root}`);
  }
  const files = [];
  walkFiles(root, files);
  const sizeBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  return {
    root,
    fileCount: files.length,
    sizeBytes,
    digest: digestForFiles(root, files),
    files,
  };
}
