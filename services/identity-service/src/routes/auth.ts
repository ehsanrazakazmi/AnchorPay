import {
  AppError, buildEvent, enqueueEvent, envInt, isUniqueViolation, requireAuth, withTransaction, type Service,
} from '@anchorpay/service-kit';
import { hashPassword, passwordProblems, verifyPassword } from '../domain/passwords.ts';
import type { Address, UserRow } from '../domain/users.ts';
import { dateOfBirthProblems } from '../domain/validation.ts';
import { audit, bestEffort, SERVICE, type Deps } from '../deps.ts';

interface RegisterBody {
  email: string;
  phone: string;
  password: string;
  fullName: string;
  dateOfBirth: string;
  address?: Address;
  country: string;
}

const MAX_FAILED = () => envInt('LOGIN_MAX_FAILED_ATTEMPTS', 5);
const LOCKOUT_SECONDS = () => envInt('LOGIN_LOCKOUT_SECONDS', 900);

/** Role to put in new tokens, or null if the user may not hold tokens any more. */
export const activeRole = (deps: Deps) => async (userId: string) => {
  const user = await deps.users.byId(deps.pool, userId);
  return user && user.status === 'active' ? user.role : null;
};

export function registerAuthRoutes(svc: Service, deps: Deps): void {
  const { pool, users, tokens, verification, log } = deps;

  svc.handle('registerUser', async (req, reply) => {
    const body = req.body as RegisterBody;
    const problems = [...passwordProblems(body.password, body.email), ...dateOfBirthProblems(body.dateOfBirth)];
    if (problems.length) throw new AppError('VALIDATION_ERROR', 'One or more fields are invalid.', { errors: problems });
    const passwordHash = await hashPassword(body.password);

    const row = await withTransaction(pool, async (client) => {
      let created: UserRow;
      try {
        created = await users.insert(client, { ...body, passwordHash });
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_hash_key')) throw new AppError('ALREADY_EXISTS', 'An account with this email already exists.');
        if (isUniqueViolation(err, 'users_phone_hash_key')) throw new AppError('ALREADY_EXISTS', 'An account with this phone number already exists.');
        throw err;
      }
      await audit(client, req, 'user.registered', { type: 'user', id: created.id }, { after: { role: created.role, status: created.status } }, created.id);
      const event = buildEvent(
        'user.registered',
        { userId: created.id, country: created.country, role: created.role, registeredAt: created.created_at.toISOString() },
        { producer: SERVICE, correlationId: req.id },
      );
      await enqueueEvent(client, 'core', event, created.id);
      return created;
    });

    await bestEffort(log, 'verification email', () => verification.sendEmailVerification(row.id, users.email(row)));
    await bestEffort(log, 'verification SMS', () => verification.sendPhoneCode(row.id, users.phone(row)));
    return reply.code(201).send(users.toApi(row));
  });

  svc.handle('login', async (req) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await users.byEmail(pool, email);
    if (!user) {
      await verifyPassword(password, null); // same work as a real check, so timing doesn't reveal unknown emails
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (user.locked_until && user.locked_until > new Date()) {
      const seconds = Math.ceil((user.locked_until.getTime() - Date.now()) / 1000);
      throw new AppError('ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minutes.`, {
        headers: { 'retry-after': String(seconds) },
      });
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      const locked = await withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ locked: boolean }>(
          `UPDATE core.users
              SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                  locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(secs => $3) ELSE locked_until END
            WHERE id = $1
        RETURNING locked_until > now() AS locked`,
          [user.id, MAX_FAILED(), LOCKOUT_SECONDS()],
        );
        const isLocked = rows[0]?.locked === true;
        await audit(client, req, isLocked ? 'user.locked_out' : 'user.login_failed', { type: 'user', id: user.id }, {}, user.id);
        return isLocked;
      });
      if (locked) {
        throw new AppError('ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${Math.ceil(LOCKOUT_SECONDS() / 60)} minutes.`, {
          headers: { 'retry-after': String(LOCKOUT_SECONDS()) },
        });
      }
      throw new AppError('INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') throw new AppError('FORBIDDEN', 'This account is not active. Please contact support.');

    const { tokens: pair, sessionId } = await tokens.startSession(user.id, user.role);
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE core.users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
      await audit(client, req, 'user.login', { type: 'user', id: user.id }, { after: { sessionId } }, user.id);
    });
    return pair;
  });

  svc.handle('refreshToken', async (req) => {
    const { refreshToken } = req.body as { refreshToken: string };
    return tokens.rotate(refreshToken, activeRole(deps));
  });

  svc.handle('logout', async (req, reply) => {
    const auth = requireAuth(req);
    const { refreshToken } = req.body as { refreshToken: string };
    const stored = await tokens.peek(refreshToken);
    // Only ever end the caller's own session, whatever token is sent.
    const sessionId = stored && stored.userId === auth.userId ? stored.sessionId : auth.sessionId;
    if (sessionId) await tokens.revokeSession(sessionId, auth.userId);
    await audit(pool, req, 'user.logout', { type: 'user', id: auth.userId });
    return reply.code(204).send();
  });

  svc.handle('verifyEmail', async (req, reply) => {
    const { token } = req.body as { token: string };
    const userId = await verification.consumeEmailToken(token);
    if (!userId) throw new AppError('NOT_FOUND', 'This verification link is invalid or has expired. Ask for a new one.');
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE core.users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId]);
      await audit(client, req, 'user.email_verified', { type: 'user', id: userId }, {}, userId);
    });
    return reply.code(204).send();
  });

  svc.handle('verifyPhone', async (req, reply) => {
    const auth = requireAuth(req);
    const { code } = req.body as { code: string };
    const result = await verification.checkPhoneCode(auth.userId, code);
    if (result === 'expired') throw new AppError('NOT_FOUND', 'This code has expired. Ask for a new one.');
    if (result === 'locked') throw new AppError('RATE_LIMITED', 'Too many wrong codes. Ask for a new one.');
    if (result === 'wrong') {
      throw new AppError('VALIDATION_ERROR', 'The code is incorrect.', { errors: [{ field: 'code', message: 'is incorrect' }] });
    }
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE core.users SET phone_verified_at = now() WHERE id = $1', [auth.userId]);
      await audit(client, req, 'user.phone_verified', { type: 'user', id: auth.userId });
    });
    return reply.code(204).send();
  });

  svc.handle('resendVerification', async (req, reply) => {
    const auth = requireAuth(req);
    const { channel } = req.body as { channel: 'email' | 'phone' };
    const user = await users.byId(pool, auth.userId);
    if (!user) throw new AppError('UNAUTHENTICATED');
    const alreadyVerified = channel === 'email' ? user.email_verified_at : user.phone_verified_at;
    if (alreadyVerified) return reply.code(204).send();
    await verification.enforceSendLimit(user.id, `verify-${channel}`);
    if (channel === 'email') await verification.sendEmailVerification(user.id, users.email(user));
    else await verification.sendPhoneCode(user.id, users.phone(user));
    return reply.code(204).send();
  });

  svc.handle('forgotPassword', async (req, reply) => {
    const { email } = req.body as { email: string };
    const user = await users.byEmail(pool, email);
    if (user && user.status === 'active') {
      try {
        await verification.enforceSendLimit(user.id, 'password-reset');
        await verification.sendPasswordReset(user.id, users.email(user));
        await audit(pool, req, 'user.password_reset_requested', { type: 'user', id: user.id }, {}, user.id);
      } catch (err) {
        // Same response either way so the endpoint can't be used to discover accounts.
        if (!(err instanceof AppError && err.code === 'RATE_LIMITED')) throw err;
      }
    }
    return reply.code(204).send();
  });

  svc.handle('resetPassword', async (req, reply) => {
    const { token, newPassword } = req.body as { token: string; newPassword: string };
    const invalidLink = () => new AppError('NOT_FOUND', 'This reset link is invalid or has expired. Ask for a new one.');
    const userId = await verification.peekResetToken(token);
    const user = userId ? await users.byId(pool, userId) : null;
    if (!user) throw invalidLink();
    const problems = passwordProblems(newPassword, users.email(user), 'newPassword');
    if (problems.length) throw new AppError('VALIDATION_ERROR', 'Choose a stronger password.', { errors: problems });
    if ((await verification.consumeResetToken(token)) !== user.id) throw invalidLink(); // used concurrently
    const hash = await hashPassword(newPassword);
    await withTransaction(pool, async (client) => {
      await client.query('UPDATE core.users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id, hash]);
      await audit(client, req, 'user.password_reset', { type: 'user', id: user.id }, {}, user.id);
    });
    await tokens.revokeAllSessions(user.id);
    await bestEffort(log, 'password changed email', () => verification.notifyPasswordChanged(users.email(user)));
    return reply.code(204).send();
  });
}
