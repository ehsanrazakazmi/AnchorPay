import type { PiiCipher, Queryable } from '@anchorpay/service-kit';
import { assertDestination, type Destination } from './corridors.ts';
import { assertWalletNumber, last4, maskAccount, maskWallet, normaliseAccountNumber } from './validation.ts';

export interface RecipientRow {
  id: string;
  user_id: string;
  nickname: string | null;
  full_name_enc: Buffer;
  phone_enc: Buffer | null;
  encryption_key_id: string;
  country: string;
  currency: string;
  relationship: string | null;
  payout_method: 'bank_account' | 'mobile_wallet';
  bank_name: string | null;
  bank_code: string | null;
  account_number_enc: Buffer | null;
  account_last4: string | null;
  wallet_provider: 'jazzcash' | 'easypaisa' | null;
  wallet_number_enc: Buffer | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface RecipientInput {
  nickname?: string;
  fullName: string;
  phone?: string;
  country: string;
  currency: string;
  relationship?: string;
  payoutMethod: 'bank_account' | 'mobile_wallet';
  bankAccount?: { bankName: string; bankCode?: string; accountNumber: string };
  mobileWallet?: { provider: 'jazzcash' | 'easypaisa'; walletNumber: string };
}

export const RECIPIENT_CTX = {
  fullName: 'core.recipients.full_name',
  phone: 'core.recipients.phone',
  accountNumber: 'core.recipients.account_number',
  walletNumber: 'core.recipients.wallet_number',
} as const;

export class Recipients {
  private readonly cipher: PiiCipher;

  constructor(cipher: PiiCipher) {
    this.cipher = cipher;
  }

  async insert(q: Queryable, userId: string, r: RecipientInput, destinations: Destination[]): Promise<RecipientRow> {
    assertDestination(destinations, r.country, r.currency, r.payoutMethod);
    const c = this.cipher;
    let accountNumber: string | null = null;
    let lastFour: string;
    if (r.payoutMethod === 'bank_account') {
      accountNumber = normaliseAccountNumber(r.bankAccount!.accountNumber, r.country);
      lastFour = last4(accountNumber);
    } else {
      assertWalletNumber(r.mobileWallet!.walletNumber);
      lastFour = last4(r.mobileWallet!.walletNumber);
    }
    const { rows } = await q.query<RecipientRow>(
      `INSERT INTO core.recipients (user_id, nickname, full_name_enc, phone_enc, encryption_key_id, country, currency, relationship,
                                    payout_method, bank_name, bank_code, account_number_enc, account_last4, wallet_provider, wallet_number_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        userId, r.nickname?.trim() || null, c.encrypt(r.fullName.trim(), RECIPIENT_CTX.fullName),
        r.phone ? c.encrypt(r.phone, RECIPIENT_CTX.phone) : null, c.keyId, r.country, r.currency, r.relationship ?? null,
        r.payoutMethod, r.bankAccount?.bankName.trim() ?? null, r.bankAccount?.bankCode?.trim() || null,
        accountNumber ? c.encrypt(accountNumber, RECIPIENT_CTX.accountNumber) : null, lastFour,
        r.mobileWallet?.provider ?? null,
        r.mobileWallet ? c.encrypt(r.mobileWallet.walletNumber, RECIPIENT_CTX.walletNumber) : null,
      ],
    );
    return rows[0]!;
  }

  /** The user's own, non-deleted recipient (null otherwise — never reveals other users' recipients). */
  async ownedBy(q: Queryable, userId: string, id: string): Promise<RecipientRow | null> {
    const { rows } = await q.query<RecipientRow>(
      'SELECT * FROM core.recipients WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [id, userId],
    );
    return rows[0] ?? null;
  }

  async list(q: Queryable, userId: string): Promise<RecipientRow[]> {
    const { rows } = await q.query<RecipientRow>(
      'SELECT * FROM core.recipients WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [userId],
    );
    return rows;
  }

  async byId(q: Queryable, id: string): Promise<RecipientRow | null> {
    const { rows } = await q.query<RecipientRow>('SELECT * FROM core.recipients WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  private decrypt(row: RecipientRow, blob: Buffer | null, ctx: string): string | undefined {
    return blob ? this.cipher.decrypt(blob, row.encryption_key_id, ctx) : undefined;
  }

  fullName(row: RecipientRow): string {
    return this.decrypt(row, row.full_name_enc, RECIPIENT_CTX.fullName)!;
  }

  destinationMasked(row: RecipientRow): string {
    return row.payout_method === 'bank_account'
      ? `${row.bank_name} ${maskAccount(row.account_last4 ?? '')}`
      : `${row.wallet_provider === 'jazzcash' ? 'JazzCash' : 'Easypaisa'} ${maskWallet(row.account_last4 ?? '')}`;
  }

  /** Every encrypted column re-encrypted with the current key (optionally with a new phone). */
  reencrypted(row: RecipientRow, phone: string | undefined) {
    const c = this.cipher;
    const account = this.decrypt(row, row.account_number_enc, RECIPIENT_CTX.accountNumber);
    const wallet = this.decrypt(row, row.wallet_number_enc, RECIPIENT_CTX.walletNumber);
    const newPhone = phone ?? this.decrypt(row, row.phone_enc, RECIPIENT_CTX.phone);
    return {
      full_name_enc: c.encrypt(this.fullName(row), RECIPIENT_CTX.fullName),
      phone_enc: newPhone ? c.encrypt(newPhone, RECIPIENT_CTX.phone) : null,
      account_number_enc: account ? c.encrypt(account, RECIPIENT_CTX.accountNumber) : null,
      wallet_number_enc: wallet ? c.encrypt(wallet, RECIPIENT_CTX.walletNumber) : null,
      encryption_key_id: c.keyId,
    };
  }

  /** Public Recipient schema: payout numbers are always masked. */
  toApi(row: RecipientRow) {
    const phone = this.decrypt(row, row.phone_enc, RECIPIENT_CTX.phone);
    return {
      id: row.id,
      ...(row.nickname ? { nickname: row.nickname } : {}),
      fullName: this.fullName(row),
      ...(phone ? { phone } : {}),
      country: row.country,
      currency: row.currency,
      ...(row.relationship ? { relationship: row.relationship } : {}),
      payoutMethod: row.payout_method,
      ...(row.payout_method === 'bank_account'
        ? {
            bankAccount: {
              bankName: row.bank_name!,
              ...(row.bank_code ? { bankCode: row.bank_code } : {}),
              accountNumberMasked: maskAccount(row.account_last4 ?? ''),
            },
          }
        : { mobileWallet: { provider: row.wallet_provider!, walletNumberMasked: maskWallet(row.account_last4 ?? '') } }),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /** Internal schema. Full account/wallet numbers only when `withNumbers` (payment-service). */
  toInternal(row: RecipientRow, withNumbers: boolean) {
    const api = this.toApi(row);
    const accountNumber = withNumbers ? this.decrypt(row, row.account_number_enc, RECIPIENT_CTX.accountNumber) : undefined;
    const walletNumber = withNumbers ? this.decrypt(row, row.wallet_number_enc, RECIPIENT_CTX.walletNumber) : undefined;
    return {
      ...api,
      userId: row.user_id,
      deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
      ...('bankAccount' in api ? { bankAccount: { ...api.bankAccount, ...(accountNumber ? { accountNumber } : {}) } } : {}),
      ...('mobileWallet' in api ? { mobileWallet: { ...api.mobileWallet, ...(walletNumber ? { walletNumber } : {}) } } : {}),
    };
  }
}
