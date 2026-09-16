import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripOAuthTokens } from "./auth.ts";

describe("Better Auth account persistence", () => {
  it("elimina todos los tokens OAuth antes de persistir la cuenta", () => {
    const account = stripOAuthTokens({
      id: "account-1",
      providerId: "github",
      accountId: "123",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "id-secret",
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
    });

    assert.equal(account.id, "account-1");
    assert.equal(account.providerId, "github");
    assert.equal(account.accessToken, null);
    assert.equal(account.refreshToken, null);
    assert.equal(account.idToken, null);
    assert.equal(account.accessTokenExpiresAt, null);
    assert.equal(account.refreshTokenExpiresAt, null);
  });
});
