import { useEffect, useState } from "react";

import type { LinkedRepository, Severity } from "../api.ts";
import { Button } from "../components/Button.tsx";
import { Chip } from "../components/Chip.tsx";
import { HealthRing } from "../components/HealthRing.tsx";
import { ExternalIcon, LockIcon, Spinner } from "../components/icons.tsx";
import { COLOR_SEVERIDAD, PLURAL_SEVERIDAD } from "../salud.ts";
import { relativo } from "../tiempo.ts";

/** Colores de lenguaje, apagados a proposito: identifican, no decoran. */
const COLORES: Record<string, string> = {
  TypeScript: "#6f8ec4", JavaScript: "#c4b06f", Python: "#6fa8c4", Rust: "#c48f6f",
  Go: "#6fc4bd", Java: "#c47f6f", "C#": "#8f6fc4", Ruby: "#c46f83", PHP: "#7f7fc4",
  Shell: "#7cb194", HTML: "#c4906f", CSS: "#6f9dc4",
};

const EN_CURSO = new Set(["preparing", "cloning", "running"]);

const PASO_DE_ESTADO: Record<string, string> = {
  preparing: "Preparando el workspace",
  cloning: "Clonando el repositorio",
  running: "El agente está auditando",
};

type Props = {
  repo: LinkedRepository;
  auditando: boolean;
  onAuditar: () => void;
  onVerInforme: (runId: string) => void;
  onVerHistorial: () => void;
};

