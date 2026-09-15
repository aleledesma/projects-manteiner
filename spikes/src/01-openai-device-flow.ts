/**
 * SPIKE 1 — Device flow de OpenAI (cuenta ChatGPT Plus/Pro)
 * -----------------------------------------------------------------------------
 * Objetivo: comprobar que podemos obtener credenciales OAuth de una cuenta
 * ChatGPT Plus/Pro sin navegador en el servidor y sin callback en localhost,
 * para despues inyectarlas en opencode con `client.auth.set({ type: "oauth" })`.
 *
 * Replica el metodo "ChatGPT Pro/Plus (headless)" del plugin de opencode
 * (packages/opencode/src/plugin/openai/codex.ts). Las constantes son las del
 * CLI de Codex, publicas en ese repositorio.
 *
 * Este script responde cuatro preguntas del doc 04:
 *   1. ¿Funciona el device flow con esta cuenta?
 *   2. ¿Que estructura tienen los claims del JWT y de donde sale el accountId?
 *   3. ¿Cuanto dura el access token?
 *   4. ¿ROTA el refresh token al usarlo?  <- la mas importante: define si hay
 *      que releer la credencial del contenedor despues de cada run.
 *
 * Uso:
 *   npm run device-flow            -> flujo completo + prueba de refresh
 *   npm run device-flow:refresh    -> solo refresca los tokens ya guardados
 *
 * Los tokens se guardan en spikes/.out/openai-tokens.json (gitignored).
 */

import { writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Constantes del cliente Codex (publicas, tomadas del plugin de opencode) ──
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEVICE_PAGE = `${ISSUER}/codex/device`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const USER_AGENT = process.env.MANTEINER_UA ?? "opencode/1.0.0";

// ── Parametros del polling ──────────────────────────────────────────────────
const POLL_SAFETY_MARGIN_MS = 1_000;
const DEFAULT_INTERVAL_S = 5;
const OVERALL_TIMEOUT_MS = 15 * 60 * 1_000; // los device codes suelen durar ~15 min

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", ".out");
const OUT_FILE = resolve(OUT_DIR, "openai-tokens.json");

// ── Tipos ───────────────────────────────────────────────────────────────────

interface DeviceCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval?: string | number;
}

interface DeviceTokenResponse {
  authorization_code: string;
  code_verifier: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  id_token?: string;
  token_type?: string;
  scope?: string;
}

/** La forma exacta que espera `client.auth.set` de opencode. */
interface StoredCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
}

