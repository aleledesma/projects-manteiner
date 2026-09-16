import { useState } from "react";

import { BrandMark } from "../components/BrandMark.tsx";
import { Button } from "../components/Button.tsx";
import { CheckIcon, GithubIcon } from "../components/icons.tsx";
import { authClient } from "../auth-client.ts";

const PERMISOS = [
  "Lee tu perfil público de GitHub para identificarte.",
  "Vos elegís a qué repositorios puede acceder, uno por uno.",
  "Crea ramas y Pull Requests. Nunca escribe en tu rama principal ni hace merge.",
];

type Props = {
  /** La sesión no se pudo consultar, o GitHub devolvió un error de autorización. */
  error?: string | null;
};

export function LoginView({ error }: Props) {
  const [redirecting, setRedirecting] = useState(false);

  async function signIn() {
    setRedirecting(true);
    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: window.location.origin,
      });
    } catch {
      setRedirecting(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[44%] left-1/2 h-[420px] w-[620px] max-w-[130vw] -translate-x-1/2 -translate-y-1/2 bg-ambient-glow"
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-dot-grid" />

      <div className="relative w-full max-w-[408px] pb-[5vh]">
        <div className="animate-rise">
          <BrandMark size="lg" />
          <h1 className="mt-[18px] text-[27px] font-semibold tracking-[-0.028em]">Manteiner</h1>
          <p className="mt-2 max-w-[36ch] text-[14.5px]/[22px] text-ink-muted">
            Auditorías de mantenimiento para tus repositorios, ejecutadas por un agente de IA.
          </p>
        </div>

        {error ? (
          <p
            role="status"
            className="animate-rise mt-6 rounded-[10px] border border-sev-high/22 bg-sev-high/6 px-3.5 py-2.5 text-[13px]/[19px] text-[#dda0a5]"
          >
            {error}
          </p>
        ) : null}

        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={redirecting}
          icon={<GithubIcon className="size-[17px]" />}
          onClick={signIn}
          className="animate-rise mt-8"
          style={{ animationDelay: "80ms" }}
        >
          {redirecting ? "Redirigiendo a GitHub…" : "Continuar con GitHub"}
        </Button>

        <ul className="animate-rise mt-6 flex flex-col gap-2.5" style={{ animationDelay: "120ms" }}>
          {PERMISOS.map((permiso) => (
            <li key={permiso} className="flex items-start gap-2.5 text-[13px]/[19px] text-ink-muted">
              <CheckIcon className="mt-[3px] size-3 shrink-0 text-ink-faint" />
              {permiso}
            </li>
          ))}
        </ul>
      </div>

      <footer
        className="animate-rise relative flex items-center gap-3.5 text-xs text-ink-faint"
        style={{ animationDelay: "160ms" }}
      >
        <a href="#" className="transition-colors hover:text-ink-muted">
          Términos
        </a>
        <span className="opacity-40">·</span>
        <a href="#" className="transition-colors hover:text-ink-muted">
          Privacidad
        </a>
        <span className="opacity-40">·</span>
        <span className="font-mono text-[11px]">v0.1.0</span>
      </footer>
    </main>
  );
}
