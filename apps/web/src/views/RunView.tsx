import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type Report, type Run } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { Chip } from "../components/Chip.tsx";
import { HealthRing } from "../components/HealthRing.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ArrowRightIcon, ExternalIcon, InfoIcon, Spinner } from "../components/icons.tsx";
import { Hallazgo } from "../runs/Hallazgo.tsx";
import { COLOR_SEVERIDAD, NOMBRE_SEVERIDAD, bandaDeSalud } from "../salud.ts";

const EN_CURSO = new Set(["preparing", "cloning", "running"]);
const POLL_MS = 3_000;

const PESO_SEVERIDAD: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
const ORDEN_CATEGORIA: Record<string, string> = {
  runtime: "Runtime", language: "Lenguaje", framework: "Framework",
  "package-manager": "Gestor de paquetes", "build-tool": "Build", ci: "CI / CD",
  infra: "Infraestructura", database: "Base de datos", testing: "Testing",
};

type Pestana = "resumen" | "hallazgos" | "traza" | "limitaciones";

export function RunView({ runId, onVolver }: { runId: string; onVolver: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pestana, setPestana] = useState<Pestana>("resumen");

  const cargar = useCallback(async () => {
    try {
      setRun(await api.get<Run>(`/api/runs/${runId}`));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "No se pudo leer el run.");
    }
  }, [runId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Mientras el run vive, se repregunta. Con la Fase 6 esto pasa a ser un SSE.
  useEffect(() => {
    if (!run || !EN_CURSO.has(run.status)) return;
    const id = setInterval(() => void cargar(), POLL_MS);
    return () => clearInterval(id);
  }, [run, cargar]);

  if (error) {
    return (
      <div className="px-6 py-8 sm:px-8">
        <Button variant="ghost" size="sm" className="mb-4 -ml-2.5" onClick={onVolver}>
          ← Repositorios
        </Button>
        <Alert>{error}</Alert>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex items-center gap-2.5 px-6 py-8 text-[13px] text-ink-faint sm:px-8">
        <Spinner className="size-4" />
        Cargando informe…
      </div>
    );
  }

  const report = run.result?.report ?? null;

  return (
    <div className="mx-auto max-w-[900px] px-6 py-8 sm:px-8">
      <Button variant="ghost" size="sm" className="mb-4 -ml-2.5" onClick={onVolver}>
        ← Repositorios
      </Button>

      <Encabezado run={run} report={report} />

      {EN_CURSO.has(run.status) ? <EnCurso /> : null}
      {run.status === "failed" || run.status === "timed_out" ? <Fallo run={run} /> : null}

      {report ? (
        <>
          <div className="mt-[26px] flex gap-1 border-b border-white/6">
            {([
              ["resumen", "Resumen", null],
              ["hallazgos", "Hallazgos", report.findings.length],
              ["traza", "Traza", report.steps.length],
              ["limitaciones", "Limitaciones", report.limitations.length],
            ] as const).map(([id, label, cuenta]) => (
              <button
                key={id}
                type="button"
                onClick={() => setPestana(id)}
                className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-[13.5px] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                  pestana === id
                    ? "border-accent font-medium text-ink"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {label}
                {cuenta !== null ? (
                  <span className="rounded-md bg-white/6 px-1.5 font-mono text-[11px] text-ink-faint">
                    {cuenta}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="pt-6">
            {pestana === "resumen" ? <Resumen report={report} /> : null}
            {pestana === "hallazgos" ? <Hallazgos report={report} /> : null}
            {pestana === "traza" ? <Traza report={report} /> : null}
            {pestana === "limitaciones" ? <Limitaciones report={report} /> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Encabezado({ run, report }: { run: Run; report: Report | null }) {
  return (
    <header className="flex flex-wrap items-start gap-5">
      {run.healthScore !== null ? <HealthRing score={run.healthScore} size={72} conEtiqueta /> : null}
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[12.5px] text-ink-faint">{run.repositoryFullName}</p>
        <h1 className="mt-1.5 text-[22px]/[30px] font-semibold tracking-[-0.018em]">
          {run.headline ?? (report ? report.summary.headline : "Auditoría en curso")}
        </h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-faint">
          <Estado run={run} />
          {run.finishedAt ? <span>{new Date(run.finishedAt).toLocaleString("es-AR")}</span> : null}
          {run.durationMs ? (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono">{duracion(run.durationMs)}</span>
            </>
          ) : null}
          <span className="opacity-40">·</span>
          <span className="font-mono">{run.providerId}/{run.modelId}</span>
          {run.commitSha ? (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono">
                {run.baseBranch}@{run.commitSha.slice(0, 7)}
              </span>
            </>
          ) : null}
          <span className="opacity-40">·</span>
          <span className="font-mono">{run.agentVersion}</span>
        </div>
      </div>
    </header>
  );
}

function Estado({ run }: { run: Run }) {
  if (run.status === "succeeded") {
    return (
      <Chip tone="ok">
        <span className="size-1.5 rounded-full bg-ok" />
        Completada
      </Chip>
    );
  }
  if (EN_CURSO.has(run.status)) {
    return (
      <Chip tone="accent">
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
        En curso
      </Chip>
    );
  }
  return <Chip>{run.status === "timed_out" ? "Excedió el tiempo" : "Falló"}</Chip>;
}

function EnCurso() {
  return (
    <div className="mt-6 flex items-center gap-3 rounded-xl border border-accent/26 bg-accent/5 px-4 py-3.5">
      <Spinner className="size-4 shrink-0 text-accent" />
      <p className="text-[13px] text-accent-text">
        La auditoría está corriendo. Esta pantalla se actualiza sola; el detalle paso a paso llega
        con el streaming de la Fase 6.
      </p>
    </div>
  );
}

/**
 * Detalle del fallo. Se muestra entero a proposito: es la auditoria del propio
 * usuario y sin el error real no hay forma de saber que hacer.
 */
function Fallo({ run }: { run: Run }) {
  const detalle = parsearDetalle(run.errorDetail);

  return (
    <div className="mt-6 rounded-xl border border-sev-high/22 bg-sev-high/5 px-4 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[12.5px] text-[#dda0a5]">{run.errorCode}</span>
        {run.errorMessage ? (
          <span className="text-[13px]/[20px] text-ink-muted">{run.errorMessage}</span>
        ) : null}
      </div>

      {detalle?.issues && detalle.issues.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5 border-t border-white/6 pt-3">
          {detalle.issues.map((issue, i) => (
            <li key={i} className="flex flex-wrap gap-x-2 text-[12.5px]/[18px]">
              <span className="font-mono text-ink-faint">{issue.path}</span>
              <span className="text-ink-muted">{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {detalle?.recibido ? (
        <details className="mt-3 border-t border-white/6 pt-3">
          <summary className="cursor-pointer text-[12.5px] text-ink-faint transition-colors hover:text-ink-muted">
            Lo que devolvió el modelo
          </summary>
          <pre className="mt-2.5 max-h-[280px] overflow-auto rounded-[10px] border border-white/6 bg-sunken px-3 py-2.5 font-mono text-[11.5px]/[17px] whitespace-pre-wrap text-ink-muted">
            {detalle.recibido}
          </pre>
        </details>
      ) : null}

      {detalle?.logs && detalle.logs.length > 0 ? (
        <details className="mt-3 border-t border-white/6 pt-3">
          <summary className="cursor-pointer text-[12.5px] text-ink-faint transition-colors hover:text-ink-muted">
            Últimas líneas del contenedor ({detalle.logs.length})
          </summary>
          <pre className="mt-2.5 max-h-[280px] overflow-auto rounded-[10px] border border-white/6 bg-sunken px-3 py-2.5 font-mono text-[11.5px]/[17px] whitespace-pre-wrap text-ink-muted">
            {detalle.logs.join(String.fromCharCode(10))}
          </pre>
        </details>
      ) : null}

      {detalle?.otros ? (
        <details className="mt-3 border-t border-white/6 pt-3">
          <summary className="cursor-pointer text-[12.5px] text-ink-faint transition-colors hover:text-ink-muted">
            Detalle
          </summary>
          <pre className="mt-2.5 max-h-[280px] overflow-auto rounded-[10px] border border-white/6 bg-sunken px-3 py-2.5 font-mono text-[11.5px]/[17px] whitespace-pre-wrap text-ink-muted">
            {detalle.otros}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

type Detalle = {
  logs?: string[];
  issues?: { path: string; message: string }[];
  recibido?: string;
  otros?: string;
};

function parsearDetalle(crudo: string | null): Detalle | null {
  if (!crudo) return null;
  try {
    const valor = JSON.parse(crudo) as unknown;
    // Los `details` de un AppError pueden ser un array (las issues sueltas) o
    // un objeto con claves conocidas: los dos tienen que leerse igual de bien.
    if (Array.isArray(valor)) return { issues: valor as Detalle["issues"] };

    const objeto = valor as Record<string, unknown>;
    const resto = { ...objeto };
    for (const clave of ["logs", "issues", "recibido"]) delete resto[clave];

    return {
      logs: Array.isArray(objeto["logs"]) ? (objeto["logs"] as string[]) : undefined,
      issues: Array.isArray(objeto["issues"]) ? (objeto["issues"] as Detalle["issues"]) : undefined,
      recibido: typeof objeto["recibido"] === "string" ? objeto["recibido"] : undefined,
      otros: Object.keys(resto).length > 0 ? JSON.stringify(resto, null, 2) : undefined,
    };
  } catch {
    return { otros: crudo };
  }
}

function Resumen({ report }: { report: Report }) {
  const { applied, deferred, unmaintained } = report.dependency_updates;
  const porSeveridad = report.findings.reduce<Record<string, number>>((acumulado, finding) => {
    acumulado[finding.severity] = (acumulado[finding.severity] ?? 0) + 1;
    return acumulado;
  }, {});

  const porCategoria = report.stack_detected.reduce<Record<string, Report["stack_detected"]>>(
    (acumulado, item) => {
      (acumulado[item.category] ??= []).push(item);
      return acumulado;
    },
    {},
  );

  return (
    <div className="flex flex-col gap-9">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile titulo="Hallazgos" valor={report.findings.length}>
          {report.findings.length > 0 ? (
            <>
              <span className="mt-2 flex h-1 overflow-hidden rounded-full">
                {Object.entries(porSeveridad).map(([severidad, total]) => (
                  <span
                    key={severidad}
                    style={{ flex: total, backgroundColor: COLOR_SEVERIDAD[severidad] }}
                  />
                ))}
              </span>
              <span className="mt-2 block">
                {Object.entries(porSeveridad)
                  .sort(([a], [b]) => (PESO_SEVERIDAD[a] ?? 9) - (PESO_SEVERIDAD[b] ?? 9))
                  .map(([severidad, total]) => `${total} ${NOMBRE_SEVERIDAD[severidad]?.toLowerCase()}`)
                  .join(" · ")}
              </span>
            </>
          ) : (
            "Nada que atender"
          )}
        </Tile>
        <Tile titulo="Dependencias actualizadas" valor={applied.length}>
          {applied.length === 0
            ? "No se aplicó ningún cambio"
            : `${applied.filter((u) => u.bump === "patch").length} patch · ${applied.filter((u) => u.bump === "minor").length} minor`}
        </Tile>
        <Tile titulo="Diferidas" valor={deferred.length}>
          {deferred.length === 0 ? "Nada quedó pendiente" : "Requieren revisión manual"}
        </Tile>
        <Tile titulo="Sin mantenimiento" valor={unmaintained.length}>
          {unmaintained.length === 0 ? "Todas activas" : "Convendría reemplazarlas"}
        </Tile>
      </div>

      <section>
        <h2 className="mb-3 text-[17px] font-semibold tracking-[-0.016em]">Opinión general</h2>
        <Markdown texto={report.summary.overview} />
      </section>

      {report.stack_detected.length > 0 ? (
        <section>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-[17px] font-semibold tracking-[-0.016em]">Stack detectado</h2>
            <span className="text-[12px] text-ink-faint">
              {report.stack_detected.length} componentes
            </span>
          </div>
          <div className="grid gap-4 rounded-xl border border-white/6 bg-surface px-4 py-4 sm:grid-cols-2">
            {Object.entries(porCategoria).map(([categoria, items]) => (
              <div key={categoria}>
                <p className="mb-2 text-[11px] font-medium tracking-[0.06em] text-ink-faint uppercase">
                  {ORDEN_CATEGORIA[categoria] ?? categoria}
                </p>
                <div className="flex flex-wrap gap-2">
                  {items.map((item) => (
                    <Chip key={`${item.name}-${item.version ?? ""}`}>
                      {item.name}
                      {item.version ? <span className="opacity-70"> {item.version}</span> : null}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Dependencias report={report} />

      {report.proposed_pull_request ? (
        <section>
          <h2 className="mb-3 text-[17px] font-semibold tracking-[-0.016em]">
            Pull Request propuesto
          </h2>
          <div className="rounded-xl border border-white/6 bg-surface px-4 py-4">
            <p className="text-[13.5px] font-medium">{report.proposed_pull_request.title}</p>
            <div className="mt-2.5">
              <Markdown texto={report.proposed_pull_request.body} />
            </div>
            <div className="mt-3.5 flex gap-2.5 border-t border-white/6 pt-3.5">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
              <p className="text-xs/[18px] text-ink-faint">
                Manteiner todavía no abre el PR: la publicación es la Fase 7. Por ahora el
                contenido queda acá para que lo revises.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {report.out_of_scope_notes.length > 0 ? (
        <section>
          <h2 className="mb-3 text-[17px] font-semibold tracking-[-0.016em]">Fuera de alcance</h2>
          <div className="flex flex-col gap-2.5">
            {report.out_of_scope_notes.map((nota, i) => (
              <div key={i} className="flex gap-3 rounded-xl border border-white/6 bg-surface px-4 py-3">
                <Chip>{nota.area}</Chip>
                <p className="text-[13px]/[20px] text-ink-muted">{nota.note}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Dependencias({ report }: { report: Report }) {
  const { applied, deferred, unmaintained } = report.dependency_updates;
  if (applied.length + deferred.length + unmaintained.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 text-[17px] font-semibold tracking-[-0.016em]">Dependencias</h2>
      <div className="flex flex-col gap-3">
        {applied.length > 0 ? (
          <Grupo titulo="Aplicadas" cuenta={applied.length} nota="Solo patch y minor sin breaking changes">
            {applied.map((u) => (
              <Linea key={u.name} nombre={u.name} detalle={`${u.from} → ${u.to}`} chip={u.bump}>
                {u.rationale}
              </Linea>
            ))}
          </Grupo>
        ) : null}
        {deferred.length > 0 ? (
          <Grupo titulo="Diferidas" cuenta={deferred.length} nota="Necesitan revisión manual">
            {deferred.map((u) => (
              <Linea key={u.name} nombre={u.name} detalle={`${u.from} → ${u.to}`} url={u.migration_url}>
                {u.reason}
              </Linea>
            ))}
          </Grupo>
        ) : null}
        {unmaintained.length > 0 ? (
          <Grupo titulo="Sin mantenimiento" cuenta={unmaintained.length}>
            {unmaintained.map((u) => (
              <Linea key={u.name} nombre={u.name}>
                {u.reason}
              </Linea>
            ))}
          </Grupo>
        ) : null}
      </div>
    </section>
  );
}

function Grupo({
  titulo,
  cuenta,
  nota,
  children,
}: {
  titulo: string;
  cuenta: number;
  nota?: string;
  children: React.ReactNode;
}) {
  const [abierto, setAbierto] = useState(true);
  return (
    <div className="overflow-hidden rounded-xl border border-white/6 bg-surface">
      <button
        type="button"
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span className="text-[13.5px] font-semibold">{titulo}</span>
        <Chip>{cuenta}</Chip>
        {nota ? <span className="ml-auto text-[12px] text-ink-faint max-sm:hidden">{nota}</span> : null}
      </button>
      {abierto ? <div className="border-t border-white/6">{children}</div> : null}
    </div>
  );
}

function Linea({
  nombre,
  detalle,
  chip,
  url,
  children,
}: {
  nombre: string;
  detalle?: string;
  chip?: string;
  url?: string | null;
  children?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-white/4 px-4 py-2.5 last:border-b-0">
      <span className="font-mono text-[12.5px] text-ink">{nombre}</span>
      {detalle ? <span className="font-mono text-[12px] text-ink-faint">{detalle}</span> : null}
      {chip ? <Chip>{chip}</Chip> : null}
      {children ? (
        <span className="w-full text-[12.5px]/[18px] text-ink-faint sm:w-auto sm:flex-1">
          {children}
        </span>
      ) : null}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink-faint transition-colors hover:text-ink"
        >
          Migración
          <ExternalIcon className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

function Hallazgos({ report }: { report: Report }) {
  const [severidad, setSeveridad] = useState<string>("todas");

  const ordenados = [...report.findings].sort(
    (a, b) => (PESO_SEVERIDAD[a.severity] ?? 9) - (PESO_SEVERIDAD[b.severity] ?? 9),
  );
  const visibles =
    severidad === "todas" ? ordenados : ordenados.filter((f) => f.severity === severidad);

  if (report.findings.length === 0) {
    return (
      <div className="rounded-xl border border-ok/26 bg-ok/6 px-4 py-8 text-center">
        <p className="text-[13.5px] font-medium text-ok">Sin hallazgos</p>
        <p className="mx-auto mt-1.5 max-w-[48ch] text-[13px] text-ink-muted">
          El agente no encontró nada que amerite atención en esta auditoría.
        </p>
      </div>
    );
  }

  const presentes = [...new Set(ordenados.map((f) => f.severity))];

  return (
    <div>
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        {["todas", ...presentes].map((clave) => (
          <button
            key={clave}
            type="button"
            onClick={() => setSeveridad(clave)}
            className={`h-[28px] rounded-lg border px-3 text-[12.5px] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
              severidad === clave
                ? "border-white/18 bg-raised text-ink"
                : "border-white/6 bg-surface text-ink-muted hover:text-ink"
            }`}
          >
            {clave === "todas" ? "Todas" : NOMBRE_SEVERIDAD[clave] ?? clave}
          </button>
        ))}
        <span className="ml-auto text-[12px] text-ink-faint">
          Ordenados por severidad
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {visibles.map((finding, indice) => (
          <Hallazgo key={finding.finding_key} finding={finding} abierto={indice === 0} />
        ))}
      </div>
    </div>
  );
}

function Traza({ report }: { report: Report }) {
  return (
    <div className="flex flex-col gap-2.5">
      {report.steps.map((step, indice) => {
        const color =
          step.status === "completed" ? "#7cb194" : step.status === "skipped" ? "#78818f" : "#cf7c83";
        return (
          <div key={step.key} className="rounded-xl border border-white/6 bg-surface px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <span
                className="grid size-[22px] shrink-0 place-items-center rounded-full border font-mono text-[11px]"
                style={{ color, borderColor: `${color}44`, backgroundColor: `${color}14` }}
              >
                {indice + 1}
              </span>
              <span className="text-[13.5px] font-semibold">{step.title}</span>
              <span className="ml-auto font-mono text-[11.5px]" style={{ color }}>
                {step.status}
              </span>
            </div>
            <div className="mt-2.5 pl-[32px]">
              <Markdown texto={step.skip_reason ?? step.description} />
              {step.evidence && step.evidence.length > 0 ? (
                <ul className="mt-2.5 flex flex-col gap-1">
                  {step.evidence.map((linea, i) => (
                    <li key={i} className="font-mono text-[11.5px] text-ink-faint">
                      {linea}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Limitaciones({ report }: { report: Report }) {
  if (report.limitations.length === 0) {
    return (
      <p className="rounded-xl border border-white/6 bg-surface px-4 py-8 text-center text-[13px] text-ink-faint">
        El agente no declaró limitaciones en esta auditoría.
      </p>
    );
  }
  return (
    <div>
      <p className="mb-3 max-w-[64ch] text-[13px] text-ink-muted">
        Lo que el agente no pudo analizar, y por qué. Vale leerlo antes de tomar el informe como
        completo.
      </p>
      <ul className="flex flex-col gap-2.5">
        {report.limitations.map((limitacion, i) => (
          <li
            key={i}
            className="flex gap-3 rounded-xl border border-white/6 bg-surface px-4 py-3 text-[13px]/[20px] text-ink-muted"
          >
            <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
            {limitacion}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tile({
  titulo,
  valor,
  children,
}: {
  titulo: string;
  valor: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/6 bg-surface px-4 py-3.5">
      <p className="text-[11px] font-medium tracking-[0.06em] text-ink-faint uppercase">{titulo}</p>
      <p className="mt-1.5 text-[26px] leading-none font-semibold tabular-nums">{valor}</p>
      <div className="mt-1.5 text-[12px] text-ink-faint">{children}</div>
    </div>
  );
}

function duracion(ms: number): string {
  const total = Math.round(ms / 1_000);
  const minutos = Math.floor(total / 60);
  return minutos > 0 ? `${minutos}m ${total % 60}s` : `${total}s`;
}
