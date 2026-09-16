import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { AppDatabase } from "../db/client.ts";
import * as schema from "../db/schema.ts";

export const stripOAuthTokens = <T extends Record<string, unknown>>(account: T): T => ({
  ...account,
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
});

export function createAuth(config: Config, db: AppDatabase) {
  return betterAuth({
    appName: "Manteiner",
    baseURL: config.PUBLIC_URL,
    basePath: "/api/auth",
    secret: config.SESSION_SECRET,
    trustedOrigins: [config.WEB_URL],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    user: {
      modelName: "users",
      additionalFields: {
        githubId: {
          type: "number",
          required: true,
        },
        githubLogin: {
          type: "string",
          required: true,
        },
        lastLoginAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    account: {
      modelName: "accounts",
      accountLinking: {
        disableImplicitLinking: true,
      },
    },
    verification: {
      modelName: "verifications",
    },
    socialProviders: {
      github: {
        clientId: config.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
        mapProfileToUser: (profile) => ({
          githubId: Number(profile.id),
          githubLogin: profile.login,
        }),
      },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({ data: stripOAuthTokens(account) }),
        },
        update: {
          before: async (account) => ({ data: stripOAuthTokens(account) }),
        },
      },
      session: {
        create: {
          after: async (session) => {
            await db
              .update(schema.users)
              .set({ lastLoginAt: new Date() })
              .where(eq(schema.users.id, session.userId));
          },
        },
      },
    },
    advanced: {
      useSecureCookies: config.isProduction,
    },
  });
}

export type AppAuth = ReturnType<typeof createAuth>;
