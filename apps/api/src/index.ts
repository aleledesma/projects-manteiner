/**
 * Punto de entrada de la API.
 *
 * Orden deliberado: primero se valida la configuracion, despues se construye el
 * servidor. Si falta un secreto, el proceso muere antes de abrir un puerto.
 */

import { ConfigError, loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const app = buildServer(config);

  const cerrar = async (senal: string) => {
    app.log.info({ senal }, "cerrando");
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void cerrar("SIGTERM"));
  process.on("SIGINT", () => void cerrar("SIGINT"));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.fatal({ err }, "no se pudo abrir el puerto");
    process.exit(1);
  }
}

void main();
