/**
 * Storage abstraction.
 *
 * Drivers (selected via STORAGE_DRIVER env var):
 *   - "local"   (default) — writes to local disk under STORAGE_ROOT.
 *                            Requires a persistent volume in production.
 *   - "s3"     — S3-compatible (AWS S3, Cloudflare R2). Stub for v1.1 —
 *                returns 501 today. Wire when @aws-sdk/client-s3 is added.
 *
 * All drivers expose the same interface:
 *   write({ key, contentBuffer, contentType }) → { key, url }
 *   read({ key }) → { stream, size, contentType }
 *   exists({ key }) → boolean
 *   delete({ key }) → void
 *   signedUrl({ key, expiresIn }) → string | null
 *
 * Boot health-check: assertStorageIsHealthy() must be called from server.js;
 * it logs a loud warning if the driver looks ephemeral in production.
 */

import { localDriver } from "./localDriver.js";
import { s3DriverStub } from "./s3DriverStub.js";

const driverName = (process.env.STORAGE_DRIVER || "local").toLowerCase();

const drivers = {
  local: localDriver,
  s3: s3DriverStub,
};

export const storage = drivers[driverName] || drivers.local;

export const getStorageDriverName = () => driverName;

/**
 * Boot-time check. Logs a warning if the storage configuration looks risky.
 * In production with the local driver, files vanish on container restart
 * unless STORAGE_ROOT is mounted from a persistent volume — we cannot
 * detect that programmatically but we can shout about it.
 */
export const assertStorageIsHealthy = () => {
  const isProd = process.env.NODE_ENV === "production";
  if (driverName === "local" && isProd) {
    if (process.env.STORAGE_PERSISTENT !== "true") {
      // eslint-disable-next-line no-console
      console.warn(
        "\n[storage] WARNING: STORAGE_DRIVER=local in production but " +
          "STORAGE_PERSISTENT is not set to 'true'.\n" +
          "Generated PDFs and uploaded CSVs will be LOST on every container " +
          "restart or redeploy.\n" +
          "Either (a) mount STORAGE_ROOT from a persistent volume and set " +
          "STORAGE_PERSISTENT=true, or (b) configure STORAGE_DRIVER=s3 " +
          "with @aws-sdk/client-s3 once the v1.1 driver ships.\n"
      );
    }
  }
  if (driverName === "s3") {
    // eslint-disable-next-line no-console
    console.warn(
      "[storage] STORAGE_DRIVER=s3 selected but the S3 driver is a stub in v1.0. " +
        "Falling back to local. Install @aws-sdk/client-s3 and implement s3Driver.js."
    );
  }
};
