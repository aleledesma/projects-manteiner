/**
 * Carga, refresco y persistencia de la credencial OAuth de OpenAI.
 *
 * Es la version de spike de lo que en la Fase 4 va a vivir en la API con la
 * credencial cifrada en SQLite. La logica de CUANDO refrescar es la misma, y es
 * la que se corrigio en R3: refrescar lo MENOS posible, porque el refresh token
 * rota y cada refresco es una oportunidad de perder la cuenta.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(__dirname, "..", "..", ".out", "openai-tokens.json");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";

/** La forma exacta que acepta `client.auth.set`. */
export interface OauthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
}

export interface LoadResult {
  credential: OauthCredential;
  refreshed: boolean;
}

/**
 * Carga la credencial y la refresca solo si hace falta.
 *
 * @param margenMs cuanto tiempo de vida debe quedarle al token para considerarlo
 *   utilizable. En la app real esto es `RUN_TIMEOUT_MS + margen`: el token tiene
 *   que sobrevivir a todo el run, porque el contenedor no puede refrescarlo.
 */
export async function loadCredential(margenMs = 35 * 60 * 1000): Promise<LoadResult> {
  if (!existsSync(OUT_FILE)) {
    throw new Error(
      `No hay credencial guardada en spikes/.out/openai-tokens.json.\n` +
        `Corré primero:  npm run device-flow --workspace manteiner-spikes`,
    );
  }

  const guardado = JSON.parse(await readFile(OUT_FILE, "utf8")) as {
    credential: OauthCredential;
  };
  const credential = guardado.credential;

  if (credential.expires >= Date.now() + margenMs) {
    return { credential, refreshed: false };
  }

  const nueva = await refreshCredential(credential);
  await persist(nueva);
  return { credential: nueva, refreshed: true };
}

export async function refreshCredential(actual: OauthCredential): Promise<OauthCredential> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: actual.refresh,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (!res.ok) {
    throw new Error(
      `El refresh fallo con HTTP ${res.status}. La credencial quedo invalida: ` +
        `hay que rehacer el device flow.`,
    );
  }

  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    type: "oauth",
    // Si el proveedor no devuelve refresh nuevo, se conserva el anterior.
    refresh: tokens.refresh_token || actual.refresh,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(actual.accountId ? { accountId: actual.accountId } : {}),
  };
}

/**
 * Persiste ANTES de usar la credencial nueva. Si se rota el token y el guardado
 * falla despues, el usuario pierde la cuenta. Ver R3.
 */
async function persist(credential: OauthCredential): Promise<void> {
  const previo = JSON.parse(await readFile(OUT_FILE, "utf8"));
  await writeFile(
    OUT_FILE,
    JSON.stringify({ ...previo, credential, savedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}
