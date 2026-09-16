import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface ApiProviderCredential {
  readonly type: "api";
  readonly key: string;
}

export interface OAuthProviderCredential {
  readonly type: "oauth";
  readonly refresh: string;
  readonly access: string;
  readonly expires: number;
  readonly accountId?: string;
  readonly enterpriseUrl?: string;
}

export type ProviderCredentialPayload = ApiProviderCredential | OAuthProviderCredential;

export interface CredentialOwner {
  readonly userId: string;
  readonly providerId: string;
}

export interface EncryptedCredential {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly keyVersion: number;
}

export type CredentialCryptoErrorCode =
  | "INVALID_MASTER_KEY"
  | "INVALID_CREDENTIAL_CONTEXT"
  | "INVALID_CREDENTIAL_PAYLOAD"
  | "UNSUPPORTED_KEY_VERSION"
  | "CREDENTIAL_DECRYPTION_FAILED";

export class CredentialCryptoError extends Error {
  override readonly name = "CredentialCryptoError";

  constructor(
    readonly code: CredentialCryptoErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Cifra credenciales para persistirlas en `provider_credentials`. */
export class CredentialCrypto {
  readonly keyVersion: number;
  readonly #masterKey: Buffer;

  constructor(masterKey: Uint8Array, keyVersion = 1) {
    if (masterKey.byteLength !== KEY_BYTES) {
      throw new CredentialCryptoError(
        "INVALID_MASTER_KEY",
        `MASTER_KEY debe tener exactamente ${KEY_BYTES} bytes.`,
      );
    }
    if (!Number.isInteger(keyVersion) || keyVersion < 1) {
      throw new CredentialCryptoError(
        "INVALID_MASTER_KEY",
        "La version de la clave debe ser un entero positivo.",
      );
    }

    this.#masterKey = Buffer.from(masterKey);
    this.keyVersion = keyVersion;
  }

  encrypt(owner: CredentialOwner, payload: ProviderCredentialPayload): EncryptedCredential {
    const aad = buildAdditionalData(owner);
    const plaintext = serializeCredential(payload);
    const iv = randomBytes(IV_BYTES);

    try {
      const cipher = createCipheriv(ALGORITHM, this.#masterKey, iv, {
        authTagLength: AUTH_TAG_BYTES,
      }) as CipherGCM;
      cipher.setAAD(aad);

      return {
        ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
        iv,
        authTag: cipher.getAuthTag(),
        keyVersion: this.keyVersion,
      };
    } finally {
      plaintext.fill(0);
    }
  }

  decrypt(owner: CredentialOwner, encrypted: EncryptedCredential): ProviderCredentialPayload {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new CredentialCryptoError(
        "UNSUPPORTED_KEY_VERSION",
        `No hay una clave configurada para key_version=${encrypted.keyVersion}.`,
      );
    }
    if (encrypted.iv.byteLength !== IV_BYTES || encrypted.authTag.byteLength !== AUTH_TAG_BYTES) {
      throw decryptionFailed();
    }

    const aad = buildAdditionalData(owner);
    let plaintext: Buffer | undefined;

    try {
      const decipher = createDecipheriv(ALGORITHM, this.#masterKey, encrypted.iv, {
        authTagLength: AUTH_TAG_BYTES,
      }) as DecipherGCM;
      decipher.setAAD(aad);
      decipher.setAuthTag(encrypted.authTag);
      plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);

      const payload: unknown = JSON.parse(plaintext.toString("utf8"));
      if (!isProviderCredential(payload)) throw new Error("payload invalido");
      return payload;
    } catch (cause) {
      if (cause instanceof CredentialCryptoError) throw cause;
      throw decryptionFailed(cause);
    } finally {
      plaintext?.fill(0);
    }
  }
}

function buildAdditionalData(owner: CredentialOwner): Buffer {
  if (!owner.userId || !owner.providerId) {
    throw new CredentialCryptoError(
      "INVALID_CREDENTIAL_CONTEXT",
      "userId y providerId son obligatorios para cifrar una credencial.",
    );
  }
  return Buffer.from(JSON.stringify([owner.userId, owner.providerId]), "utf8");
}

function serializeCredential(payload: ProviderCredentialPayload): Buffer {
  try {
    if (!isProviderCredential(payload)) throw new Error("payload invalido");
    return Buffer.from(JSON.stringify(payload), "utf8");
  } catch (cause) {
    throw new CredentialCryptoError(
      "INVALID_CREDENTIAL_PAYLOAD",
      "El payload de la credencial no tiene una forma valida.",
      { cause },
    );
  }
}

function isProviderCredential(value: unknown): value is ProviderCredentialPayload {
  if (value === null || typeof value !== "object") return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const credential = value as Record<string, unknown>;

  if (credential["type"] === "api") {
    return (
      hasExactlyKeys(credential, ["type", "key"]) &&
      typeof credential["key"] === "string" &&
      credential["key"].length > 0
    );
  }

  if (credential["type"] !== "oauth") return false;
  return (
    hasExactlyKeys(credential, [
      "type",
      "refresh",
      "access",
      "expires",
      "accountId",
      "enterpriseUrl",
    ]) &&
    typeof credential["refresh"] === "string" &&
    credential["refresh"].length > 0 &&
    typeof credential["access"] === "string" &&
    credential["access"].length > 0 &&
    typeof credential["expires"] === "number" &&
    Number.isSafeInteger(credential["expires"]) &&
    credential["expires"] >= 0 &&
    optionalString(credential["accountId"]) &&
    optionalString(credential["enterpriseUrl"])
  );
}

function hasExactlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string" || !allowedKeys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function decryptionFailed(cause?: unknown): CredentialCryptoError {
  return new CredentialCryptoError(
    "CREDENTIAL_DECRYPTION_FAILED",
    "No se pudo autenticar o descifrar la credencial.",
    cause === undefined ? undefined : { cause },
  );
}
