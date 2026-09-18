/**
 * Eventos de dominio de un run y su bus de fan-out.
 *
 * Dos garantias que sostienen la reconexion (doc 07):
 *
 * 1. **Todo se persiste antes de emitirse.** Si el proceso muere, el bus se
 *    pierde pero los eventos no: al reconectar, el replay desde SQLite
 *    reconstruye la vista entera.
 * 2. **`run_events.id` es un entero autoincremental**, o sea un cursor monotono
 *    global. Es lo que hace posible responder "todo lo posterior a X" cuando el
 *    navegador reconecta con `Last-Event-ID`.
 */

import type { DatabaseConnection } from "../db/client.ts";

export type StepStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export interface StepView {
  readonly seq: number;
  readonly key: string;
  readonly title: string;
  readonly status: StepStatus;
}

export type RunEvent =
  | { type: "run.status"; payload: { status: string; at: number } }
  | { type: "run.connected"; payload: { containerId: string } }
  | { type: "steps.updated"; payload: { steps: StepView[] } }
  | { type: "agent.message"; payload: { text: string } }
  | { type: "agent.tool"; payload: { callId: string; name: string; title: string; status: string } }
  | { type: "agent.retrying"; payload: { attempt: number; message: string; nextAt: number } }
  | { type: "agent.file_edited"; payload: { path: string } }
  | { type: "run.completed"; payload: { healthScore: number; findingsCount: number; headline: string } }
  | { type: "run.failed"; payload: { code: string; message: string } };

export interface StoredEvent {
  readonly id: number;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: number;
}

/** Tipos que siempre se persisten, incluso pasado el tope por run. */
const SIEMPRE = /^(run\.|steps\.)/;
/** Tope de eventos guardados por run: el resto se emite en vivo y no se guarda. */
const MAX_PERSISTIDOS = 5_000;
/** Tamano maximo del payload. Un SSE no es lugar para un JSON enorme. */
const MAX_PAYLOAD_BYTES = 8 * 1024;

type Suscriptor = (evento: StoredEvent) => void;

export class RunEventBus {
  readonly #subs = new Map<string, Set<Suscriptor>>();
  readonly #contados = new Map<string, number>();

  constructor(
    private readonly database: DatabaseConnection,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Persiste y emite. El orden importa: si se emitiera primero, un cliente
   * podria recibir un id que todavia no existe en la base y pedir un replay
   * que le devuelva menos de lo que ya vio.
   */
  publish(runId: string, event: RunEvent): StoredEvent {
    const payload = recortar(event.payload);
    const createdAt = this.now();
    const persistible = SIEMPRE.test(event.type) || this.#cuenta(runId) < MAX_PERSISTIDOS;

    let id = 0;
    if (persistible) {
      const resultado = this.database.sqlite
        .prepare("INSERT INTO run_events (run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, event.type, JSON.stringify(payload), createdAt);
      id = Number(resultado.lastInsertRowid);
      this.#contados.set(runId, this.#cuenta(runId) + 1);
    }

    const stored: StoredEvent = { id, type: event.type, payload, createdAt };
    for (const sub of this.#subs.get(runId) ?? []) {
      try {
        sub(stored);
      } catch {
        // Un suscriptor roto no puede frenar a los demas ni al run.
      }
    }
    return stored;
  }

  subscribe(runId: string, fn: Suscriptor): () => void {
    const actuales = this.#subs.get(runId) ?? new Set<Suscriptor>();
    actuales.add(fn);
    this.#subs.set(runId, actuales);

    return () => {
      const vivos = this.#subs.get(runId);
      if (!vivos) return;
      vivos.delete(fn);
      if (vivos.size === 0) this.#subs.delete(runId);
    };
  }

  /** Todo lo posterior a `desde`, para el replay de una reconexion. */
  replay(runId: string, desde: number): StoredEvent[] {
    return this.database.sqlite
      .prepare(
        `SELECT id, type, payload_json AS payload, created_at AS createdAt
         FROM run_events WHERE run_id = ? AND id > ? ORDER BY id`,
      )
      .all(runId, desde)
      .map((fila) => {
        const row = fila as { id: number; type: string; payload: string; createdAt: number };
        return {
          id: row.id,
          type: row.type,
          payload: parsear(row.payload),
          createdAt: row.createdAt,
        };
      });
  }

  /** Libera el contador de un run terminado. */
  forget(runId: string): void {
    this.#contados.delete(runId);
  }

  #cuenta(runId: string): number {
    const memoria = this.#contados.get(runId);
    if (memoria !== undefined) return memoria;
    // Tras un reinicio el contador arranca vacio: se recupera de la base.
    const fila = this.database.sqlite
      .prepare("SELECT count(*) AS total FROM run_events WHERE run_id = ?")
      .get(runId) as { total: number };
    this.#contados.set(runId, fila.total);
    return fila.total;
  }
}

/** Trunca el payload y lo marca, en vez de mandar algo enorme o romper. */
function recortar(payload: unknown): unknown {
  const serializado = JSON.stringify(payload) ?? "null";
  if (serializado.length <= MAX_PAYLOAD_BYTES) return payload;

  if (payload && typeof payload === "object" && "text" in payload) {
    const texto = String((payload as { text: unknown }).text);
    return { ...payload, text: `${texto.slice(0, MAX_PAYLOAD_BYTES - 64)}…`, truncated: true };
  }
  return { truncated: true, preview: serializado.slice(0, MAX_PAYLOAD_BYTES - 64) };
}

function parsear(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}
