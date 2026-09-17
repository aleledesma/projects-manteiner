import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type GithubInstallation } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { Chip } from "../components/Chip.tsx";
import { ExternalIcon, GithubIcon, InfoIcon, Spinner } from "../components/icons.tsx";
import { Seccion } from "./Seccion.tsx";

type Carga =
  | { estado: "cargando" }
  | { estado: "listo"; instalaciones: GithubInstallation[] }
  | { estado: "error"; mensaje: string };

export function SeccionGithub() {
  const [carga, setCarga] = useState<Carga>({ estado: "cargando" });
  const [sincronizando, setSincronizando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // El GET sincroniza contra GitHub, así que sirve también como "sincronizar ahora".
  const cargar = useCallback(async () => {
    try {
      setCarga({
        estado: "listo",
        instalaciones: await api.get<GithubInstallation[]>("/api/github/installations"),
      });
    } catch (cause) {
      setCarga({
        estado: "error",
        mensaje:
          cause instanceof ApiError ? cause.message : "No se pudo leer el estado de la GitHub App.",
      });
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function instalar() {
    setError(null);
    try {
      const { url } = await api.get<{ url: string }>("/api/github/install-url");
      window.location.href = url;
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "No se pudo generar la URL de instalación.",
      );
    }
  }

  async function sincronizar() {
    setSincronizando(true);
    await cargar();
    setSincronizando(false);
  }

  const instalaciones = carga.estado === "listo" ? carga.instalaciones : [];
  const tieneOrganizacion = instalaciones.some((i) => i.accountType === "Organization");

  return (
    <Seccion
      id="github"
      titulo="GitHub"
      bajada="Dónde está instalada la App y a qué repositorios llega. Los permisos se cambian siempre del lado de GitHub."
      accion={
        <Button
          size="sm"
          loading={sincronizando}
          disabled={carga.estado === "cargando"}
          onClick={() => void sincronizar()}
        >
          Sincronizar
        </Button>
      }
    >
      {carga.estado === "cargando" ? (
        <div className="flex items-center gap-2.5 py-2 text-[13px] text-ink-muted">
          <Spinner className="size-4" />
          Consultando GitHub…
        </div>
      ) : carga.estado === "error" ? (
        <Alert>{carga.mensaje}</Alert>
      ) : instalaciones.length === 0 ? (
        <div className="rounded-xl border border-white/6 bg-surface px-[18px] py-7 text-center">
          <p className="text-[13.5px] font-medium">La App no está instalada</p>
          <p className="mx-auto mt-1.5 max-w-[46ch] text-[13px] text-ink-muted">
            Sin instalación no hay repositorios que auditar.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/6 bg-surface">
          {instalaciones.map((instalacion) => (
            <FilaInstalacion key={instalacion.id} instalacion={instalacion} />
          ))}
        </div>
      )}

      {error ? <Alert className="mt-3">{error}</Alert> : null}

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <Button icon={<GithubIcon className="size-4" />} onClick={() => void instalar()}>
          {instalaciones.length === 0 ? "Instalar la App" : "Instalar en otra cuenta u organización"}
        </Button>
      </div>

      <div className="mt-3.5 flex gap-2.5">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
        <p className="max-w-[64ch] text-xs/[18px] text-ink-faint">
          {tieneOrganizacion
            ? "Para una organización hace falta ser dueño o administrador: GitHub puede pedir aprobación del owner antes de completar la instalación."
            : "Si pertenecés a una organización, podés instalar la App también ahí. GitHub te va a dejar elegir la cuenta en el próximo paso; para una organización tenés que ser dueño o administrador."}
        </p>
      </div>
    </Seccion>
  );
}

function FilaInstalacion({ instalacion }: { instalacion: GithubInstallation }) {
  const esOrg = instalacion.accountType === "Organization";

  return (
    <div className="flex items-center gap-3 border-b border-white/4 px-[15px] py-3.5 last:border-b-0">
      <span className="grid size-[26px] shrink-0 place-items-center rounded-lg border border-white/6 bg-raised">
        <GithubIcon className="size-3.5 text-ink-faint" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-[13px]">{instalacion.accountLogin}</span>
          <Chip>{esOrg ? "Organización" : "Cuenta personal"}</Chip>
          {instalacion.suspended ? <Chip tone="neutral">Suspendida</Chip> : null}
          {instalacion.repositorySelection === "all" ? (
            <Chip>Todos los repos</Chip>
          ) : (
            <Chip>Repos elegidos</Chip>
          )}
        </div>
        <p className="mt-0.5 text-[12.5px] text-ink-faint">
          {instalacion.suspended
            ? "La instalación está suspendida en GitHub: no se puede auditar nada de esta cuenta."
            : `${instalacion.accessibleRepos} ${
                instalacion.accessibleRepos === 1 ? "repositorio accesible" : "repositorios accesibles"
              } · ${instalacion.linkedRepos} ${
                instalacion.linkedRepos === 1 ? "vinculado" : "vinculados"
              }`}
        </p>
      </div>

      <a
        href={
          esOrg
            ? `https://github.com/organizations/${instalacion.accountLogin}/settings/installations/${instalacion.installationId}`
            : `https://github.com/settings/installations/${instalacion.installationId}`
        }
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-raised px-2.5 text-[12.5px] text-ink transition-colors hover:border-white/18 hover:bg-[#1c2028] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Gestionar
        <ExternalIcon className="size-3" />
      </a>
    </div>
  );
}
