/**
 * Entrypoint del contenedor del agente.
 *
 * Escribe la config y la definicion del agente en el volumen, arranca
 * `opencode serve` y le reenvia las senales. No dirige la sesion: eso lo hace
 * el orquestador desde el host, donde el prompt, el JSON Schema y los
 * reintentos son faciles de versionar y testear (doc 05).
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import { readContext, runnerFiles } from "./workspace.ts";

const PORT = process.env["MANTEINER_PORT"] ?? "4096";

async function main(): Promise<void> {
  const context = readContext(process.env);

  for (const archivo of runnerFiles(context)) {
    const destino = join(context.workdir, archivo.path);
    await mkdir(dirname(destino), { recursive: true });
    if (archivo.append) await appendFile(destino, archivo.content, "utf8");
    else await writeFile(destino, archivo.content, { encoding: "utf8", mode: 0o600 });
  }

  const hijo = spawn("opencode", ["serve", "--hostname", "0.0.0.0", "--port", PORT], {
    cwd: context.workdir,
    stdio: "inherit",
    env: process.env,
  });

  // `docker stop` manda SIGTERM: reenviarlo deja que opencode cierre solo en vez
  // de esperar los 10s de gracia y comerse un SIGKILL.
  let cerrando = false;
  for (const senal of ["SIGTERM", "SIGINT"] as const) {
    process.on(senal, () => {
      if (cerrando) return;
      cerrando = true;
      hijo.kill(senal);
    });
  }

  const codigo = await new Promise<number>((resolve) => {
    hijo.on("error", (error) => {
      console.error(`[runner] no se pudo ejecutar opencode: ${error.message}`);
      resolve(127);
    });
    hijo.on("exit", (code, signal) => resolve(code ?? (signal ? 143 : 1)));
  });

  process.exit(codigo);
}

main().catch((error: unknown) => {
  console.error(`[runner] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
