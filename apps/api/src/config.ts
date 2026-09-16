/**
 * Configuracion por entorno, validada al arrancar.
 *
 * Regla del doc 10: si falta o es invalido un secreto, la API NO arranca.
 * Es preferible caer con un mensaje claro a correr sin cifrado o con una clave
 * a medias, que falla mucho mas tarde y mucho peor.
 */

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

  MASTER_KEY: masterKey,
  SESSION_SECRET: z.string().min(32, "debe tener al menos 32 caracteres"),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1, "es obligatorio"),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1, "es obligatorio"),
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

/** La clave maestra ya decodificada. Se deriva aca para no repetir el Buffer.from. */
export function masterKeyBytes(config: Config): Buffer {
  return Buffer.from(config.MASTER_KEY, "base64");
}
