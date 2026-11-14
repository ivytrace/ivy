import nodemailer, { type Transporter } from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

const env = (name: string) => process.env[name]?.trim() || undefined;

/**
 * Outgoing mail over SMTP: `IVY_SMTP_URL` (e.g. `smtps://user:pass@email-smtp.eu-west-1.amazonaws.com:465`,
 * or `smtp://…:587` for STARTTLS) and `IVY_EMAIL_FROM` (`Ivy <noreply@example.com>`). Both are
 * needed; without them Ivy sends nothing and the UI shows links to copy instead.
 */
export const emailEnabled = () => !!(env('IVY_SMTP_URL') && env('IVY_EMAIL_FROM'));

let transport: { url: string; transporter: Transporter } | undefined;
let sender: ((email: Email) => Promise<void>) | undefined;

export async function sendEmail(email: Email): Promise<void> {
  if (sender) return sender(email);
  const url = env('IVY_SMTP_URL');
  const from = env('IVY_EMAIL_FROM');
  if (!url || !from) throw new Error('Email is not configured (IVY_SMTP_URL, IVY_EMAIL_FROM)');
  if (transport?.url !== url) transport = { url, transporter: nodemailer.createTransport(url) };
  await transport.transporter.sendMail({ from, ...email });
}

export function setEmailSenderForTests(fn: ((email: Email) => Promise<void>) | undefined) {
  sender = fn;
}
