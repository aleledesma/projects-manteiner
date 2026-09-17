import { useEffect, useState } from "react";

import { api, ApiError, type RunStatus } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Chip } from "../components/Chip.tsx";
import { Modal } from "../components/Modal.tsx";
import { Spinner } from "../components/icons.tsx";
import { bandaDeSalud } from "../salud.ts";
import { relativo } from "../tiempo.ts";

type RunResumen = {
  id: string;
  status: RunStatus;
  healthScore: number | null;
  findingsCount: number;
  headline: string | null;
  errorCode: string | null;
  queuedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
};

type Props = {
  repositoryId: string;
  fullName: string;
  onCerrar: () => void;
  onVerInforme: (runId: string) => void;
};

/**
 * Histórico de un repositorio. Muestra la evolución del score, que es la lectura
 * que justifica auditar de nuevo: un número suelto no dice si algo mejoró.
 */
export function HistorialRepo({ repositoryId, fullName, onCerrar, onVerInforme }: Props) {
  const [runs, setRuns] = useState<RunResumen[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    api
      .get<RunResumen[]>(`/api/repos/${repositoryId}/runs`)
      .then((lista) => vivo && setRuns(lista))
      .catch((cause: unknown) => {
        if (vivo) setError(cause instanceof ApiError ? cause.message : "No se pudo leer el histórico.");
      });
    return () => {
      vivo = false;
    };
  }, [repositoryId]);

  const conScore = (runs ?? []).filter((run) => run.healthScore !== null);

  return (
    <Modal titulo="Histórico de auditorías" descripcion={fullName} ancho="lg" onCerrar={onCerrar}>
      {error ? <Alert>{error}</Alert> : null}

      {runs === null && !error ? (
        <div className="flex items-center gap-2.5 py-2 text-[13px] text-ink-muted">
          <Spinner className="size-4" />
          Cargando…
        </div>
      ) : null}

      {runs !== null && runs.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-faint">
          Este repositorio todavía no tiene auditorías.
        </p>
      ) : null}

      {conScore.length > 1 ? <Evolucion runs={conScore} /> : null}

      <div className="flex flex-col gap-2">
        {(runs ?? []).map((run) => (
          <Fila key={run.id} run={run} onVer={() => onVerInforme(run.id)} />
        ))}
      </div>
    </Modal>
  );
}

/** Sparkline del health score, del más viejo al más nuevo. */
function Evolucion({ runs }: { runs: RunResumen[] }) {
  const puntos = [...runs].reverse();
  const ancho = 100;
  const alto = 32;
  const paso = puntos.length > 1 ? ancho / (puntos.length - 1) : 0;
  const camino = puntos
    .map((run, i) => `${i === 0 ? "M" : "L"} ${(i * paso).toFixed(1)} ${(alto - (run.healthScore! / 100) * alto).toFixed(1)}`)
    .join(" ");
  const ultimo = puntos[puntos.length - 1]!;
  const primero = puntos[0]!;
  const delta = ultimo.healthScore! - primero.healthScore!;

  return (
    <div className="mb-4 flex items-center gap-4 rounded-xl border border-white/6 bg-surface px-4 py-3.5">
      <svg width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} className="shrink-0 overflow-visible">
        <path d={camino} fill="none" stroke={bandaDeSalud(ultimo.healthScore!).color} strokeWidth={1.5} />
      </svg>
      <div className="min-w-0">
        <p className="text-[13px] text-ink-muted">
          {delta === 0
            ? "El score se mantuvo"
            : `El score ${delta > 0 ? "subió" : "bajó"} ${Math.abs(delta)} puntos`}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          Sobre {puntos.length} auditorías completadas
        </p>
      </div>
    </div>
  );
}

function Fila({ run, onVer }: { run: RunResumen; onVer: () => void }) {
  const ok = run.status === "succeeded" && run.healthScore !== null;
  const banda = ok ? bandaDeSalud(run.healthScore!) : null;

  return (
    <button
      type="button"
      disabled={!ok}
      onClick={onVer}
      className={`flex items-center gap-3 rounded-xl border border-white/6 bg-surface px-3.5 py-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        ok ? "hover:border-white/12 hover:bg-raised" : "cursor-default"
      }`}
    >
      <span
        className="grid size-9 shrink-0 place-items-center rounded-lg border text-[13px] font-semibold tabular-nums"
        style={
          banda
            ? { color: banda.color, borderColor: `${banda.color}33`, backgroundColor: `${banda.color}14` }
            : { borderColor: "rgb(255 255 255 / 0.08)" }
        }
      >
        {ok ? run.healthScore : "—"}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">
          {run.headline ?? (run.status === "timed_out" ? "Excedió el tiempo límite" : "La auditoría falló")}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint">
          <span>{relativo(run.finishedAt ?? run.queuedAt)}</span>
          {run.durationMs ? (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono">{Math.round(run.durationMs / 1_000)}s</span>
            </>
          ) : null}
          {ok ? (
            <>
              <span className="opacity-40">·</span>
              <span>
                {run.findingsCount} {run.findingsCount === 1 ? "hallazgo" : "hallazgos"}
              </span>
            </>
          ) : run.errorCode ? (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono">{run.errorCode}</span>
            </>
          ) : null}
        </span>
      </span>

      {!ok ? <Chip>{run.status}</Chip> : null}
    </button>
  );
}
