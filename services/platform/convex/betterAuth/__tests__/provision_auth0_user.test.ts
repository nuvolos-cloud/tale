import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../_generated/api', () => ({
  components: {
    betterAuth: {
      adapter: {
        findMany: 'betterAuth:adapter:findMany',
        create: 'betterAuth:adapter:create',
      },
    },
  },
}));

function createMockCtx() {
  return {
    runQuery: vi.fn(),
    runMutation: vi.fn(),
  };
}

const USER_ID = 'user_abc123';

describe('provisionAuth0User', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips a user who already has organization membership', async () => {
    const ctx = createMockCtx();

    ctx.runQuery.mockResolvedValueOnce({
      page: [{ _id: 'member_1', organizationId: 'org_1', userId: USER_ID, role: 'developer', createdAt: 1 }],
    });

    const { provisionAuth0User } = await import('../provision_auth0_user');
    await provisionAuth0User(ctx as never, USER_ID);

    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it('skips a user without an Auth0 account', async () => {
    const ctx = createMockCtx();

    ctx.runQuery
      .mockResolvedValueOnce({ page: [] }) // no membership
      .mockResolvedValueOnce({ page: [] }); // no auth0 account

    const { provisionAuth0User } = await import('../provision_auth0_user');
    await provisionAuth0User(ctx as never, USER_ID);

    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it('creates a Default Organization and assigns admin role to the first Auth0 user', async () => {
    const ctx = createMockCtx();

    ctx.runQuery
      .mockResolvedValueOnce({ page: [] }) // no membership
      .mockResolvedValueOnce({ page: [{ _id: 'account_1', userId: USER_ID, providerId: 'auth0' }] }) // auth0 account
      .mockResolvedValueOnce({ page: [] }); // no organizations

    ctx.runMutation
      .mockResolvedValueOnce({ _id: 'org_new' }) // create organization
      .mockResolvedValueOnce({ _id: 'member_new' }); // create member

    const { provisionAuth0User } = await import('../provision_auth0_user');
    await provisionAuth0User(ctx as never, USER_ID);

    expect(ctx.runMutation).toHaveBeenCalledTimes(2);

    const [orgCall, memberCall] = ctx.runMutation.mock.calls;

    expect(orgCall[1].input.model).toBe('organization');
    expect(orgCall[1].input.data.name).toBe('Default Organization');

    expect(memberCall[1].input.model).toBe('member');
    expect(memberCall[1].input.data.userId).toBe(USER_ID);
    expect(memberCall[1].input.data.role).toBe('admin');
    expect(memberCall[1].input.data.organizationId).toBe('org_new');
  });

  it('adds subsequent Auth0 users to the existing organization as developer', async () => {
    const ctx = createMockCtx();

    ctx.runQuery
      .mockResolvedValueOnce({ page: [] }) // no membership
      .mockResolvedValueOnce({ page: [{ _id: 'account_2', userId: USER_ID, providerId: 'auth0' }] }) // auth0 account
      .mockResolvedValueOnce({ page: [{ _id: 'org_existing', name: 'Acme', slug: 'acme', createdAt: 1 }] }); // org exists

    ctx.runMutation.mockResolvedValueOnce({ _id: 'member_new' });

    const { provisionAuth0User } = await import('../provision_auth0_user');
    await provisionAuth0User(ctx as never, USER_ID);

    expect(ctx.runMutation).toHaveBeenCalledTimes(1);

    const [memberCall] = ctx.runMutation.mock.calls;
    expect(memberCall[1].input.model).toBe('member');
    expect(memberCall[1].input.data.userId).toBe(USER_ID);
    expect(memberCall[1].input.data.role).toBe('developer');
    expect(memberCall[1].input.data.organizationId).toBe('org_existing');
  });
});
