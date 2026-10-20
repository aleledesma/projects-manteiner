/**
 * Rotacion de MASTER_KEY (Fase 9, doc 10).
 *
 * Re-cifra todas las credenciales de proveedores con la clave nueva en una sola
 * transaccion: o quedan todas rotadas, o ninguna. Es idempotente: las filas que
 * ya tienen la version actual se saltean, asi que correrla dos veces no rompe.
 */

import type { DatabaseConnection } from "../db/client.ts";
import { CredentialCrypto } from "./credential-crypto.ts";

interface Fila {
  id: string;
  user_id: string;
  provider_id: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
}

export interface RotationReport {
  readonly rotated: number;
  readonly alreadyCurrent: number;
}

export class MasterKeyRotationError extends Error {
  override readonly name = "MasterKeyRotationError";
}

export function rotateMasterKey(
  database: DatabaseConnection,
  keys: { current: Uint8Array; currentVersion: number; previous: Uint8Array | null },
  now: () => number = Date.now,
): RotationReport {
  const actual = new CredentialCrypto(keys.current, keys.currentVersion);
  const filas = database.sqlite
    .prepare(
      `SELECT id, user_id, provider_id, ciphertext, iv, auth_tag, key_version
       FROM provider_credentials`,
    )
    .all() as Fila[];

  const pendientes = filas.filter((fila) => fila.key_version !== keys.currentVersion);
  if (pendientes.length > 0 && !keys.previous) {
    throw new MasterKeyRotationError(
      `Hay ${pendientes.length} credenciales con otra version de clave: falta MASTER_KEY_PREVIOUS.`,
    );
  }
  if (pendientes.some((fila) => fila.key_version > keys.currentVersion)) {
    throw new MasterKeyRotationError(
      "Hay credenciales cifradas con una version mayor a MASTER_KEY_VERSION: subi la version.",
    );
  }

  const actualizar = database.sqlite.prepare(
    `UPDATE provider_credentials
     SET ciphertext = ?, iv = ?, auth_tag = ?, key_version = ?, updated_at = ?
     WHERE id = ?`,
  );

  database.sqlite.transaction(() => {
    for (const fila of pendientes) {
      const owner = { userId: fila.user_id, providerId: fila.provider_id };
      // Si la clave anterior no descifra alguna fila, la excepcion aborta la
      // transaccion entera: no queda una base mitad rotada.
      const payload = new CredentialCrypto(keys.previous!, fila.key_version).decrypt(owner, {
        ciphertext: fila.ciphertext,
        iv: fila.iv,
        authTag: fila.auth_tag,
        keyVersion: fila.key_version,
      });
      const cifrado = actual.encrypt(owner, payload);
      actualizar.run(cifrado.ciphertext, cifrado.iv, cifrado.authTag, cifrado.keyVersion, now(), fila.id);
    }
  })();

  return { rotated: pendientes.length, alreadyCurrent: filas.length - pendientes.length };
}
