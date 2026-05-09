import { createHash, randomInt } from "crypto";

export const OTP_TTL_MINUTES = 15;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

export const generateOtp = () => String(randomInt(100000, 999999));

export const hashOtp = (otp) =>
  createHash("sha256").update(String(otp)).digest("hex");
