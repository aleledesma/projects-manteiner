/**
 * Redaccion de secretos por patron (Fase 9, doc 10).
 *
 * La redaccion por ruta de pino (`*.token`, `*.apiKey`...) cubre los campos con
 * nombre conocido. Esto cubre el resto: un token metido adentro de un mensaje de
 * error, un log de contenedor o un stack. Se aplica a todo lo que se loguea y a
 * lo que se persiste como detalle de un run fallido.
 */

const CENSURA = "[REDACTADO]";

const PATRONES: ReadonlyArray<[RegExp, string]> = [
  // OpenAI, Anthropic y similares: sk-..., sk-proj-..., sk-ant-...
  [/\bsk-[A-Za-z0-9_-]{16,}/g, CENSURA],
  // GitHub: tokens clasicos, de instalacion, OAuth, de usuario y fine-grained.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, CENSURA],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, CENSURA],
  // JWT (tres segmentos base64url, el primero siempre empieza con eyJ).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, CENSURA],
  // Cabeceras de autorizacion volcadas a texto.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${CENSURA}`],
  // Credenciales embebidas en URLs: https://usuario:secreto@host
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${CENSURA}@`],
];

export function redactSecrets(texto: string): string {
  let resultado = texto;
  for (const [patron, reemplazo] of PATRONES) resultado = resultado.replace(patron, reemplazo);
  return resultado;
}

/**
 * Recorre un valor y redacta todos sus strings. Los `Error` se convierten en
 * objetos planos con `message` y `stack` redactados, con la forma que usa el
 * serializador `err` de pino.
 */
export function redactDeep(valor: unknown, profundidad = 0): unknown {
  if (typeof valor === "string") return redactSecrets(valor);
  if (valor === null || typeof valor !== "object" || profundidad > 8) return valor;
  if (Buffer.isBuffer(valor)) return valor;

  if (valor instanceof Error) {
    const plano: Record<string, unknown> = {
      type: valor.name,
      message: redactSecrets(valor.message),
      stack: valor.stack ? redactSecrets(valor.stack) : undefined,
    };
    for (const [clave, interno] of Object.entries(valor)) {
      plano[clave] = redactDeep(interno, profundidad + 1);
    }
    return plano;
  }

  if (Array.isArray(valor)) return valor.map((item) => redactDeep(item, profundidad + 1));

  // Solo objetos planos: requests, sockets y demas se dejan a los serializadores.
  const prototipo = Object.getPrototypeOf(valor);
  if (prototipo !== Object.prototype && prototipo !== null) return valor;

  const copia: Record<string, unknown> = {};
  for (const [clave, interno] of Object.entries(valor)) {
    copia[clave] = redactDeep(interno, profundidad + 1);
  }
  return copia;
}
