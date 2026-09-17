import { useState } from "react";

import { api, ApiError } from "../api.ts";
import { Alert } from "../components/Alert.tsx";
import { Button } from "../components/Button.tsx";
import { GithubIcon, ShieldIcon } from "../components/icons.tsx";

const PERMISOS = [
  {
    titulo: "Contenido: lectura y escritura",
    detalle:
      "Clona el repo para auditarlo y crea la rama del Pull Request. Nunca escribe en tu rama principal ni hace merge.",
  },
  {
    titulo: "Pull Requests: escritura",
    detalle: "Abre el PR con los cambios propuestos, para que vos lo revises.",
  },
  {
    titulo: "Metadata: lectura",
    detalle: "Lee el nombre, la rama por defecto y el lenguaje de cada repositorio.",
  },
];

export function StepGithub() {
  const [redirigiendo, setRedirigiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function instalar() {
    setRedirigiendo(true);
    setError(null);
    try {
      const { url } = await api.get<{ url: string }>("/api/github/install-url");
      window.location.href = url;
    } catch (cause) {
      setRedirigiendo(false);
      setError(
        cause instanceof ApiError ? cause.message : "No se pudo generar la URL de instalación.",
      );
    }
  }

  return (
    <div>
      <div className="rounded-[13px] border border-white/6 bg-surface px-[18px] py-4">
        <div className="flex items-start gap-3">
          <span className="grid size-[26px] shrink-0 place-items-center rounded-lg border border-white/6 bg-raised">
            <ShieldIcon className="size-3.5 text-ink-muted" />
          </span>
          <p className="max-w-[58ch] text-[13px]/[20px] text-ink-muted">
            Manteiner pide permiso de escritura de contenido para poder crear la rama del Pull
            Request. <strong className="font-semibold text-ink">Nunca escribe en tu rama principal ni hace merge.</strong>{" "}
            Vos elegís a qué repositorios darle acceso, y podés cambiarlo cuando quieras desde
            GitHub.
          </p>
        </div>

        <ul className="mt-4 flex flex-col gap-3 border-t border-white/6 pt-4">
          {PERMISOS.map((permiso) => (
            <li key={permiso.titulo} className="flex gap-3">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-faint" />
              <span>
                <span className="block text-[13px] font-medium">{permiso.titulo}</span>
                <span className="mt-0.5 block max-w-[56ch] text-[12.5px]/[18px] text-ink-faint">
                  {permiso.detalle}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {error ? <Alert className="mt-3">{error}</Alert> : null}

      <Button
        variant="primary"
        className="mt-4"
        loading={redirigiendo}
        icon={<GithubIcon className="size-4" />}
        onClick={() => void instalar()}
      >
        {redirigiendo ? "Abriendo GitHub…" : "Instalar en GitHub"}
      </Button>
    </div>
  );
}
