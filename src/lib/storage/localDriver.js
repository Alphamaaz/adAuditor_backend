import fs from "node:fs";
import path from "node:path";

const STORAGE_ROOT = process.env.STORAGE_ROOT || "storage";

const resolveKey = (key) => {
  // Defense in depth: ensure the resolved path stays under STORAGE_ROOT.
  const root = path.resolve(process.cwd(), STORAGE_ROOT);
  const target = path.resolve(root, key);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error(`Storage key escapes storage root: ${key}`);
  }
  return { root, target };
};

export const localDriver = {
  name: "local",

  async write({ key, contentBuffer }) {
    const { target } = resolveKey(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, contentBuffer);
    return { key, url: null };
  },

  async exists({ key }) {
    try {
      const { target } = resolveKey(key);
      await fs.promises.access(target, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },

  async read({ key }) {
    const { target } = resolveKey(key);
    const stat = await fs.promises.stat(target);
    return {
      stream: fs.createReadStream(target),
      size: stat.size,
      contentType: null,
    };
  },

  async delete({ key }) {
    const { target } = resolveKey(key);
    try {
      await fs.promises.unlink(target);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  },

  async signedUrl() {
    // No signed URL for local driver — callers stream via the API.
    return null;
  },

  // Convenience for code that needs the absolute path (current pdfReport
  // download endpoint streams directly via fs).
  absolutePath(key) {
    return resolveKey(key).target;
  },
};
