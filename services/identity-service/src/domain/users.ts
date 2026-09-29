import { normalizeEmail, normalizePhone, type PiiCipher, type Queryable } from '@anchorpay/service-kit';

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
}

export interface UserRow {
  id: string;
  email_enc: Buffer;
  phone_enc: Buffer;
  full_name_enc: Buffer;
  date_of_birth_enc: Buffer | null;
  address_enc: Buffer | null;
  encryption_key_id: string;
  country: string;
  password_hash: string;
  role: 'customer' | 'agent' | 'compliance_officer' | 'admin';
  status: 'active' | 'locked' | 'suspended' | 'closed';
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  closed_at: Date | null;
}

export interface NewUser {
  email: string;
  phone: string;
  fullName: string;
  dateOfBirth: string;
  address?: Address | undefined;
  country: string;
  passwordHash: string;
  role?: UserRow['role'];
}

/** Additional-authenticated-data contexts: a ciphertext only decrypts in the column it was written to. */
export const USER_CTX = {
  email: 'core.users.email',
  phone: 'core.users.phone',
  fullName: 'core.users.full_name',
  dateOfBirth: 'core.users.date_of_birth',
  address: 'core.users.address',
} as const;

export class Users {
  private readonly cipher: PiiCipher;

  constructor(cipher: PiiCipher) {
    this.cipher = cipher;
  }

  emailHash(email: string): Buffer {
    return this.cipher.blindIndex(normalizeEmail(email), 'email');
  }

  phoneHash(phone: string): Buffer {
    return this.cipher.blindIndex(normalizePhone(phone), 'phone');
  }

  async insert(q: Queryable, u: NewUser): Promise<UserRow> {
    const c = this.cipher;
    const { rows } = await q.query<UserRow>(
      `INSERT INTO core.users (email_hash, email_enc, phone_hash, phone_enc, full_name_enc, date_of_birth_enc, address_enc,
                               encryption_key_id, country, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        this.emailHash(u.email), c.encrypt(normalizeEmail(u.email), USER_CTX.email),
        this.phoneHash(u.phone), c.encrypt(normalizePhone(u.phone), USER_CTX.phone),
        c.encrypt(u.fullName.trim(), USER_CTX.fullName),
        c.encrypt(u.dateOfBirth, USER_CTX.dateOfBirth),
        u.address ? c.encryptJson(u.address, USER_CTX.address) : null,
        c.keyId, u.country, u.passwordHash, u.role ?? 'customer',
      ],
    );
    return rows[0]!;
  }

  async byId(q: Queryable, id: string, forUpdate = false): Promise<UserRow | null> {
    const { rows } = await q.query<UserRow>(`SELECT * FROM core.users WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ?? null;
  }

  async byEmail(q: Queryable, email: string): Promise<UserRow | null> {
    const { rows } = await q.query<UserRow>('SELECT * FROM core.users WHERE email_hash = $1', [this.emailHash(email)]);
    return rows[0] ?? null;
  }

  email(row: UserRow): string {
    return this.cipher.decrypt(row.email_enc, row.encryption_key_id, USER_CTX.email);
  }

  phone(row: UserRow): string {
    return this.cipher.decrypt(row.phone_enc, row.encryption_key_id, USER_CTX.phone);
  }

  /** The public User schema (contracts: #/components/schemas/User). */
  toApi(row: UserRow) {
    const c = this.cipher;
    const k = row.encryption_key_id;
    return {
      id: row.id,
      email: this.email(row),
      phone: this.phone(row),
      fullName: c.decrypt(row.full_name_enc, k, USER_CTX.fullName),
      ...(row.date_of_birth_enc ? { dateOfBirth: c.decrypt(row.date_of_birth_enc, k, USER_CTX.dateOfBirth) } : {}),
      ...(row.address_enc ? { address: c.decryptJson<Address>(row.address_enc, k, USER_CTX.address) } : {}),
      country: row.country,
      role: row.role,
      status: row.status,
      emailVerified: row.email_verified_at !== null,
      phoneVerified: row.phone_verified_at !== null,
      createdAt: row.created_at.toISOString(),
    };
  }
}

/** Ids + statuses only: what may go into audit rows and events. */
export const auditView = (row: Pick<UserRow, 'id' | 'role' | 'status'>) => ({ id: row.id, role: row.role, status: row.status });
