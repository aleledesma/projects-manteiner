import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  CredentialCrypto,
  CredentialCryptoError,
  type EncryptedCredential,
  type ProviderCredentialPayload,
} from "./credential-crypto.ts";

const owner = { userId: "user-1", providerId: "openai" };
const apiCredential: ProviderCredentialPayload = { type: "api", key: "sk-prueba" };
const oauthCredential: ProviderCredentialPayload = {
  type: "oauth",
  refresh: "refresh-token",
  access: "access-token",
  expires: 1_800_000_000_000,
  accountId: "account-1",
};

function expectError(code: CredentialCryptoError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof CredentialCryptoError && error.code === code;
}

function tamper(
  encrypted: EncryptedCredential,
  field: "ciphertext" | "iv" | "authTag",
): EncryptedCredential {
  const changed = Buffer.from(encrypted[field]);
  changed[0] = changed[0]! ^ 1;
  return { ...encrypted, [field]: changed };
}

describe("CredentialCrypto", () => {
  it("cifra y descifra una API key", () => {
    const crypto = new CredentialCrypto(randomBytes(32));
    const encrypted = crypto.encrypt(owner, apiCredential);

    assert.deepEqual(crypto.decrypt(owner, encrypted), apiCredential);
    assert.equal(encrypted.iv.length, 12);
    assert.equal(encrypted.authTag.length, 16);
    assert.equal(encrypted.keyVersion, 1);
  });

  it("cifra y descifra una credencial OAuth completa", () => {
    const crypto = new CredentialCrypto(randomBytes(32));
    const encrypted = crypto.encrypt(owner, oauthCredential);
    assert.deepEqual(crypto.decrypt(owner, encrypted), oauthCredential);
  });

  it("usa un IV nuevo en cada cifrado", () => {
    const crypto = new CredentialCrypto(randomBytes(32));
    const first = crypto.encrypt(owner, apiCredential);
    const second = crypto.encrypt(owner, apiCredential);

    assert.notDeepEqual(first.iv, second.iv);
    assert.notDeepEqual(first.ciphertext, second.ciphertext);
  });

  it("rechaza un ciphertext, IV o auth tag manipulado", () => {
    const crypto = new CredentialCrypto(randomBytes(32));
    const encrypted = crypto.encrypt(owner, oauthCredential);

    for (const field of ["ciphertext", "iv", "authTag"] as const) {
      assert.throws(
        () => crypto.decrypt(owner, tamper(encrypted, field)),
        expectError("CREDENTIAL_DECRYPTION_FAILED"),
        `${field} manipulado deberia fallar`,
      );
    }
  });

  it("no permite mover la credencial a otro usuario o proveedor", () => {
    const crypto = new CredentialCrypto(randomBytes(32));
    const encrypted = crypto.encrypt(owner, oauthCredential);

    assert.throws(
      () => crypto.decrypt({ ...owner, userId: "user-2" }, encrypted),
      expectError("CREDENTIAL_DECRYPTION_FAILED"),
    );
    assert.throws(
      () => crypto.decrypt({ ...owner, providerId: "anthropic" }, encrypted),
      expectError("CREDENTIAL_DECRYPTION_FAILED"),
    );
  });

  it("codifica usuario y proveedor sin colisiones de separador", () => {
    const crypto = new CredentialCrypto(randomBytes(32));
    const encrypted = crypto.encrypt({ userId: "a:b", providerId: "c" }, apiCredential);

    assert.throws(
      () => crypto.decrypt({ userId: "a", providerId: "b:c" }, encrypted),
      expectError("CREDENTIAL_DECRYPTION_FAILED"),
    );
  });

  it("rechaza otra clave maestra", () => {
    const encrypted = new CredentialCrypto(randomBytes(32)).encrypt(owner, apiCredential);
    const anotherCrypto = new CredentialCrypto(randomBytes(32));

    assert.throws(
      () => anotherCrypto.decrypt(owner, encrypted),
      expectError("CREDENTIAL_DECRYPTION_FAILED"),
    );
  });

  it("rechaza claves y versiones invalidas", () => {
    assert.throws(
      () => new CredentialCrypto(randomBytes(16)),
      expectError("INVALID_MASTER_KEY"),
    );
    assert.throws(
      () => new CredentialCrypto(randomBytes(32), 0),
      expectError("INVALID_MASTER_KEY"),
    );
  });

  it("rechaza una version de clave que no esta configurada", () => {
    const crypto = new CredentialCrypto(randomBytes(32));
    const encrypted = crypto.encrypt(owner, apiCredential);

    assert.throws(
      () => crypto.decrypt(owner, { ...encrypted, keyVersion: 2 }),
      expectError("UNSUPPORTED_KEY_VERSION"),
    );
  });

  it("rechaza contextos y payloads invalidos en runtime", () => {
    const crypto = new CredentialCrypto(randomBytes(32));
    assert.throws(
      () => crypto.encrypt({ ...owner, userId: "" }, apiCredential),
      expectError("INVALID_CREDENTIAL_CONTEXT"),
    );
    assert.throws(
      () => crypto.encrypt(owner, { type: "api", key: "" }),
      expectError("INVALID_CREDENTIAL_PAYLOAD"),
    );
    assert.throws(
      () =>
        crypto.encrypt(owner, {
          type: "api",
          key: "sk-prueba",
          access: "campo-inesperado",
        } as ProviderCredentialPayload),
      expectError("INVALID_CREDENTIAL_PAYLOAD"),
    );

    const inherited = Object.create({
      type: "api",
      key: "sk-heredada",
    }) as ProviderCredentialPayload;
    assert.throws(
      () => crypto.encrypt(owner, inherited),
      expectError("INVALID_CREDENTIAL_PAYLOAD"),
    );

    const hidden = {} as ProviderCredentialPayload;
    Object.defineProperties(hidden, {
      type: { value: "api", enumerable: false },
      key: { value: "sk-oculta", enumerable: false },
    });
    assert.throws(
      () => crypto.encrypt(owner, hidden),
      expectError("INVALID_CREDENTIAL_PAYLOAD"),
    );
  });
});
