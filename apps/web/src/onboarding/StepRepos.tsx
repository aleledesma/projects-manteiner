import { useEffect, useMemo, useState } from "react";

import { api, ApiError, type AvailableRepository } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { Chip } from "../components/Chip.tsx";
import { CheckIcon, GithubIcon, LockIcon, SearchIcon, Spinner } from "../components/icons.tsx";

/** Colores de lenguaje, apagados a propósito: identifican, no decoran. */
const COLORES: Record<string, string> = {
  TypeScript: "#6f8ec4",
  JavaScript: "#c4b06f",
  Python: "#6fa8c4",
  Rust: "#c48f6f",
  Go: "#6fc4bd",
  Java: "#c47f6f",
  "C#": "#8f6fc4",
  Ruby: "#c46f83",
  PHP: "#7f7fc4",
  Shell: "#7cb194",
  HTML: "#c4906f",
  CSS: "#6f9dc4",
};

type Props = {
  /** Se llama tras vincular al menos un repositorio. */
  onVinculados: () => void;
};

type Carga =
  | { estado: "cargando" }
  | { estado: "listo"; repos: AvailableRepository[] }
  | { estado: "error"; mensaje: string };

export function StepRepos({ onVinculados }: Props) {
  const [carga, setCarga] = useState<Carga>({ estado: "cargando" });
  const [filtro, setFiltro] = useState("");
  const [elegidos, setElegidos] = useState<Set<number>>(new Set());
  const [vinculando, setVinculando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    api
      .get<AvailableRepository[]>("/api/github/available-repos")
      .then((repos) => vivo && setCarga({ estado: "listo", repos }))
      .catch((cause: unknown) => {
        if (!vivo) return;
        setCarga({
          estado: "error",
          mensaje:
            cause instanceof ApiError ? cause.message : "No se pudieron leer tus repositorios.",
        });
      });
    return () => {
      vivo = false;
    };
  }, []);

  const repos = carga.estado === "listo" ? carga.repos : [];
  const filtrados = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, filtro]);

  // Todos los visibles ya elegidos: el botón pasa a quitar la selección.
  const todosVisibles = filtrados.length > 0 && filtrados.every((r) => elegidos.has(r.githubRepoId));

  function alternar(githubRepoId: number) {
    setElegidos((previos) => {
      const siguiente = new Set(previos);
      if (siguiente.has(githubRepoId)) siguiente.delete(githubRepoId);
      else siguiente.add(githubRepoId);
      return siguiente;
    });
  }

  /** Opera solo sobre lo filtrado: si hay búsqueda activa, "todos" son los visibles. */
  function alternarTodos() {
    setElegidos((previos) => {
      const siguiente = new Set(previos);
      for (const repo of filtrados) {
        if (todosVisibles) siguiente.delete(repo.githubRepoId);
        else siguiente.add(repo.githubRepoId);
      }
      return siguiente;
    });
  }

  async function vincular() {
    setVinculando(true);
    setError(null);
    const fallados: string[] = [];
    let vinculadosOk = 0;

    // La API vincula de a uno. Se hace secuencial: cada llamada sincroniza
    // contra GitHub y el backend serializa esa sincronización de todos modos.
    for (const repo of repos.filter((r) => elegidos.has(r.githubRepoId))) {
      try {
        await api.post(`/api/repos`, { githubRepoId: repo.githubRepoId });
        vinculadosOk += 1;
      } catch {
        fallados.push(repo.fullName);
      }
    }

    setVinculando(false);
    if (fallados.length > 0) {
      setError(
        `No se pudieron vincular ${fallados.length} de ${fallados.length + vinculadosOk}: ${fallados.join(", ")}.`,
      );
    }
    if (vinculadosOk > 0) onVinculados();
  }

  async function ajustarPermisos() {
    try {
      const { url } = await api.get<{ url: string }>("/api/github/install-url");
      window.location.href = url;
    } catch {
      setError("No se pudo abrir la configuración de la GitHub App.");
    }
  }

  if (carga.estado === "cargando") {
    return (
      <div className="flex items-center gap-2.5 py-2 text-[13px] text-ink-muted">
        <Spinner className="size-4" />
        Leyendo los repositorios que la App puede ver…
      </div>
    );
  }

  if (carga.estado === "error") {
    return <Alert>{carga.mensaje}</Alert>;
  }

  if (repos.length === 0) {
    return (
      <div className="rounded-[13px] border border-white/6 bg-surface px-[18px] py-8 text-center">
        <p className="text-[13.5px] font-medium">No hay repositorios disponibles</p>
        <p className="mx-auto mt-1.5 max-w-[44ch] text-[13px] text-ink-muted">
          O ya los vinculaste todos, o la GitHub App todavía no tiene acceso a ninguno.
        </p>
        <Button
          className="mt-4"
          icon={<GithubIcon className="size-4" />}
          onClick={() => void ajustarPermisos()}
        >
          Ajustar permisos en GitHub
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2">
        <label className="flex h-[34px] flex-1 items-center gap-2 rounded-[10px] border border-white/6 bg-sunken px-3">
          <SearchIcon className="size-3.5 shrink-0 text-ink-faint" />
          <input
            type="search"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Filtrar por nombre"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-faint"
          />
        </label>
        <span className="shrink-0 font-mono text-[11.5px] text-ink-faint">
          {filtrados.length}/{repos.length}
        </span>
        <Button size="sm" className="shrink-0" disabled={filtrados.length === 0} onClick={alternarTodos}>
          {todosVisibles ? "Quitar selección" : filtro.trim() ? "Seleccionar visibles" : "Seleccionar todos"}
        </Button>
      </div>

      <div className="max-h-[340px] overflow-y-auto rounded-xl border border-white/6 bg-surface">
        {filtrados.map((repo) => {
          const on = elegidos.has(repo.githubRepoId);
          return (
            <button
              key={repo.githubRepoId}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => alternar(repo.githubRepoId)}
              className={`flex w-full items-center gap-3 border-b border-white/4 px-3.5 py-2.5 text-left transition-colors duration-150 last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                on ? "bg-accent/8" : "hover:bg-raised"
              }`}
            >
              <span
                className={`grid size-[15px] shrink-0 place-items-center rounded-[5px] border ${
                  on ? "border-accent bg-accent" : "border-white/18"
                }`}
              >
                {on ? <CheckIcon className="size-2.5 text-canvas" /> : null}
              </span>

              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                <span className="text-ink-faint">{repo.owner}/</span>
                <span className="text-ink">{repo.name}</span>
              </span>

              {repo.private ? (
                <LockIcon className="size-3.5 shrink-0 text-ink-faint" aria-label="Privado" />
              ) : null}

              {repo.primaryLanguage ? (
                <Chip className="max-sm:hidden">
                  <span
                    className="size-[5px] rounded-full"
                    style={{ backgroundColor: COLORES[repo.primaryLanguage] ?? "#78818f" }}
                  />
                  {repo.primaryLanguage}
                </Chip>
              ) : null}

              <span className="w-[74px] shrink-0 truncate text-right font-mono text-[11.5px] text-ink-faint max-sm:hidden">
                {repo.defaultBranch}
              </span>
            </button>
          );
        })}
        {filtrados.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-[13px] text-ink-faint">
            Ningún repositorio coincide con “{filtro}”.
          </p>
        ) : null}
      </div>

      <p className="mt-2.5 text-xs text-ink-faint">
        Podés vincular más repositorios después, sin rehacer el onboarding.
      </p>

      {error ? <Alert className="mt-3">{error}</Alert> : null}

      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="primary"
          disabled={elegidos.size === 0}
          loading={vinculando}
          onClick={() => void vincular()}
        >
          {vinculando ? "Vinculando…" : "Vincular"}
        </Button>
        <span className="text-[13px] text-ink-muted">
          {elegidos.size === 0
            ? "Ninguno seleccionado"
            : `${elegidos.size} ${elegidos.size === 1 ? "repositorio seleccionado" : "repositorios seleccionados"}`}
        </span>
      </div>
    </div>
  );
}
