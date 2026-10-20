/**
 * Uso (con la API apagada):
 *   1. MASTER_KEY_PREVIOUS = la clave actual
 *   2. MASTER_KEY          = una clave nueva (32 bytes en base64)
 *   3. MASTER_KEY_VERSION  = la version anterior + 1
 *   4. npm run rotate-master-key --workspace @manteiner/api
 *   5. Quitar MASTER_KEY_PREVIOUS del .env.
 */

import { loadConfig, masterKeyBytes, previousMasterKeyBytes } from "../config.ts";
import { openDatabase } from "../db/client.ts";
import { rotateMasterKey } from "../services/master-key-rotation.ts";

const config = loadConfig();
const database = openDatabase(config.DATABASE_PATH);

try {
  const reporte = rotateMasterKey(database, {
    current: masterKeyBytes(config),
    currentVersion: config.MASTER_KEY_VERSION,
    previous: previousMasterKeyBytes(config),
  });
  console.log(
    `Rotacion completa: ${reporte.rotated} credenciales re-cifradas con key_version=${config.MASTER_KEY_VERSION}, ` +
      `${reporte.alreadyCurrent} ya estaban al dia.`,
  );
  if (reporte.rotated > 0) console.log("Ya podes quitar MASTER_KEY_PREVIOUS del .env.");
} catch (error) {
  console.error(`No se roto nada: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  database.close();
}
