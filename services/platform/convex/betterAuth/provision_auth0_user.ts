/**
 * Auto-provisioning for users who sign in via Auth0 (genericOAuth).
 *
 * Called from databaseHooks.session.create.after in auth.ts.
 *
 * Rules:
 *   - First Auth0 user (no organization exists yet): create "Default Organization"
 *     and add as admin.
 *   - Subsequent Auth0 users (organization already exists): add as developer.
 *   - Non-Auth0 users (email/password etc.) are skipped entirely — they create
 *     their own organizations through the normal onboarding flow.
 *   - Returning users who already have membership are skipped (idempotent).
 */

import type { GenericCtx } from '@convex-dev/better-auth';

import type {
  BetterAuthCreateResult,
  BetterAuthFindManyResult,
  BetterAuthMember,
  BetterAuthOrganization,
} from '../members/types';

import { components } from '../_generated/api';
import { DataModel } from '../_generated/dataModel';

interface BetterAuthAccount {
  _id: string;
  userId: string;
  providerId: string;
}

export async function provisionAuth0User(
  ctx: GenericCtx<DataModel>,
  userId: string,
): Promise<void> {
  // Skip if already a member of any organization.
  const existingMembership: BetterAuthFindManyResult<BetterAuthMember> =
    await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'member',
      paginationOpts: { cursor: null, numItems: 1 },
      where: [{ field: 'userId', value: userId, operator: 'eq' }],
    });

  if (existingMembership?.page.length > 0) {
    return;
  }

  // Only auto-provision users who authenticated via Auth0.
  const auth0Account: BetterAuthFindManyResult<BetterAuthAccount> =
    await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'account',
      paginationOpts: { cursor: null, numItems: 1 },
      where: [
        { field: 'userId', value: userId, operator: 'eq' },
        { field: 'providerId', value: 'auth0', operator: 'eq' },
      ],
    });

  if (!auth0Account || auth0Account.page.length === 0) {
    return;
  }

  const existingOrg: BetterAuthFindManyResult<BetterAuthOrganization> =
    await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'organization',
      paginationOpts: { cursor: null, numItems: 1 },
      where: [],
    });

  const now = Date.now();

  if (existingOrg?.page.length > 0) {
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'member',
        data: {
          organizationId: existingOrg.page[0]._id,
          userId,
          role: 'developer',
          createdAt: now,
        },
      },
    });
  } else {
    const orgResult: BetterAuthCreateResult = await ctx.runMutation(
      components.betterAuth.adapter.create,
      {
        input: {
          model: 'organization',
          data: {
            name: 'Default Organization',
            slug: `default-org-${now}`,
            createdAt: now,
          },
        },
      },
    );

    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'member',
        data: {
          organizationId: orgResult._id,
          userId,
          role: 'admin',
          createdAt: now,
        },
      },
    });
  }
}
