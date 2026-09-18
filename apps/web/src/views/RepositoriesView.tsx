import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError, type LinkedRepository } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { Modal } from "../components/Modal.tsx";
import { GithubIcon, Spinner } from "../components/icons.tsx";
import { StepRepos } from "../onboarding/StepRepos.tsx";
import { HistorialRepo } from "../repos/HistorialRepo.tsx";
import { RepoCard } from "../repos/RepoCard.tsx";
import { COLOR_SEVERIDAD } from "../salud.ts";

const EN_CURSO = new Set(["preparing", "cloning", "running"]);

type Filtro = "todos" | "en-curso" | "altos" | "nunca";

const FILTROS: { id: Filtro; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "en-curso", label: "En curso" },
  { id: "altos", label: "Con hallazgos altos" },
  { id: "nunca", label: "Nunca auditados" },
];

type Props = {
  onVerInforme: (runId: string) => void;
  recargarMe: () => void;
};

export function RepositoriesView({ onVerInforme, recargarMe }: Props) {
  const [repos, setRepos] = useState<LinkedRepository[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [vinculando, setVinculando] = useState(false);
  const [historial, setHistorial] = useState<LinkedRepository | null>(null);
  const [lanzando, setLanzando] = useState<Set<string>>(new Set());
  const montado = useRef(true);

  const cargar = useCallback(async () => {
    try {
      const listado = await api.get<LinkedRepository[]>("/api/repos");
      if (montado.current) setRepos(listado);
    } catch (cause) {
      if (montado.current) {
        setError(cause instanceof ApiError ? cause.message : "No se pudieron leer tus repositorios.");
        setRepos((previos) => previos ?? []);
      }
    }
  }, []);

  useEffect(() => {
    montado.current = true;
    void cargar();
    return () => {
      montado.current = false;
    };
  }, [cargar]);

  async function auditar(repoId: string) {
    setLanzando((previos) => new Set(previos).add(repoId));
    setError(null);
    try {
      await api.post<{ id: string }>(`/api/repos/${repoId}/runs`);
      await cargar();
    } catch (cause) {
      setError(traducirFallo(cause));
    } finally {
      setLanzando((previos) => {
        const siguiente = new Set(previos);
        siguiente.delete(repoId);
        return siguiente;
      });
    }
  }

  const visibles = useMemo(() => {
    const lista = repos ?? [];
    if (filtro === "en-curso") {
      return lista.filter((repo) => repo.lastRun && EN_CURSO.has(repo.lastRun.status));
    }
    if (filtro === "altos") return lista.filter((repo) => (repo.lastRun?.severities.high ?? 0) > 0);
    if (filtro === "nunca") return lista.filter((repo) => repo.lastRun === null);
    return lista;
  }, [repos, filtro]);

  if (repos === null) {
    return (
      <div className="flex items-center gap-2.5 px-6 py-8 text-[13px] text-ink-faint sm:px-8">
        <Spinner className="size-4" />
        Cargando repositorios…
      </div>
    );
  }

  const auditados = repos.filter((repo) => repo.lastRun?.status === "succeeded");
  const activos = repos.filter((repo) => repo.lastRun && EN_CURSO.has(repo.lastRun.status)).length;

  return (
    <div className="px-6 py-8 sm:px-8">
      <header className="mb-[22px] flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-[-0.018em]">Repositorios</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {repos.length} {repos.length === 1 ? "vinculado" : "vinculados"}
            {activos > 0 ? ` · ${activos} ${activos === 1 ? "auditoría" : "auditorías"} en curso` : ""}
          </p>
        </div>
        <Button icon={<GithubIcon className="size-4" />} onClick={() => setVinculando(true)}>
          Vincular repositorio
        </Button>
      </header>

      {repos.length > 0 ? <Metricas repos={repos} auditados={auditados} /> : null}

      {error ? <Alert className="mb-4">{error}</Alert> : null}

      {repos.length === 0 ? (
        <SinRepositorios onVincular={() => setVinculando(true)} />
      ) : (
        <>
          <div className="mb-3.5 flex flex-wrap items-center gap-2">
            <div className="flex gap-0.5 rounded-[10px] border border-white/6 bg-surface p-0.5">
              {FILTROS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFiltro(id)}
                  className={`h-[28px] rounded-lg px-3 text-[12.5px] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                    filtro === id ? "bg-white/6 font-medium text-ink" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="ml-auto font-mono text-[11.5px] text-ink-faint">
              {visibles.length}/{repos.length}
            </span>
          </div>

          <div className="flex flex-col gap-3">
            {visibles.map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                auditando={lanzando.has(repo.id)}
                onAuditar={() => void auditar(repo.id)}
                onVerInforme={onVerInforme}
                onVerHistorial={() => setHistorial(repo)}
                onRecargar={() => void cargar()}
              />
            ))}
            {visibles.length === 0 ? (
              <p className="rounded-xl border border-white/6 bg-surface px-4 py-8 text-center text-[13px] text-ink-faint">
                Ningún repositorio entra en este filtro.
              </p>
            ) : null}
          </div>
        </>
      )}

      {historial ? (
        <HistorialRepo
          repositoryId={historial.id}
          fullName={historial.fullName}
          onCerrar={() => setHistorial(null)}
          onVerInforme={(runId) => {
            setHistorial(null);
            onVerInforme(runId);
          }}
        />
      ) : null}

      {vinculando ? (
        <Modal
          titulo="Vincular repositorios"
          descripcion="De los que la GitHub App puede ver, elegí cuáles querés auditar."
          ancho="lg"
          onCerrar={() => setVinculando(false)}
        >
          <StepRepos
            onVinculados={() => {
              setVinculando(false);
              recargarMe();
              void cargar();
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function Metricas({
  repos,
  auditados,
}: {
  repos: LinkedRepository[];
  auditados: LinkedRepository[];
}) {
  const severidades = { high: 0, medium: 0, low: 0, info: 0 };
  for (const repo of auditados) {
    for (const clave of Object.keys(severidades) as (keyof typeof severidades)[]) {
      severidades[clave] += repo.lastRun?.severities[clave] ?? 0;
    }
  }
  const totalHallazgos = Object.values(severidades).reduce((a, b) => a + b, 0);
  const promedio =
    auditados.length === 0
      ? null
      : Math.round(
          auditados.reduce((suma, repo) => suma + (repo.lastRun?.healthScore ?? 0), 0) /
            auditados.length,
        );

  return (
    <div className="mb-[26px] grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metrica titulo="Repositorios" valor={repos.length}>
        {auditados.length} auditado{auditados.length === 1 ? "" : "s"} al menos una vez
      </Metrica>
      <Metrica titulo="Auditorías completadas" valor={auditados.length}>
        {repos.length - auditados.length} sin informe todavía
      </Metrica>
      <Metrica titulo="Hallazgos abiertos" valor={totalHallazgos}>
        {totalHallazgos > 0 ? (
          <span className="mt-2 flex h-1 overflow-hidden rounded-full">
            {(Object.keys(severidades) as (keyof typeof severidades)[])
              .filter((clave) => severidades[clave] > 0)
              .map((clave) => (
                <span
                  key={clave}
                  style={{ flex: severidades[clave], backgroundColor: COLOR_SEVERIDAD[clave] }}
                />
              ))}
          </span>
        ) : (
          "Nada pendiente"
        )}
      </Metrica>
      <Metrica titulo="Salud promedio" valor={promedio ?? "—"}>
        {promedio === null ? "Auditá un repositorio para verla" : `Sobre ${auditados.length} auditados`}
      </Metrica>
    </div>
  );
}

function Metrica({
  titulo,
  valor,
  children,
}: {
  titulo: string;
  valor: number | string;
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

function SinRepositorios({ onVincular }: { onVincular: () => void }) {
  return (
    <div className="rounded-[13px] border border-white/6 bg-surface px-[18px] py-10 text-center">
      <p className="text-[13.5px] font-medium">Todavía no vinculaste ningún repositorio</p>
      <p className="mx-auto mt-1.5 max-w-[48ch] text-[13px] text-ink-muted">
        Elegí cuáles querés auditar de los que la GitHub App puede ver. Podés cambiarlo cuando
        quieras.
      </p>
      <Button variant="primary" className="mt-4" onClick={onVincular}>
        Vincular repositorio
      </Button>
    </div>
  );
}

function traducirFallo(cause: unknown): string {
  if (!(cause instanceof ApiError)) return "No se pudo lanzar la auditoría.";
  if (cause.code === "PROVIDER_NOT_CONFIGURED")
    return "Elegí un modelo por defecto en Configuración antes de auditar.";
  if (cause.code === "IMAGE_MISSING")
    return "Faltan las imágenes Docker en el servidor (npm run docker:build:git y :agent).";
  if (cause.code === "DOCKER_UNAVAILABLE")
    return "El servidor no puede hablar con Docker, así que no puede correr auditorías.";
  if (cause.code === "WORKSPACE_TOO_LARGE")
    return "El repositorio supera el tamaño máximo configurado.";
  return cause.message;
}
