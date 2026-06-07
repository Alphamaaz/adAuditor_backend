/**
 * S3 driver stub. Replace with @aws-sdk/client-s3 implementation in v1.1.
 * Falls back to local driver semantics so the app doesn't crash if the env
 * var is set prematurely.
 */
import { localDriver } from "./localDriver.js";

export const s3DriverStub = {
  ...localDriver,
  name: "s3-stub",
};
