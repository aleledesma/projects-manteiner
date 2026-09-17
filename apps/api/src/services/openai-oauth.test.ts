import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OAuthProviderCredential } from "./credential-crypto.ts";
import { OpenAIOAuthService } from "./openai-oauth.ts";

describe("OpenAIOAuthService", () => {
  it("completa device flow, extrae accountId y no expone tokens en el estado", async () => {
    const accountId = "account-123";
    const jwt = `x.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    })).toString("base64url")}.x`;
    const requests: string[] = [];
    let saved: OAuthProviderCredential | undefined;
    const responses = [
      Response.json({ device_auth_id: "device-secret", user_code: "ABCD-EFGH", interval: 1 }),
      Response.json({ authorization_code: "authorization-secret", code_verifier: "verifier-secret" }),
      Response.json({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 600,
        id_token: jwt,
      }),
    ];
    const service = new OpenAIOAuthService({
      httpTimeoutMs: 1_000,
      flowTimeoutMs: 60_000,
      fetch: async (input) => {
        requests.push(String(input));
        return responses.shift()!;
      },
      sleep: async () => {},
      onAuthorized: async (_userId, credential) => {
        saved = credential;
      },
    });

    const started = await service.start("user-1");
    assert.deepEqual(
      { url: started.url, userCode: started.userCode, expiresIn: started.expiresIn },
      { url: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", expiresIn: 60 },
    );
    await waitUntil(() => saved !== undefined);

    assert.equal(saved?.type, "oauth");
    assert.equal(saved?.access, "access-secret");
    assert.equal(saved?.refresh, "refresh-secret");
    assert.equal(saved?.accountId, accountId);
    assert.equal(typeof saved?.expires, "number");
    const status = service.status("user-1", started.pollToken);
    assert.equal(status.status, "authorized");
    assert.doesNotMatch(JSON.stringify(status), /access-secret|refresh-secret|device-secret/);
    assert.deepEqual(requests, [
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
    service.close();
  });

  it("mantiene pending ante 403 y marca failed ante una respuesta terminal", async () => {
    const responses = [
      Response.json({ device_auth_id: "device", user_code: "CODE", interval: 1 }),
      Response.json({}, { status: 403 }),
      Response.json({}, { status: 500 }),
    ];
    const service = new OpenAIOAuthService({
      httpTimeoutMs: 1_000,
      flowTimeoutMs: 60_000,
      fetch: async () => responses.shift()!,
      sleep: async () => {},
      onAuthorized: async () => assert.fail("no debe autorizar"),
    });

    const started = await service.start("user-1");
    await waitUntil(() => service.status("user-1", started.pollToken).status === "failed");
    assert.equal(service.status("user-1", started.pollToken).errorCode, "PROVIDER_AUTH_FAILED");
    service.close();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("la condicion asincrona no se completo");
}
