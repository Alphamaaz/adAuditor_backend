import { createHash, randomBytes } from "crypto";

export const createSessionToken = () => randomBytes(32).toString("hex");

export const hashSessionToken = (token) =>
  createHash("sha256").update(token).digest("hex");
