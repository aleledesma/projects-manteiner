/**
 * Utilidades compartidas por los runtimes de Docker.
 *
 * Todo contenedor que creamos lleva la etiqueta `manteiner.kind`: es lo que
 * permite reconocer y borrar huerfanos al arrancar sin depender de los nombres.
 */

export const MANTEINER_LABEL = "manteiner.kind";
export const RUN_LABEL = "manteiner.run";
/** Prefijo de los volumenes de workspace, para la limpieza de huerfanos. */
export const WORKSPACE_VOLUME_PREFIX = "manteiner-ws-";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Corre una promesa con fecha limite. `onTimeout` existe para abortar el
 * trabajo subyacente: sin eso el timeout solo rechaza y la operacion real sigue
 * viva, reteniendo un contenedor o una conexion.
 */
export function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(timeoutError);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function dockerStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

/**
 * Demultiplexa el stream de logs de Docker.
 *
 * Sin TTY, Docker antepone una cabecera de 8 bytes a cada trozo con el flujo y
 * el tamano. Concatenar el buffer crudo mete basura binaria en medio del texto.
 */
export function demultiplexDockerStream(raw: Buffer): string {
  let salida = "";
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const tamano = raw.readUInt32BE(offset + 4);
    const desde = offset + 8;
    const hasta = Math.min(desde + tamano, raw.length);
    salida += raw.subarray(desde, hasta).toString("utf8");
    offset = hasta;
  }
  // Si no venia multiplexado (TTY activo) el bucle no avanza: se devuelve crudo.
  return offset === 0 ? raw.toString("utf8") : salida;
}
