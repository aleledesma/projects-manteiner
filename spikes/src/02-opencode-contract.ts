/**
 * PASO 1.3 — Cerrar I5: el contrato del agente contra opencode de verdad
 * -----------------------------------------------------------------------------
 * Responde, con datos y no con suposiciones:
 *
 *   I5  - opencode acepta el JSON Schema completo del informe, y el modelo lo respeta
 *   I4  - `opencode serve` arranca SIN credenciales cargadas
 *   I12 - `auth.set` acepta el campo `accountId`
 *   I2  - (verificacion) que tipos de evento aparecen realmente en una corrida
 *
 * Modos:
 *   --mode schema  (default)  Prompt sintetico, sin repositorio. Barato y rapido.
 *                             Aisla la pregunta: el schema pasa, si o no.
 *   --mode audit --repo RUTA  Prompt real de packages/contracts contra un repo
 *                             de verdad. Mas caro, pero da senal temprana de I6/I7b.
 *
 * Otros flags:
 *   --model gpt-5.4     Fuerza un modelo. Por defecto toma el primero con toolcall.
 *   --strict            Usa la variante estricta del schema (todo required).
 *   --keep-output       Guarda el JSON crudo en .out/ para inspeccionarlo.
 *   --dry-run           Corta antes del prompt. Verifica credencial, servidor,
 *                       auth.set y catalogo de modelos SIN gastar tokens.
 *
 * Uso:
 *   npm run contract --workspace manteiner-spikes
 *   npm run contract --workspace manteiner-spikes -- --mode audit --repo ../otro-proyecto
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk";

import {
  AGENT_VERSION,
  buildMaintenancePrompt,
  buildMaintenanceReportJsonSchema,
  buildStrictMaintenanceReportJsonSchema,
  jsonSchemaSizeBytes,
  maintenanceReportSchema,
  normalizeReport,
} from "@manteiner/contracts";

import { loadCredential } from "./lib/openai-credential.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", ".out");

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (nombre: string): string | undefined => {
  const i = argv.indexOf(`--${nombre}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const tiene = (nombre: string) => argv.includes(`--${nombre}`);

const MODO = (flag("mode") ?? "schema") as "schema" | "audit";
const REPO_DIR = flag("repo");
const MODELO_FORZADO = flag("model");
const USAR_STRICT = tiene("strict");
const GUARDAR = tiene("keep-output");
/** Corta antes de mandar el prompt: verifica la plomeria sin gastar tokens. */
const DRY_RUN = tiene("dry-run");

// ─── Presentacion ───────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};
const step = (n: string, m: string) =>
  console.log(`\n${c.bold}${c.cyan}[${n}]${c.reset} ${c.bold}${m}${c.reset}`);
const ok = (m: string) => console.log(`  ${c.green}OK${c.reset}  ${m}`);
const info = (m: string) => console.log(`  ${c.dim}--${c.reset}  ${m}`);
const warn = (m: string) => console.log(`  ${c.yellow}!!${c.reset}  ${m}`);
const fail = (m: string) => console.log(`  ${c.red}XX${c.reset}  ${m}`);

// ─── Prompts ────────────────────────────────────────────────────────────────

/**
 * Prompt sintetico: describe un repositorio imaginario y pide el informe.
 *
 * Es deliberadamente explicito en que se trata de una prueba del formato. No
 * queremos que el modelo se ponga a usar herramientas ni a investigar: lo unico
 * que estamos midiendo aca es si el schema se acepta y se respeta.
 */
