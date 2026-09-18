import { useEffect, useRef, useState } from "react";

export type StepStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export type StepView = {
  seq: number;
  key: string;
  title: string;
  status: StepStatus;
};

export type Herramienta = {
  callId: string;
  name: string;
  title: string;
  status: string;
};

export type Reintento = {
  attempt: number;
  message: string;
  nextAt: number;
};

export type ProgresoRun = {
  /** Pasos según los todos del agente. Vacío hasta el primer `steps.updated`. */
  steps: StepView[];
  /** Última herramienta en uso. Es lo que hace visible que el agente avanza. */
  herramienta: Herramienta | null;
  /** Últimos fragmentos de texto del agente, del más nuevo al más viejo. */
  mensajes: string[];
  archivos: string[];
  reintento: Reintento | null;
  /** Último estado que reportó el servidor. Manda sobre el de la lista, que
   *  puede haber quedado viejo desde que se cargó. */
  estado: string | null;
  conectado: boolean;
  /** El run terminó: hay que volver a pedir `GET /api/runs/:id`. */
  termino: boolean;
};

const VACIO: ProgresoRun = {
  steps: [],
  herramienta: null,
  mensajes: [],
  archivos: [],
  reintento: null,
  estado: null,
  conectado: false,
  termino: false,
};

/** Tope de mensajes en memoria: la vista muestra los últimos, no el log entero. */
const MAX_MENSAJES = 40;

/**
 * Progreso en vivo de un run por SSE.
 *
 * `EventSource` reconecta solo y manda `Last-Event-ID`, así que acá no hay
 * lógica de reintentos: el servidor responde con el replay de lo que falte.
 *
 * La vista **no** reconstruye el estado desde los eventos: primero hace
 * `GET /api/runs/:id`, que trae el estado completo, y recién después abre el
 * stream. Así nunca queda una pantalla vacía esperando el primer evento.
 */
export function useRunEvents(runId: string | null, activo: boolean): ProgresoRun {
  const [progreso, setProgreso] = useState<ProgresoRun>(VACIO);
  const fuente = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId || !activo) return;

    const es = new EventSource(`/api/runs/${runId}/events`, { withCredentials: true });
    fuente.current = es;

    const on = (tipo: string, manejar: (datos: Record<string, unknown>) => void) => {
      es.addEventListener(tipo, (evento) => {
        try {
          manejar(JSON.parse((evento as MessageEvent<string>).data) as Record<string, unknown>);
        } catch {
          // Un evento malformado no puede romper la vista.
        }
      });
    };

    es.addEventListener("open", () => setProgreso((p) => ({ ...p, conectado: true })));
    es.addEventListener("error", () => setProgreso((p) => ({ ...p, conectado: false })));

    on("run.status", (datos) => {
      const estado = typeof datos["status"] === "string" ? datos["status"] : null;
      if (estado) setProgreso((p) => ({ ...p, estado }));
    });

    on("steps.updated", (datos) => {
      const steps = Array.isArray(datos["steps"]) ? (datos["steps"] as StepView[]) : [];
      // Es idempotente y trae el array completo: un replay duplicado no corrompe.
      setProgreso((p) => ({ ...p, steps }));
    });

    on("agent.tool", (datos) => {
      setProgreso((p) => ({ ...p, herramienta: datos as unknown as Herramienta }));
    });

    on("agent.message", (datos) => {
      const texto = typeof datos["text"] === "string" ? datos["text"] : "";
      if (!texto.trim()) return;
      setProgreso((p) => ({ ...p, mensajes: [texto, ...p.mensajes].slice(0, MAX_MENSAJES) }));
    });

    on("agent.file_edited", (datos) => {
      const path = typeof datos["path"] === "string" ? datos["path"] : null;
      if (!path) return;
      setProgreso((p) => ({
        ...p,
        archivos: p.archivos.includes(path) ? p.archivos : [...p.archivos, path],
      }));
    });

    on("agent.retrying", (datos) => {
      setProgreso((p) => ({ ...p, reintento: datos as unknown as Reintento }));
    });

    const terminar = () => {
      setProgreso((p) => ({ ...p, termino: true, conectado: false }));
      // Si no se cierra, `EventSource` reconecta para siempre contra un run
      // que ya no va a emitir nada.
      es.close();
    };
    es.addEventListener("run.completed", terminar);
    es.addEventListener("run.failed", terminar);

    return () => {
      es.close();
      fuente.current = null;
    };
  }, [runId, activo]);

  // Al dejar de estar activo se limpia, para que el próximo run no herede nada.
  useEffect(() => {
    if (!activo) setProgreso(VACIO);
  }, [activo]);

  return progreso;
}