export function RepoCard({ repo, auditando, onAuditar, onVerInforme, onVerHistorial }: Props) {
  const run = repo.lastRun;
  const activo = auditando || (run !== null && EN_CURSO.has(run.status));

  return (
    <article
      className={`overflow-hidden rounded-xl border bg-surface transition-colors duration-150 ${
        activo ? "border-accent/30" : "border-white/6 hover:border-white/12 hover:bg-raised"
      }`}
    >
      {activo ? <BarraIndeterminada /> : null}

      <div className="flex items-start gap-3 px-[15px] pt-3.5">
        <span className="grid size-[22px] shrink-0 place-items-center rounded-md border border-white/6 bg-raised text-[9.5px] font-semibold text-ink-faint">
          {repo.owner.slice(0, 2).toUpperCase()}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[13px]">
            <span className="text-ink-faint">{repo.owner}/</span>
            <span className="text-ink">{repo.name}</span>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint">
            {repo.primaryLanguage ? (
              <span className="flex items-center gap-1.5">
                <span
                  className="size-[5px] rounded-full"
                  style={{ backgroundColor: COLORES[repo.primaryLanguage] ?? "#78818f" }}
                />
                {repo.primaryLanguage}
              </span>
            ) : null}
            <span className="font-mono">{repo.defaultBranch}</span>
            {repo.private ? (
              <span className="flex items-center gap-1">
                <LockIcon className="size-3" />
                privado
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {activo ? (
            <Chip tone="accent">
              <span className="relative grid size-1.5 place-items-center">
                <span className="absolute size-1.5 animate-ping rounded-full bg-accent/60" />
                <span className="size-1.5 rounded-full bg-accent" />
              </span>
              En curso
            </Chip>
          ) : (
            <Button size="sm" onClick={onAuditar}>
              Auditar
            </Button>
          )}
          {run ? (
            <Button size="sm" variant="ghost" onClick={onVerHistorial}>
              Histórico
            </Button>
          ) : null}
          <a
            href={repo.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Abrir en GitHub"
            className="grid size-7 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <ExternalIcon className="size-3.5" />
          </a>
        </div>
      </div>

      <div className="px-[15px] py-4">
        {activo ? (
          <EnCurso desde={run?.queuedAt ?? Date.now()} estado={run?.status ?? "preparing"} />
        ) : run === null ? (
          <Vacio onAuditar={onAuditar} />
        ) : run.status === "succeeded" && run.healthScore !== null ? (
          <Informe run={run} onVer={() => onVerInforme(run.id)} />
        ) : (
          <Fallido run={run} onReintentar={onAuditar} />
        )}
      </div>

      {run?.status === "succeeded" ? <Pie run={run} /> : null}
    </article>
  );
}

function BarraIndeterminada() {
  return (
    <div className="h-0.5 overflow-hidden bg-white/5">
      <div className="h-full w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] bg-accent/70" />
    </div>
  );
}

/** Cronometro desde que el run se encolo. Sin SSE todavia: esto es lo honesto. */
function EnCurso({ desde, estado }: { desde: number; estado: string }) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const segundos = Math.max(0, Math.floor((ahora - desde) / 1_000));

  return (
    <div className="flex items-center gap-3">
      <Spinner className="size-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-accent-text">
          {PASO_DE_ESTADO[estado] ?? "Auditando"}
        </p>
        <p className="mt-0.5 text-[12.5px] text-ink-faint">
          El detalle paso a paso llega con el streaming.
        </p>
      </div>
      <span className="shrink-0 font-mono text-[13px] text-ink-muted tabular-nums">
        {String(Math.floor(segundos / 60)).padStart(2, "0")}:
        {String(segundos % 60).padStart(2, "0")}
      </span>
    </div>
  );
}

function Vacio({ onAuditar }: { onAuditar: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium">Todavía no lo auditaste</p>
        <p className="mt-0.5 max-w-[52ch] text-[12.5px] text-ink-faint">
          La primera auditoría inventaría las dependencias, revisa el runtime y propone lo que
          conviene actualizar.
        </p>
      </div>
      <Button size="sm" variant="primary" className="shrink-0" onClick={onAuditar}>
        Auditar ahora
      </Button>
    </div>
  );
}

function Informe({
  run,
  onVer,
}: {
  run: NonNullable<LinkedRepository["lastRun"]>;
  onVer: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onVer}
      className="flex w-full items-center gap-4 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
    >
      <HealthRing score={run.healthScore!} conEtiqueta />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[13.5px]/[20px] text-ink">{run.headline}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint">
          {run.finishedAt ? <span>{relativo(run.finishedAt)}</span> : null}
          <span className="opacity-40">·</span>
          <span className="font-mono">{run.modelId}</span>
        </div>
      </div>
    </button>
  );
}

function Fallido({
  run,
  onReintentar,
}: {
  run: NonNullable<LinkedRepository["lastRun"]>;
  onReintentar: () => void;
}) {
  const vencido = run.status === "timed_out";
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-[#dda0a5]">
          {vencido ? "La auditoría excedió el tiempo límite" : "La última auditoría falló"}
        </p>
        <p className="mt-0.5 font-mono text-[12px] text-ink-faint">
          {run.errorCode ?? "INTERNAL_ERROR"}
          {run.finishedAt ? <span className="font-sans"> · {relativo(run.finishedAt)}</span> : null}
        </p>
      </div>
      <Button size="sm" className="shrink-0" onClick={onReintentar}>
        Reintentar
      </Button>
    </div>
  );
}

function Pie({ run }: { run: NonNullable<LinkedRepository["lastRun"]> }) {
  const conteos = (Object.keys(PLURAL_SEVERIDAD) as Severity[])
    .map((severidad) => ({ severidad, total: run.severities[severidad] ?? 0 }))
    .filter(({ total }) => total > 0);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-white/6 px-[15px] py-2.5">
      <span className="text-[12px] text-ink-muted">
        {run.findingsCount} {run.findingsCount === 1 ? "hallazgo" : "hallazgos"}
      </span>
      {conteos.map(({ severidad, total }) => (
        <span key={severidad} className="flex items-center gap-1.5 text-[12px] text-ink-faint">
          <span
            className="size-[5px] rounded-full"
            style={{ backgroundColor: COLOR_SEVERIDAD[severidad] }}
          />
          {total} {PLURAL_SEVERIDAD[severidad]![total === 1 ? 0 : 1]}
        </span>
      ))}
      {run.findingsCount === 0 ? (
        <span className="ml-auto text-[12px] text-ink-faint">Sin hallazgos</span>
      ) : null}
    </div>
  );
}