const PROMPT_SINTETICO = `Esto es una PRUEBA DE FORMATO, no una auditoria real.

No uses herramientas ni leas archivos. Trabajá solo con la descripcion de abajo y
devolvé el JSON que pide el schema.

Repositorio imaginario a describir:
- Node.js 18 con TypeScript 5.6 y pnpm
- Framework: Next.js 15.3.0 (hay 16.0.1 disponible, con breaking changes)
- zod 3.22.4 (hay 3.23.8 disponible, solo correcciones)
- Se despliega en AWS Lambda con runtime nodejs18.x
- Hay tres componentes de UI con logica duplicada de formateo de fechas

Produci un informe de mantenimiento coherente con esa descripcion:
- zod va en dependency_updates.applied (es un minor seguro)
- next va en dependency_updates.deferred (es un major)
- al menos un finding sobre el runtime nodejs18.x y otro sobre la duplicacion
- los 7 steps, todos como completed`;

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${c.bold}PASO 1.3 — Contrato del agente contra opencode${c.reset}`);
  console.log(`${c.dim}modo: ${MODO}  ·  schema: ${USAR_STRICT ? "estricto" : "normal"}  ·  prompt: ${AGENT_VERSION}${c.reset}`);

  // ── 1. Credencial ─────────────────────────────────────────────────────────
  step("1/7", "Cargando credencial de OpenAI");
  const { credential, refreshed } = await loadCredential();
  ok(`accountId: ${credential.accountId ?? "(ausente)"}`);
  ok(
    refreshed
      ? "el token estaba por vencer: se refresco y se persistio"
      : `vigente hasta ${new Date(credential.expires).toLocaleString()}`,
  );

  // ── 2. Servidor SIN credenciales (I4) ─────────────────────────────────────
  step("2/7", "Arrancando `opencode serve` sin credenciales cargadas (I4)");
  const cwd = REPO_DIR ? resolve(REPO_DIR) : process.cwd();
  if (MODO === "audit" && !REPO_DIR) {
    throw new Error("El modo audit necesita --repo <ruta>");
  }
  info(`directorio de trabajo: ${cwd}`);

  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 30_000,
    config: { autoupdate: false, share: "disabled" },
  });
  ok(`servidor en ${server.url}`);

  try {
    const client = createOpencodeClient({ baseUrl: server.url });

    // OJO: el SDK 1.18.31 NO tiene `global.health()` pese a lo que dice la doc.
    // Lo unico que expone Global es `event()`. Como sonda de vida usamos path.get().
    const rutas = await unwrap(client.path.get());
    ok(`el servidor respondio sin credenciales -> I4 CONFIRMADO`);
    info(`directorio que reporta: ${rutas?.directory ?? rutas?.cwd ?? "(?)"}`);

    // ── 3. auth.set (I12) ───────────────────────────────────────────────────
    step("3/7", "Cargando la credencial OAuth con auth.set (I12)");
    try {
      await client.auth.set({ path: { id: "openai" }, body: credential as never });
      ok(`auth.set acepto el payload oauth${credential.accountId ? " CON accountId -> I12 CONFIRMADO" : ""}`);
    } catch (err) {
      fail(`auth.set rechazo el payload: ${mensaje(err)}`);
      if (credential.accountId) {
        warn("Reintentando SIN accountId, para aislar si el problema es ese campo...");
        const { accountId: _omitido, ...sinAccount } = credential;
        await client.auth.set({ path: { id: "openai" }, body: sinAccount as never });
        warn("Funciono sin accountId -> I12 REFUTADO: esta version no lo acepta.");
      } else {
        throw err;
      }
    }

    // ── 4. Modelos disponibles ──────────────────────────────────────────────
    step("4/7", "Listando modelos disponibles para esta cuenta");
    const catalogo = await unwrap(client.config.providers());
    const openai = catalogo?.providers?.find((p: any) => p.id === "openai");

    if (!openai) {
      throw new Error("El catalogo no devolvio el proveedor openai.");
    }

    const modelos = Object.values(openai.models ?? {}) as any[];
    const conToolcall = modelos.filter((m) => m.capabilities?.toolcall);
    info(`${modelos.length} modelos, ${conToolcall.length} con tool calling`);
    for (const m of conToolcall.slice(0, 12)) {
      console.log(
        `      ${c.dim}${m.id.padEnd(28)}${c.reset} ctx ${String(m.limit?.context ?? "?").padStart(9)}  ${m.status ?? ""}`,
      );
    }
    if (conToolcall.length > 12) info(`... y ${conToolcall.length - 12} mas`);

    const modelo = MODELO_FORZADO
      ? modelos.find((m) => m.id === MODELO_FORZADO)
      : conToolcall[0];
    if (!modelo) {
      throw new Error(`No se encontro el modelo ${MODELO_FORZADO ?? "(ninguno con toolcall)"}`);
    }
    ok(`usando: ${modelo.id}`);

    // ── 5. El schema ────────────────────────────────────────────────────────
    step("5/7", "Preparando el JSON Schema del informe");
    const schema = USAR_STRICT
      ? buildStrictMaintenanceReportJsonSchema()
      : buildMaintenanceReportJsonSchema();
    ok(`${jsonSchemaSizeBytes(schema)} bytes`);

    if (DRY_RUN) {
      console.log("");
      ok("--dry-run: plomeria verificada, no se mando ningun prompt.");
      resumen({
        aceptado: false,
        valido: false,
        modelo: `${modelo.id} (no usado)`,
        duracion: "0",
        tiposDeEvento: new Map(),
        dryRun: true,
      });
      return;
    }

    // ── 6. El prompt ────────────────────────────────────────────────────────
    step("6/7", "Ejecutando el prompt con structured output (I5)");
    const prompt =
      MODO === "audit"
        ? buildMaintenancePrompt({
            owner: "local",
            repo: REPO_DIR!.split(/[\\/]/).pop() ?? "repo",
            branch: "HEAD",
            sha: "local",
            workdir: cwd,
          })
        : PROMPT_SINTETICO;

    const session = await unwrap(client.session.create({ body: { title: "manteiner-contract" } }));
    info(`sesion ${session?.id}`);

    const tiposDeEvento = new Map<string, number>();
    const abortEventos = new AbortController();
    void consumirEventos(client, tiposDeEvento, abortEventos.signal);

    const t0 = Date.now();
    const respuesta: any = await client.session.prompt({
      path: { id: session!.id },
      body: {
        model: { providerID: "openai", modelID: modelo.id },
        parts: [{ type: "text", text: prompt }],
        format: { type: "json_schema", schema } as never,
      } as never,
    });
    const duracion = ((Date.now() - t0) / 1000).toFixed(1);
    abortEventos.abort();

    const infoRespuesta = respuesta?.data?.info ?? respuesta?.info;
    // OJO: el campo real es `structured`, NO `structured_output` como dice la doc
    // de opencode. Se deja el fallback por si cambia entre versiones.
    const structured = infoRespuesta?.structured ?? infoRespuesta?.structured_output;

    if (infoRespuesta?.error) {
      fail(`El modelo devolvio error: ${infoRespuesta.error.name}`);
      console.log(`${c.dim}${JSON.stringify(infoRespuesta.error, null, 2).slice(0, 800)}${c.reset}`);
    }

    if (!structured) {
      fail(`No hubo structured_output tras ${duracion}s -> I5 EN RIESGO`);
      if (!USAR_STRICT) {
        warn("Proba de nuevo con --strict: quizas el proveedor exige modo estricto.");
      }
      console.log(`${c.dim}${JSON.stringify(respuesta?.data ?? respuesta, null, 2).slice(0, 1200)}${c.reset}`);
      resumen({ aceptado: false, valido: false, modelo: modelo.id, duracion, tiposDeEvento });
      return;
    }

    ok(`structured_output recibido en ${duracion}s -> el schema fue ACEPTADO`);

    // ── 7. Validacion contra nuestro propio Zod ─────────────────────────────
    step("7/7", "Validando la respuesta contra el Zod de packages/contracts");
    const parsed = maintenanceReportSchema.safeParse(structured);

    if (!parsed.success) {
      fail(`El JSON NO cumple nuestro esquema. ${parsed.error.issues.length} problema(s):`);
      for (const issue of parsed.error.issues.slice(0, 15)) {
        console.log(`      ${c.red}${issue.path.join(".") || "(raiz)"}${c.reset}: ${issue.message}`);
      }
      if (parsed.error.issues.length > 15) {
        info(`... y ${parsed.error.issues.length - 15} mas`);
      }
      await guardarCrudo(structured);
      resumen({ aceptado: true, valido: false, modelo: modelo.id, duracion, tiposDeEvento });
      return;
    }

    ok("El JSON cumple el esquema completo");

    const { report, warnings } = normalizeReport(parsed.data);
    if (warnings.length === 0) {
      ok("normalizeReport no encontro nada que corregir");
    } else {
      warn(`normalizeReport corrigio ${warnings.length} cosa(s):`);
      for (const w of warnings) console.log(`      ${c.yellow}${w.code}${c.reset}: ${w.message}`);
    }

    console.log("");
    info(`health_score: ${report.summary.health_score}`);
    info(`headline: ${report.summary.headline}`);
    info(`steps: ${report.steps.length}  ·  findings: ${report.findings.length}`);
    info(
      `deps aplicadas: ${report.dependency_updates.applied.length}  ·  diferidas: ${report.dependency_updates.deferred.length}`,
    );
    info(`PR propuesto: ${report.proposed_pull_request ? "si" : "no"}`);

    if (GUARDAR) await guardarCrudo(structured);
    resumen({ aceptado: true, valido: true, modelo: modelo.id, duracion, tiposDeEvento });
  } finally {
    server.close();
  }
}

// ─── Auxiliares ─────────────────────────────────────────────────────────────

/**
  * El cliente devuelve `{ data, ... }` o el valor directo segun `responseStyle`.
  * Devolvemos `any` a proposito: este es un script de verificacion y las respuestas
  * son uniones anidadas que no vale la pena tipar a mano.
  */
async function unwrap(p: Promise<any>): Promise<any> {
  const r = await p;
  return r?.data ?? r;
}

async function consumirEventos(
  client: ReturnType<typeof createOpencodeClient>,
  contador: Map<string, number>,
  signal: AbortSignal,
): Promise<void> {
  try {
    const eventos: any = await client.event.subscribe();
    for await (const evento of eventos.stream ?? eventos) {
      if (signal.aborted) break;
      const tipo = evento?.type ?? "(sin tipo)";
      contador.set(tipo, (contador.get(tipo) ?? 0) + 1);
    }
  } catch {
    /* el stream se corta al cerrar el servidor; no es un error */
  }
}

async function guardarCrudo(structured: unknown): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const ruta = resolve(OUT_DIR, "contract-output.json");
  await writeFile(ruta, JSON.stringify(structured, null, 2), "utf8");
  info(`JSON crudo guardado en spikes/.out/contract-output.json`);
}

function mensaje(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resumen(r: {
  aceptado: boolean;
  valido: boolean;
  modelo: string;
  duracion: string;
  tiposDeEvento: Map<string, number>;
  dryRun?: boolean;
}): void {
  const linea = "-".repeat(62);
  console.log(`\n${c.bold}${linea}`);
  console.log(`HALLAZGOS PARA docs/13-hallazgos-spike.md${c.reset}`);
  console.log(linea);
  console.log(`  Modelo ......................... ${r.modelo}`);
  console.log(`  Duracion ....................... ${r.duracion}s`);
  console.log(`  I4  serve sin credenciales ..... ${c.green}CONFIRMADO${c.reset}`);
  const marca = (v: boolean) =>
    r.dryRun ? `${c.dim}sin probar (--dry-run)${c.reset}` : v ? `${c.green}SI${c.reset}` : `${c.red}NO${c.reset}`;
  console.log(`  I5a opencode acepta el schema .. ${marca(r.aceptado)}`);
  console.log(`  I5b el modelo lo respeta ....... ${marca(r.valido)}`);
  console.log(`  Variante de schema ............. ${USAR_STRICT ? "estricta" : "normal"}`);

  if (r.tiposDeEvento.size > 0) {
    console.log(`\n  Eventos observados (verificacion de I2):`);
    const ordenados = [...r.tiposDeEvento.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tipo, n] of ordenados) {
      console.log(`      ${c.dim}${tipo.padEnd(30)}${c.reset} ${n}`);
    }
  }
  console.log(`${c.bold}${linea}${c.reset}\n`);
}

main().catch((err) => {
  console.log("");
  fail(mensaje(err));
  process.exitCode = 1;
});
