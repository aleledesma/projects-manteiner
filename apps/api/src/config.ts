/**
 * Configuracion por entorno, validada al arrancar.
 *
 * Regla del doc 10: si falta o es invalido un secreto, la API NO arranca.
 * Es preferible caer con un mensaje claro a correr sin cifrado o con una clave
 * a medias, que falla mucho mas tarde y mucho peor.
 */

import { createPrivateKey } from "node:crypto";

import { z } from "zod";

/** 32 bytes exactos en base64: es la clave de AES-256-GCM. */
const masterKey = z
  .string()
  .refine(
    (v) => {
      try {
        const decoded = Buffer.from(v, "base64");
        return decoded.length === 32 && decoded.toString("base64") === v;
      } catch {
        return false;
      }
    },
    { message: "debe ser exactamente 32 bytes codificados en base64" },
  );

const githubAppPrivateKey = z.string().refine(
  (value) => {
    try {
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64") !== value) return false;
      return createPrivateKey(decoded).asymmetricKeyType === "rsa";
    } catch {
      return false;
    }
  },
  { message: "debe ser una private key RSA PEM codificada en base64" },
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_URL: z.url().default("http://localhost:3001"),
  WEB_URL: z.url().default("http://localhost:5173"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  DATABASE_PATH: z.string().default("./data/manteiner.db"),
  ARTIFACTS_DIR: z.string().default("./data/artifacts"),
  DOCKER_SOCKET: z.string().min(1, "no puede estar vacio").optional(),
  // Consultas baratas: ping, inspect, list.
  DOCKER_API_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),
  // Crear, arrancar y borrar contenedores con volumenes montados. En un daemon
  // ocupado un `remove --force -v` tarda segundos; con el timeout de las
  // consultas baratas, un borrado lento convertia una auditoria exitosa en un
  // error de limpieza.
  DOCKER_LIFECYCLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  GIT_IMAGE: z.string().trim().min(1, "no puede estar vacio").default("manteiner-git:0.1.0"),
  MAX_REPO_SIZE_KB: z.coerce.number().int().positive().default(2_000_000),
  CLONE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30 * 60_000).default(5 * 60_000),
  PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30 * 60_000).default(3 * 60_000),
  PROVIDER_HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  OAUTH_DEVICE_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(30 * 60_000).default(15 * 60_000),
  RUN_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(2 * 60 * 60_000).default(30 * 60_000),
  REFRESH_MARGIN_MS: z.coerce.number().int().min(0).max(60 * 60_000).default(5 * 60_000),
  AGENT_IMAGE: z.string().trim().min(1, "no puede estar vacio").default("manteiner-agent:0.1.0"),
  PROVIDER_CATALOG_PATH: z.string().default("./data/provider-catalog.json"),
  PROVIDER_CATALOG_MAX_AGE_MS: z.coerce.number().int().min(60_000).default(24 * 60 * 60_000),
  PROVIDER_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(5 * 60_000).default(30_000),
  PROVIDER_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(10 * 60_000).default(2 * 60_000),
  CONTAINER_START_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(10 * 60_000).default(60_000),
  AGENT_MEMORY_MB: z.coerce.number().int().min(512).max(32_768).default(2_048),
  AGENT_CPUS: z.coerce.number().min(0.5).max(32).default(2),
  // Cada run levanta un contenedor con CPU y memoria reservadas: el resto espera
  // en cola (estado `queued`) hasta que se libera un lugar.
  MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(10).default(2),
  MAX_QUEUED_RUNS: z.coerce.number().int().min(0).max(100).default(10),
  // Fase 9: limites por usuario en los endpoints que gastan dinero o recursos.
  RATE_LIMIT_ENABLED: z.stringbool().default(true),

  MASTER_KEY: masterKey,
  // Rotacion (doc 10): la clave que cifra hoy lleva esta version. Para rotar se
  // sube la version, se pone la clave vieja en MASTER_KEY_PREVIOUS y se corre
  // `npm run rotate-master-key --workspace @manteiner/api`.
  MASTER_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  MASTER_KEY_PREVIOUS: masterKey.optional(),
  SESSION_SECRET: z.string().min(32, "debe tener al menos 32 caracteres"),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1, "es obligatorio"),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1, "es obligatorio"),
  GITHUB_APP_ID: z.string().regex(/^\d+$/, "debe ser numerico"),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/, "debe ser un slug valido"),
  GITHUB_APP_CLIENT_ID: z.string().min(1, "es obligatorio"),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1, "es obligatorio"),
  GITHUB_APP_PRIVATE_KEY_BASE64: githubAppPrivateKey,
  GITHUB_API_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && new URL(env.PUBLIC_URL).origin !== new URL(env.WEB_URL).origin) {
    ctx.addIssue({
      code: "custom",
      path: ["WEB_URL"],
      message: "debe compartir origen con PUBLIC_URL en produccion; publica /api con un reverse proxy",
    });
  }
});

export type Config = Readonly<z.infer<typeof envSchema>> & {
  readonly isProduction: boolean;
  readonly isTest: boolean;
};

/**
 * Valida `process.env` y devuelve la config.
 * Lanza `ConfigError` con TODOS los problemas juntos, no solo el primero: si
 * faltan tres variables, queremos enterarnos de las tres en un solo intento.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problemas = result.error.issues.map((i) => {
      const campo = i.path.join(".") || "(raiz)";
      return `  - ${campo}: ${i.message}`;
    });
    throw new ConfigError(
      `Configuracion invalida. Revisa tu archivo .env:\n${problemas.join("\n")}\n\n` +
        `Podes copiar .env.example como punto de partida.`,
    );
  }

  const env = result.data;
  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === "production",
    isTest: env.NODE_ENV === "test",
  });
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function previousMasterKeyBytes(config: Config): Buffer | null {
  return config.MASTER_KEY_PREVIOUS ? Buffer.from(config.MASTER_KEY_PREVIOUS, "base64") : null;
}

/** La clave maestra ya decodificada. Se deriva aca para no repetir el Buffer.from. */
export function masterKeyBytes(config: Config): Buffer {
  return Buffer.from(config.MASTER_KEY, "base64");
}

export function githubAppPrivateKeyBytes(config: Config): Buffer {
  return Buffer.from(config.GITHUB_APP_PRIVATE_KEY_BASE64, "base64");
}
