/**
 * Traductor de eventos de opencode a eventos de dominio.
 *
 * Trata cada evento como `{ type: string }` y **no** como la union del SDK: en
 * una corrida real aparecieron seis tipos que esa union no declara
 * (`plugin.added`, `server.heartbeat`, `catalog.updated`, `message.part.delta`,
 * `reference.updated`, `integration.updated`). TypeScript no puede avisar de lo
 * que no existe en el tipo, asi que el `default` no es cortesia: es lo que
 * impide que una version nueva de opencode rompa el run (doc 07 y doc 13).
 *
 * `plugin.added` fue 45 de 79 eventos en la prueba. Filtrar no es cosmetico:
 * sin eso se escribe basura en `run_events` y se satura el navegador.
 */

import { STEP_KEYS, STEP_TITLES } from "@manteiner/contracts";

import type { RunEvent, StepStatus, StepView } from "./run-events.ts";

/** Acumular deltas y emitir cada 500ms o cada 400 caracteres, lo que llegue antes. */
const THROTTLE_MS = 500;
const MAX_CARACTERES = 400;

type Emitir = (evento: RunEvent) => void;

interface EventoOpencode {
  readonly type?: unknown;
  readonly properties?: Record<string, unknown>;
}

export class OpencodeTranslator {
  #buffer = "";
  #timer: NodeJS.Timeout | undefined;
  /** Ultima foto de pasos, para que el orquestador la reconcilie al cerrar. */
  #pasos: StepView[] = [];

  constructor(private readonly emit: Emitir) {}

  get pasos(): StepView[] {
    return this.#pasos;
  }

  handle(evento: unknown): void {
    const { type, properties } = (evento ?? {}) as EventoOpencode;
    const props = properties ?? {};

    switch (type) {
      case "server.connected":
        return;

      case "session.status":
        return this.#estado(props);

      case "session.error": {
        const error = props["error"] as { name?: unknown; message?: unknown } | undefined;
        return this.emit({
          type: "run.failed",
          payload: {
            code: typeof error?.name === "string" ? error.name : "AGENT_FAILED",
            message: typeof error?.message === "string" ? error.message : "El agente reporto un error.",
          },
        });
      }

      case "todo.updated":
        return this.#todos(props);

      case "file.edited": {
        const path = props["file"];
        if (typeof path === "string") this.emit({ type: "agent.file_edited", payload: { path } });
        return;
      }

      // `message.part.delta` existe en runtime pero no en la union del SDK.
      case "message.part.delta":
      case "message.part.updated":
        return this.#parte(props);

      default:
        // Todo lo demas se ignora en silencio a proposito.
        return;
    }
  }

  /** Vacia el buffer de texto pendiente. Se llama al terminar la sesion. */
  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#buffer.length === 0) return;
    const texto = this.#buffer;
    this.#buffer = "";
    this.emit({ type: "agent.message", payload: { text: texto } });
  }

  #estado(props: Record<string, unknown>): void {
    const status = props["status"] as { type?: unknown; attempt?: unknown; message?: unknown; next?: unknown } | undefined;
    if (status?.type !== "retry") return;

    // El caso que importa: el proveedor esta limitando la tasa y el run parece
    // congelado. Media hora de silencio es indistinguible de un cuelgue.
    this.emit({
      type: "agent.retrying",
      payload: {
        attempt: typeof status.attempt === "number" ? status.attempt : 0,
        message: typeof status.message === "string" ? status.message : "Reintentando",
        nextAt: typeof status.next === "number" ? status.next : 0,
      },
    });
  }

  #todos(props: Record<string, unknown>): void {
    const todos = props["todos"];
    if (!Array.isArray(todos)) return;

    // Llega el array completo, no deltas: la vista se sincroniza sin reconstruir
    // estado y un replay duplicado no la corrompe.
    this.#pasos = todos.map((todo, indice) => {
      const item = (todo ?? {}) as { content?: unknown; status?: unknown };
      const titulo = typeof item.content === "string" ? item.content : `Paso ${indice + 1}`;
      return {
        seq: indice,
        key: claveDePaso(titulo) ?? `unknown-${indice}`,
        title: titulo,
        status: estadoDeTodo(item.status),
      };
    });

    this.emit({ type: "steps.updated", payload: { steps: this.#pasos } });
  }

  #parte(props: Record<string, unknown>): void {
    const part = props["part"] as { type?: unknown; text?: unknown; callID?: unknown; tool?: unknown; state?: unknown } | undefined;
    if (!part) return;

    if (part.type === "reasoning") return; // Ruido, y puede ser enorme.

    if (part.type === "text") {
      const delta = props["delta"];
      const texto = typeof delta === "string" ? delta : typeof part.text === "string" ? part.text : "";
      if (texto) this.#acumular(texto);
      return;
    }

    if (part.type === "tool") {
      const state = (part.state ?? {}) as { status?: unknown; title?: unknown };
      const nombre = typeof part.tool === "string" ? part.tool : "herramienta";
      this.emit({
        type: "agent.tool",
        payload: {
          callId: typeof part.callID === "string" ? part.callID : nombre,
          name: nombre,
          // `state.title` viene listo para mostrar ("Reading package.json"): no
          // hay que mantener un diccionario por herramienta.
          title: typeof state.title === "string" ? state.title : nombre,
          status: typeof state.status === "string" ? state.status : "running",
        },
      });
    }
  }

  #acumular(texto: string): void {
    this.#buffer += texto;
    if (this.#buffer.length >= MAX_CARACTERES) {
      this.flush();
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, THROTTLE_MS);
    this.#timer.unref?.();
  }
}

/**
 * Relaciona el texto de un todo con una de las siete fases.
 *
 * Por texto normalizado, no por posicion: el modelo escribe con tildes y a
 * veces reordena, que es exactamente lo que hacia fallar la validacion del
 * informe antes de canonicalizarlo en `normalize`.
 */
export function claveDePaso(texto: string): string | undefined {
  const objetivo = normalizar(texto);
  return STEP_KEYS.find((clave) => {
    const titulo = normalizar(STEP_TITLES[clave]);
    return objetivo === titulo || objetivo.includes(titulo) || titulo.includes(objetivo);
  });
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function estadoDeTodo(status: unknown): StepStatus {
  switch (status) {
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
      return "skipped";
    default:
      return "pending";
  }
}
