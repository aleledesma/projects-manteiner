/**
 * Generacion de los archivos que opencode lee al arrancar.
 *
 * Son funciones puras a proposito: corren dentro del contenedor, donde no hay
 * forma comoda de testear, asi que la logica se prueba desde el host y el
 * entrypoint queda reducido a escribir y ejecutar.
 */

export interface RunnerFile {
  readonly path: string;
  readonly content: string;
  /** Se agrega al final en vez de reemplazar el archivo. */
  readonly append: boolean;
}

export interface RunnerContext {
  readonly runId: string;
  /** `providerId/modelId`, tal como lo nombra opencode. */
  readonly model: string;
  /** System prompt ya interpolado por la API, desde @manteiner/contracts. */
  readonly prompt: string;
  readonly workdir: string;
}

/**
 * `opencode.json` del run.
 *
 * Solo lleva lo que necesitamos apagar. Cada clave de mas es una forma de que
 * opencode rechace la config y el contenedor no arranque, y el modelo se
 * elige por llamada en `session.prompt`, no aca.
 */
export function buildOpencodeConfig(context: RunnerContext): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      // Sin snapshots: el diff lo saca la app con `git diff` sobre el volumen,
      // y los snapshots escribirian en el repo justo lo que queremos medir.
      snapshot: false,
      share: "disabled",
      autoupdate: false,
      model: context.model,
    },
    null,
    2,
  )}\n`;
}

/**
 * Definicion del agente.
 *
 * `bash: allow` es decision explicita: una auditoria de mantenimiento necesita
 * consultar el estado real de las dependencias, y arrancar denegando obligaba a
 * adivinar la allowlist. Se restringe despues, con los comandos que el agente
 * pida de verdad. La contencion real es el contenedor, no este permiso: sin
 * token de GitHub, sin socket de Docker y con `CapDrop: ALL`.
 *
 * `external_directory: deny` sigue siendo innegociable: el agente no sale de
 * `/work/repo`.
 */
export function buildAgentDefinition(context: RunnerContext): string {
  return [
    "---",
    "description: Auditoria de mantenimiento de repositorios",
    "mode: primary",
    "temperature: 0.1",
    "permission:",
    "  bash: allow",
    "  read: allow",
    "  glob: allow",
    "  grep: allow",
    "  list: allow",
    "  webfetch: allow",
    "  edit: allow",
    "  write: allow",
    "  external_directory: deny",
    "---",
    "",
    context.prompt.trimEnd(),
    "",
  ].join("\n");
}

/**
 * Los archivos a escribir, como rutas relativas al workdir.
 *
 * `.git/info/exclude` se agrega para que `.opencode/` no aparezca nunca como
 * cambio del agente. opencode escribe ahi su propio `node_modules` y un
 * `.gitignore` que lo tapa, pero no tapa los dos archivos que generamos
 * nosotros; y si el repo auditado ya versionara `.opencode/`, los estariamos
 * modificando. `info/exclude` es local al clon y no toca ningun archivo
 * versionado, asi que el diff del informe queda limpio en los dos casos.
 */
export function runnerFiles(context: RunnerContext): RunnerFile[] {
  return [
    { path: ".git/info/exclude", content: "\n# manteiner\n.opencode/\n", append: true },
    { path: ".opencode/opencode.json", content: buildOpencodeConfig(context) },
    { path: ".opencode/agents/maintainer.md", content: buildAgentDefinition(context) },
  ].map((archivo) => ({ append: false, ...archivo }));
}

const REQUERIDAS = ["MANTEINER_RUN_ID", "MANTEINER_MODEL", "MANTEINER_PROMPT_B64"] as const;

/**
 * Lee el contexto del entorno. Falla ruidosamente si falta algo: un runner que
 * arranca a medias produce una auditoria silenciosamente peor.
 *
 * El prompt viaja en base64 porque tiene saltos de linea y markdown; no es
 * secreto, asi que no hay problema en que se vea en `docker inspect`.
 */
export function readContext(env: Record<string, string | undefined>): RunnerContext {
  const faltantes = REQUERIDAS.filter((clave) => !env[clave]);
  if (faltantes.length > 0) {
    throw new Error(`Faltan variables de entorno: ${faltantes.join(", ")}`);
  }

  const prompt = Buffer.from(env["MANTEINER_PROMPT_B64"]!, "base64").toString("utf8");
  if (prompt.trim().length === 0) throw new Error("MANTEINER_PROMPT_B64 decodifico a un prompt vacio");

  return {
    runId: env["MANTEINER_RUN_ID"]!,
    model: env["MANTEINER_MODEL"]!,
    prompt,
    workdir: env["MANTEINER_WORKDIR"] ?? "/work/repo",
  };
}
