import nodemailer from "nodemailer";

const FROM_ADDRESS =
  process.env.SMTP_FROM || "Ad Adviser <noreply@adauditorpro.com>";

const createTransport = () => {
  if (!process.env.SMTP_HOST) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const send = async ({ to, subject, text, html }) => {
  const transport = createTransport();

  if (!transport) {
    // Development fallback — log OTP to console when SMTP is not configured
    console.log(`\n[EMAIL] To: ${to}\n[EMAIL] Subject: ${subject}\n[EMAIL] Body: ${text}\n`);
    return;
  }

  await transport.sendMail({ from: FROM_ADDRESS, to, subject, text, html });
};

/**
 * Send a composed audit-alert email. `to` may be a single address or a
 * comma-separated list. Falls back to console logging when SMTP is unconfigured.
 */
export const sendAuditAlertEmail = ({ to, subject, html, text }) =>
  send({ to, subject, html, text });

export const sendVerificationEmail = (email, otp) =>
  send({
    to: email,
    subject: "Verify your Ad Adviser account",
    text: `Your verification code is: ${otp}\n\nThis code expires in 15 minutes. Do not share it with anyone.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px">
        <h2>Verify your email</h2>
        <p>Use the code below to verify your Ad Adviser account.</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:24px 0">${otp}</div>
        <p style="color:#666">This code expires in <strong>15 minutes</strong>. Do not share it with anyone.</p>
      </div>
    `,
  });

export const sendPasswordResetEmail = (email, otp) =>
  send({
    to: email,
    subject: "Reset your Ad Adviser password",
    text: `Your password reset code is: ${otp}\n\nThis code expires in 15 minutes. If you did not request this, ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px">
        <h2>Reset your password</h2>
        <p>Use the code below to reset your Ad Adviser password.</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:24px 0">${otp}</div>
        <p style="color:#666">This code expires in <strong>15 minutes</strong>.</p>
        <p style="color:#666">If you did not request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  });
