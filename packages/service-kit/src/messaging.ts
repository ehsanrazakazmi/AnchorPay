// SMS / email delivery. The only provider for now is "log": every message is appended as one JSON
// line to MESSAGING_LOG_FILE (a local mailbox, git-ignored), so nothing costs money (DECISIONS D-21).
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { env, REPO_ROOT } from './env.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  template: string;
}

export interface SmsMessage {
  to: string;
  text: string;
  template: string;
}

export interface Messenger {
  sendEmail(message: EmailMessage): Promise<void>;
  sendSms(message: SmsMessage): Promise<void>;
}

export const SMS_MAX_LENGTH = 160;

export class LogMessenger implements Messenger {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private async write(record: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
  }

  async sendEmail(m: EmailMessage): Promise<void> {
    await this.write({ channel: 'email', ...m });
  }

  async sendSms(m: SmsMessage): Promise<void> {
    if (m.text.length > SMS_MAX_LENGTH) throw new Error(`SMS "${m.template}" is ${m.text.length} characters (max ${SMS_MAX_LENGTH})`);
    await this.write({ channel: 'sms', ...m });
  }
}

export function createMessenger(): Messenger {
  for (const name of ['SMS_PROVIDER', 'EMAIL_PROVIDER']) {
    const provider = env(name, 'log');
    if (provider !== 'log') throw new Error(`${name}=${provider} is not supported yet (only "log")`);
  }
  const file = env('MESSAGING_LOG_FILE', 'logs/mailbox.log');
  return new LogMessenger(isAbsolute(file) ? file : join(REPO_ROOT, file));
}