// ── Utilidades de presentacion ──────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function step(n: string, msg: string) {
  console.log(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${msg}${c.reset}`);
}
function ok(msg: string) {
  console.log(`  ${c.green}OK${c.reset}  ${msg}`);
}
function info(msg: string) {
  console.log(`  ${c.dim}--${c.reset}  ${msg}`);
}
function warn(msg: string) {
  console.log(`  ${c.yellow}!!${c.reset}  ${msg}`);
}
function fail(msg: string) {
  console.log(`  ${c.red}XX${c.reset}  ${msg}`);
}

/** Muestra un secreto sin exponerlo: primeros y ultimos caracteres. */
function mask(secret: string | undefined): string {
  if (!secret) return "(ausente)";
  if (secret.length <= 16) return `${secret.slice(0, 4)}...(${secret.length} chars)`;
  return `${secret.slice(0, 8)}...${secret.slice(-4)}  (${secret.length} chars)`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── JWT (solo decodificacion de claims; NO verificamos firma, no hace falta) ─

function decodeJwtClaims(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Busca el accountId probando las rutas conocidas. Si ninguna funciona, el
 * volcado de claims que imprime el script nos dice cual es la correcta.
 */
function extractAccountId(tokens: TokenResponse): { value?: string; source?: string } {
  const candidates: Array<[string, string[]]> = [
    ["id_token:auth.chatgpt_account_id", ["https://api.openai.com/auth", "chatgpt_account_id"]],
    ["id_token:auth.user_id", ["https://api.openai.com/auth", "user_id"]],
    ["id_token:chatgpt_account_id", ["chatgpt_account_id"]],
    ["id_token:account_id", ["account_id"]],
  ];

  for (const source of ["id_token", "access_token"] as const) {
    const claims = decodeJwtClaims(tokens[source]);
    if (!claims) continue;
    for (const [label, path] of candidates) {
      let cur: unknown = claims;
      for (const key of path) {
        if (cur && typeof cur === "object" && key in (cur as object)) {
          cur = (cur as Record<string, unknown>)[key];
        } else {
          cur = undefined;
          break;
        }
      }
      if (typeof cur === "string" && cur.length > 0) {
        return { value: cur, source: label.replace("id_token", source) };
      }
    }
  }
  return {};
}

/** Imprime la forma de los claims sin volcar valores largos. */
function dumpClaimShape(label: string, claims: Record<string, unknown> | null) {
  if (!claims) {
    info(`${label}: (no se pudo decodificar)`);
    return;
  }
  info(`${label}:`);
  const walk = (obj: Record<string, unknown>, indent: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        console.log(`${indent}${c.dim}${k}:${c.reset}`);
        walk(v as Record<string, unknown>, indent + "  ");
      } else {
        const shown =
          typeof v === "string" && v.length > 48 ? `${v.slice(0, 45)}...` : JSON.stringify(v);
        console.log(`${indent}${c.dim}${k}:${c.reset} ${shown}`);
      }
    }
  };
  walk(claims, "        ");
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T | null; raw: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(raw) as T;
  } catch {
    /* respuesta no-JSON: la dejamos en raw para diagnostico */
  }
  return { status: res.status, data, raw };
}

async function postForm<T>(url: string, params: Record<string, string>): Promise<{ status: number; data: T | null; raw: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams(params).toString(),
  });
  const raw = await res.text();
  let data: T | null = null;
  try {
    data = JSON.parse(raw) as T;
  } catch {
    /* idem */
  }
  return { status: res.status, data, raw };
}

// ── Pasos del flujo ─────────────────────────────────────────────────────────

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  step("1/5", "Solicitando codigo de dispositivo");
  const { status, data, raw } = await postJson<DeviceCodeResponse>(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID },
  );

  if (status !== 200 || !data?.device_auth_id || !data?.user_code) {
    fail(`HTTP ${status}`);
    console.log(`\n${c.dim}${raw.slice(0, 500)}${c.reset}\n`);
    throw new Error("No se pudo iniciar el device flow");
  }

  ok(`device_auth_id: ${mask(data.device_auth_id)}`);
  ok(`interval sugerido: ${data.interval ?? DEFAULT_INTERVAL_S}s`);
  return data;
}

function showInstructions(userCode: string) {
  const line = "=".repeat(58);
  console.log(`\n${c.bold}${line}${c.reset}`);
  console.log(`${c.bold}  1. Abri esta URL en tu navegador:${c.reset}`);
  console.log(`\n     ${c.cyan}${DEVICE_PAGE}${c.reset}\n`);
  console.log(`${c.bold}  2. Ingresa este codigo:${c.reset}`);
  console.log(`\n     ${c.bold}${c.green}${userCode}${c.reset}\n`);
  console.log(`${c.bold}${line}${c.reset}\n`);
}

async function pollForAuthorization(device: DeviceCodeResponse): Promise<DeviceTokenResponse> {
  step("2/5", "Esperando que autorices en el navegador");

  const intervalS = Math.max(Number(device.interval) || DEFAULT_INTERVAL_S, 1);
  const intervalMs = intervalS * 1_000 + POLL_SAFETY_MARGIN_MS;
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    const { status, data, raw } = await postJson<DeviceTokenResponse>(
      `${ISSUER}/api/accounts/deviceauth/token`,
      { device_auth_id: device.device_auth_id, user_code: device.user_code },
    );

    if (status === 200 && data?.authorization_code) {
      process.stdout.write("\n");
      ok(`Autorizado tras ${attempts} intentos (${Math.round((attempts * intervalMs) / 1000)}s)`);
      return data;
    }

    // 403 / 404 = todavia no autorizaste. Cualquier otro codigo es un fallo real.
    if (status !== 403 && status !== 404) {
      process.stdout.write("\n");
      fail(`Respuesta inesperada del polling: HTTP ${status}`);
      console.log(`\n${c.dim}${raw.slice(0, 500)}${c.reset}\n`);
      throw new Error("Device flow rechazado");
    }

    const restanteS = Math.round((deadline - Date.now()) / 1000);
    process.stdout.write(
      `\r  ${c.dim}..  esperando (intento ${attempts}, expira en ${restanteS}s)${c.reset}   `,
    );
    await sleep(intervalMs);
  }

  process.stdout.write("\n");
  throw new Error("El codigo expiro sin que se completara la autorizacion");
}

async function exchangeCode(auth: DeviceTokenResponse): Promise<TokenResponse> {
  step("3/5", "Intercambiando el codigo por tokens (PKCE)");

  const { status, data, raw } = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, {
    grant_type: "authorization_code",
    code: auth.authorization_code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: auth.code_verifier,
  });

  if (status !== 200 || !data?.access_token) {
    fail(`Token exchange fallo: HTTP ${status}`);
    console.log(`\n${c.dim}${raw.slice(0, 800)}${c.reset}\n`);
    if (status === 403) {
      warn("Hay reportes conocidos de 403 en el intercambio de tokens.");
      warn("Si se repite, anotalo en docs/13-hallazgos-spike.md: cambia el plan de v1.");
    }
    throw new Error("No se pudieron obtener los tokens");
  }

  ok(`access_token:  ${mask(data.access_token)}`);
  ok(`refresh_token: ${mask(data.refresh_token)}`);
  ok(`expires_in:    ${data.expires_in ?? "(no informado)"}s`);
  ok(`id_token:      ${data.id_token ? "presente" : "ausente"}`);
  return data;
}

function inspectClaims(tokens: TokenResponse) {
  step("4/5", "Inspeccionando claims del JWT");

  dumpClaimShape("claims del id_token", decodeJwtClaims(tokens.id_token));

  const { value, source } = extractAccountId(tokens);
  if (value) {
    ok(`accountId encontrado en ${source}: ${value}`);
  } else {
    warn("No se encontro accountId en las rutas conocidas.");
    warn("Mira el volcado de claims de arriba y anota la ruta real en el doc 04.");
  }
  return value;
}

async function testRefresh(refreshToken: string): Promise<{ rotated: boolean; tokens: TokenResponse } | null> {
  step("5/5", "Probando el refresh (la pregunta clave)");

  const { status, data, raw } = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  if (status !== 200 || !data?.access_token) {
    fail(`Refresh fallo: HTTP ${status}`);
    console.log(`\n${c.dim}${raw.slice(0, 500)}${c.reset}\n`);
    return null;
  }

  const rotated = Boolean(data.refresh_token) && data.refresh_token !== refreshToken;

  ok(`nuevo access_token: ${mask(data.access_token)}`);
  if (rotated) {
    console.log(
      `\n  ${c.yellow}${c.bold}>> EL REFRESH TOKEN ROTA.${c.reset}\n` +
        `     El contenedor del agente refresca por su cuenta y persiste el token\n` +
        `     nuevo adentro, pero lo destruimos. Hay que releer la credencial del\n` +
        `     contenedor antes de matarlo, o refrescar siempre desde el host.\n` +
        `     -> Confirma la mitigacion del doc 04.\n`,
    );
  } else {
    console.log(
      `\n  ${c.green}${c.bold}>> El refresh token NO rota.${c.reset}\n` +
        `     El mismo refresh sirve indefinidamente. La mitigacion del doc 04 se\n` +
        `     puede simplificar: alcanza con refrescar en el host antes de cada run.\n`,
    );
  }

  return { rotated, tokens: data };
}

// ── Persistencia ────────────────────────────────────────────────────────────

async function saveCredential(cred: StoredCredential, extra: Record<string, unknown>) {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });
  const payload = { credential: cred, spike: extra, savedAt: new Date().toISOString() };
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  try {
    await chmod(OUT_FILE, 0o600);
  } catch {
    /* Windows no soporta el modo POSIX; no es critico para un spike */
  }
  ok(`Credencial guardada en spikes/.out/openai-tokens.json`);
}

async function loadCredential(): Promise<StoredCredential> {
  if (!existsSync(OUT_FILE)) {
    throw new Error("No hay credencial guardada. Corre primero: npm run device-flow");
  }
  const raw = JSON.parse(await readFile(OUT_FILE, "utf8"));
  return raw.credential as StoredCredential;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function runFullFlow() {
  console.log(`\n${c.bold}SPIKE 1 — Device flow de OpenAI (ChatGPT Plus/Pro)${c.reset}`);
  console.log(`${c.dim}issuer: ${ISSUER}  ·  client_id: ${CLIENT_ID}${c.reset}`);

  const device = await requestDeviceCode();
  showInstructions(device.user_code);

  const auth = await pollForAuthorization(device);
  const tokens = await exchangeCode(auth);
  const accountId = inspectClaims(tokens);

  const expires = Date.now() + (tokens.expires_in ?? 3600) * 1_000;
  const credential: StoredCredential = {
    type: "oauth",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires,
    ...(accountId ? { accountId } : {}),
  };

  const refreshResult = await testRefresh(tokens.refresh_token);

  // Guardamos la credencial mas reciente: si roto, la vieja ya no sirve.
  const finalCred: StoredCredential = refreshResult
    ? {
        ...credential,
        access: refreshResult.tokens.access_token,
        refresh: refreshResult.tokens.refresh_token || credential.refresh,
        expires: Date.now() + (refreshResult.tokens.expires_in ?? 3600) * 1_000,
      }
    : credential;

  console.log("");
  await saveCredential(finalCred, {
    accountIdFound: Boolean(accountId),
    refreshRotates: refreshResult?.rotated ?? null,
    accessTokenLifetimeSeconds: tokens.expires_in ?? null,
    scope: tokens.scope ?? null,
  });

  printSummary({
    accountId,
    expiresIn: tokens.expires_in,
    rotated: refreshResult?.rotated ?? null,
  });
}

async function runRefreshOnly() {
  console.log(`\n${c.bold}SPIKE 1 — Solo refresh${c.reset}\n`);
  const cred = await loadCredential();
  info(`refresh guardado: ${mask(cred.refresh)}`);
  const result = await testRefresh(cred.refresh);
  if (!result) process.exitCode = 1;
  else {
    await saveCredential(
      {
        ...cred,
        access: result.tokens.access_token,
        refresh: result.tokens.refresh_token || cred.refresh,
        expires: Date.now() + (result.tokens.expires_in ?? 3600) * 1_000,
      },
      { refreshRotates: result.rotated },
    );
  }
}

function printSummary(f: { accountId?: string; expiresIn?: number; rotated: boolean | null }) {
  const line = "-".repeat(58);
  console.log(`\n${c.bold}${line}`);
  console.log(`HALLAZGOS PARA docs/13-hallazgos-spike.md${c.reset}`);
  console.log(line);
  console.log(`  Device flow funciona ............ ${c.green}SI${c.reset}`);
  console.log(
    `  accountId disponible ........... ${f.accountId ? `${c.green}SI${c.reset}` : `${c.yellow}NO (revisar claims)${c.reset}`}`,
  );
  console.log(
    `  Vida del access token .......... ${f.expiresIn ? `${f.expiresIn}s (~${Math.round(f.expiresIn / 60)} min)` : "no informado"}`,
  );
  console.log(
    `  El refresh token rota .......... ${f.rotated === null ? "no se pudo probar" : f.rotated ? `${c.yellow}SI${c.reset}` : `${c.green}NO${c.reset}`}`,
  );
  console.log(`${c.bold}${line}${c.reset}\n`);
  console.log(`Siguiente paso: usar esta credencial en el spike 2 con`);
  console.log(`${c.dim}  client.auth.set({ path: { id: "openai" }, body: <credential> })${c.reset}\n`);
}

async function main() {
  const refreshOnly = process.argv.includes("--refresh-only");
  try {
    if (refreshOnly) await runRefreshOnly();
    else await runFullFlow();
  } catch (err) {
    console.log("");
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
