import { AppError, isUniqueViolation, normalizePhone, requireAuth, withTransaction, type Service } from '@anchorpay/service-kit';
import { hashPassword, passwordProblems, verifyPassword } from '../domain/passwords.ts';
import { USER_CTX, type Address, type UserRow } from '../domain/users.ts';
import { audit, bestEffort, type Deps } from '../deps.ts';

export function registerProfileRoutes(svc: Service, deps: Deps): void {
  const { pool, users, cipher, tokens, verification, log } = deps;

  svc.handle('getMe', async (req) => {
    const user = await users.byId(pool, requireAuth(req).userId);
    if (!user) throw new AppError('UNAUTHENTICATED');
    return users.toApi(user);
  });

  svc.handle('updateMe', async (req) => {
    const auth = requireAuth(req);
    const body = req.body as { phone?: string; address?: Address };
    const { row, phoneChanged } = await withTransaction(pool, async (client) => {
      const user = await users.byId(client, auth.userId, true);
      if (!user) throw new AppError('UNAUTHENTICATED');
      const current = users.toApi(user);
      const phone = body.phone ? normalizePhone(body.phone) : current.phone;
      const address = body.address ?? current.address;
      const changed = [...(phone !== current.phone ? ['phone'] : []), ...(body.address ? ['address'] : [])];
      if (changed.length === 0) return { row: user, phoneChanged: false };
      // Re-encrypt every PII column with the current key, so a row never mixes key versions.
      let updated: UserRow;
      try {
        const result = await client.query<UserRow>(
          `UPDATE core.users
              SET email_enc = $2, phone_hash = $3, phone_enc = $4, full_name_enc = $5, date_of_birth_enc = $6, address_enc = $7,
                  encryption_key_id = $8,
                  phone_verified_at = CASE WHEN $9::boolean THEN NULL ELSE phone_verified_at END
            WHERE id = $1 RETURNING *`,
          [
            user.id,
            cipher.encrypt(current.email, USER_CTX.email),
            users.phoneHash(phone),
            cipher.encrypt(phone, USER_CTX.phone),
            cipher.encrypt(current.fullName, USER_CTX.fullName),
            current.dateOfBirth ? cipher.encrypt(current.dateOfBirth, USER_CTX.dateOfBirth) : null,
            address ? cipher.encryptJson(address, USER_CTX.address) : null,
            cipher.keyId,
            changed.includes('phone'),
          ],
        );
        updated = result.rows[0]!;
      } catch (err) {
        if (isUniqueViolation(err, 'users_phone_hash_key')) throw new AppError('ALREADY_EXISTS', 'This phone number is used by another account.');
        throw err;
      }
      await audit(client, req, 'user.profile_updated', { type: 'user', id: user.id }, { after: { changed } });
      return { row: updated, phoneChanged: changed.includes('phone') };
    });
    if (phoneChanged) await bestEffort(log, 'verification SMS', () => verification.sendPhoneCode(row.id, users.phone(row)));
    return users.toApi(row);
  });

  svc.handle('changePassword', async (req, reply) => {
    const auth = requireAuth(req);
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    const user = await users.byId(pool, auth.userId);
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new AppError('VALIDATION_ERROR', 'Your current password is incorrect.', { errors: [{ field: 'currentPassword', message: 'is incorrect' }] });
    }
    const problems = passwordProblems(newPassword, users.email(user), 'newPassword');
    if (currentPassword === newPassword) problems.push({ field: 'newPassword', message: 'must be different from the current password' });
    if (problems.length) throw new AppError('VALIDATION_ERROR', 'Choose a stronger password.', { errors: problems });
    const hash = await hashPassword(newPassword);
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE core.users SET password_hash = $2 WHERE id = $1', [user.id, hash]);
      await audit(client, req, 'user.password_changed', { type: 'user', id: user.id });
    });
    await tokens.revokeAllSessions(user.id, auth.sessionId);
    await bestEffort(log, 'password changed email', () => verification.notifyPasswordChanged(users.email(user)));
    return reply.code(204).send();
  });
}
