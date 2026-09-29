import { AppError, type FieldError } from '@anchorpay/service-kit';

/** Destination countries recipients can be created for, with currency and payout methods (fx.corridors seed). */
export const DESTINATIONS: Record<string, { currency: string; payoutMethods: string[] }> = {
  PK: { currency: 'PKR', payoutMethods: ['bank_account', 'mobile_wallet'] },
  IN: { currency: 'INR', payoutMethods: ['bank_account'] },
};

export function assertDestination(country: string, currency: string, payoutMethod: string): void {
  const d = DESTINATIONS[country];
  if (!d) throw new AppError('CORRIDOR_UNAVAILABLE', `Sending to ${country} is not available.`);
  if (d.currency !== currency) throw new AppError('CORRIDOR_UNAVAILABLE', `Recipients in ${country} are paid in ${d.currency}, not ${currency}.`);
  if (!d.payoutMethods.includes(payoutMethod)) {
    throw new AppError('CORRIDOR_UNAVAILABLE', `${payoutMethod.replace('_', ' ')} payouts are not available for ${country}.`);
  }
}

/** Age in whole years on `today` (UTC). */
export function ageOn(dateOfBirth: string, today = new Date()): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age -= 1;
  return age;
}

export function dateOfBirthProblems(dateOfBirth: string): FieldError[] {
  const age = ageOn(dateOfBirth);
  if (Number.isNaN(age) || age > 120) return [{ field: 'dateOfBirth', message: 'is not a valid date of birth' }];
  if (age < 18) return [{ field: 'dateOfBirth', message: 'you must be at least 18 years old' }];
  return [];
}

/** ISO 13616 mod-97 check. */
export function isValidIban(iban: string): boolean {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Normalises an account number / IBAN and validates it. Pakistani IBANs are 24 characters. */
export function normaliseAccountNumber(raw: string, country: string): string {
  const value = raw.replace(/[\s-]/g, '').toUpperCase();
  const invalid = (message: string) =>
    new AppError('VALIDATION_ERROR', 'The account number is not valid.', { errors: [{ field: 'bankAccount.accountNumber', message }] });
  if (/^[A-Z]{2}\d{2}/.test(value)) {
    if (country === 'PK' && (!value.startsWith('PK') || value.length !== 24)) throw invalid('a Pakistani IBAN has 24 characters and starts with PK');
    if (!isValidIban(value)) throw invalid('IBAN check digits are wrong — please re-check the number');
    return value;
  }
  if (!/^[0-9]{6,20}$/.test(value)) throw invalid('must be 6-20 digits, or a valid IBAN');
  return value;
}

/** JazzCash / Easypaisa accounts are Pakistani mobile numbers (+92 3xx xxxxxxx). */
export function assertWalletNumber(walletNumber: string): void {
  if (!/^\+923[0-9]{9}$/.test(walletNumber)) {
    throw new AppError('VALIDATION_ERROR', 'The wallet number is not valid.', {
      errors: [{ field: 'mobileWallet.walletNumber', message: 'must be a Pakistani mobile number like +923001234567' }],
    });
  }
}

export const last4 = (value: string) => value.replace(/\D/g, '').slice(-4) || value.slice(-4);
export const maskAccount = (lastFour: string) => `•••• ${lastFour}`;
export const maskWallet = (lastFour: string) => `+92 3•• ••• ${lastFour}`;
