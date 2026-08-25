/**
 * Creating a stand-in user for someone who does not have an account.
 *
 * Both the group flow and the friends flow need one, and the shape is not
 * arbitrary: `User.email` is non-null and unique, so a placeholder has to carry
 * a synthetic address that can never collide with a real one. Duplicating that
 * detail is how the two flows end up producing subtly different rows.
 */

import { randomUUID } from 'crypto';
import type { PrismaClient } from '@/generated/prisma/client';

/** Not a routable domain, so a placeholder can never be mailed by accident. */
export const PLACEHOLDER_EMAIL_DOMAIN = 'placeholder.local';

export function placeholderEmail(): string {
  return `placeholder-${randomUUID()}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export async function createPlaceholderUser(
  db: Pick<PrismaClient, 'user'>,
  input: { name: string; createdByUserId: string },
) {
  return db.user.create({
    data: {
      email: placeholderEmail(),
      name: input.name,
      isPlaceholder: true,
      placeholderName: input.name,
      createdByUserId: input.createdByUserId,
    },
    select: { id: true, name: true },
  });
}
