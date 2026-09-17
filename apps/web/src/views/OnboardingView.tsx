import { useEffect, useState, type ReactNode } from "react";

import type { Onboarding } from "../api.ts";
import { BrandMark } from "../components/BrandMark.tsx";
import { Button } from "../components/Button.tsx";
import { Chip } from "../components/Chip.tsx";
import { ArrowRightIcon, CheckIcon, ChevronIcon } from "../components/icons.tsx";
import { StepGithub } from "../onboarding/StepGithub.tsx";
import { StepProvider } from "../onboarding/StepProvider.tsx";
import { StepRepos } from "../onboarding/StepRepos.tsx";

type Paso = 1 | 2 | 3;

const PASOS: { n: Paso; titulo: string; bajada: string; hecho: keyof Onboarding }[] = [
  {
    n: 1,
    titulo: "Conectar un proveedor de IA",
    bajada: "El agente corre con tus credenciales. Manteiner no provee el modelo.",
    hecho: "hasProvider",
  },
  {
    n: 2,
    titulo: "Instalar la GitHub App",
    bajada: "Elegís a qué repositorios damos acceso. Se puede cambiar después.",
    hecho: "hasInstallation",
  },
  {
    n: 3,
    titulo: "Vincular repositorios",
    bajada: "De los que la App puede ver, elegís cuáles querés auditar.",
    hecho: "hasRepos",
  },
];

type Props = {
  onboarding: Onboarding;
  /** Vuelve a pedir `/api/me`: el estado de cada paso vive en el servidor. */
  recargar: () => void;
  /** El usuario terminó y quiere ir al dashboard. */
  onListo: () => void;
  onSignOut: () => void;
};

export function OnboardingView({ onboarding, recargar, onListo, onSignOut }: Props) {
  const completos = PASOS.filter((paso) => onboarding[paso.hecho]).length;
  const primerIncompleto = (PASOS.find((paso) => !onboarding[paso.hecho])?.n ?? 3) as Paso;
  // `null` = todos colapsados. Los pasos abren y cierran a demanda.
  const [abierto, setAbierto] = useState<Paso | null>(primerIncompleto);

  // Al volver del redirect de la GitHub App: se limpia el query y se avanza al
  // paso que corresponda, sin dejar `?github=connected` pegado en la barra.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("github")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // A propósito NO se salta de paso solo porque el servidor marque uno completo:
  // al conectar el proveedor hay que quedarse para poder elegir modelo. Avanzar
  // es explícito, con el botón de cada paso.
  if (completos === PASOS.length) {
    return <Bienvenida onListo={onListo} />;
  }

  return (
    <main className="relative min-h-dvh px-6 pt-10 pb-24">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-1/2 h-[420px] w-[820px] max-w-[130vw] -translate-x-1/2 bg-[radial-gradient(ellipse_at_50%_0%,rgb(129_137_200/0.04),transparent_64%)]"
      />

      <div className="relative mx-auto max-w-[700px]">
        <header className="animate-rise mb-[34px] flex items-center gap-2.5">
          <BrandMark size="sm" />
          <span className="text-[14.5px] font-semibold tracking-[-0.015em]">Manteiner</span>
          <span className="ml-auto text-xs text-ink-faint max-sm:hidden">
            Configuración inicial · {Math.min(completos + 1, 3)} de 3
          </span>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            Salir
          </Button>
        </header>

        <div className="animate-rise mb-[30px]" style={{ animationDelay: "40ms" }}>
          <h1 className="text-[27px] font-semibold tracking-[-0.026em]">
            Antes de la primera auditoría
          </h1>
          <p className="mt-[7px] max-w-[56ch] text-[14.5px]/[22px] text-ink-muted">
            Tres cosas, en el orden que quieras. Hasta tenerlas las tres no se puede disparar una
            auditoría.
          </p>
        </div>

        <div
          className="animate-rise grid grid-cols-[26px_1fr] gap-x-4 max-md:grid-cols-[1fr]"
          style={{ animationDelay: "80ms" }}
        >
          {PASOS.map((paso, indice) => {
            const hecho = onboarding[paso.hecho];
            const activo = abierto === paso.n;
            const ultimo = indice === PASOS.length - 1;

            return (
              <Grupo key={paso.n} nodo={<Nodo n={paso.n} hecho={hecho} activo={activo} ultimo={ultimo} />}>
                {/* Todos los pasos son clickeables: el orden es libre. El chevron
                    y el hover son la señal de que la fila abre y cierra. */}
                <button
                  type="button"
                  aria-expanded={activo}
                  onClick={() => setAbierto(activo ? null : paso.n)}
                  className="group -mx-2 block w-full rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-white/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="flex items-center gap-2">
                    <h2
                      className={`text-base/[26px] tracking-[-0.012em] transition-colors duration-150 ${
                        activo || hecho
                          ? "font-semibold"
                          : "font-medium text-ink-faint group-hover:text-ink"
                      }`}
                    >
                      {paso.titulo}
                    </h2>
                    {hecho ? <Chip tone="ok">Listo</Chip> : activo ? null : <Chip>Pendiente</Chip>}
                    <ChevronIcon
                      className={`ml-auto size-3.5 shrink-0 text-ink-faint transition-all duration-150 group-hover:text-ink-muted ${
                        activo ? "rotate-0" : "rotate-180 opacity-55 group-hover:opacity-100"
                      }`}
                    />
                  </span>
                  <span
                    className={`mt-1 block text-[13px] ${activo ? "text-ink-muted" : "text-ink-faint"}`}
                  >
                    {paso.bajada}
                  </span>
                </button>

                {activo ? (
                  <div className="pt-3.5 pb-9">
                    {paso.n === 1 ? (
                      <StepProvider onConectado={recargar} onAvanzar={() => setAbierto(2)} />
                    ) : null}
                    {paso.n === 2 ? <StepGithub /> : null}
                    {paso.n === 3 ? <StepRepos onVinculados={recargar} /> : null}
                  </div>
                ) : (
                  <div className="pb-7" />
                )}
              </Grupo>
            );
          })}
        </div>
      </div>
    </main>
  );
}

/** `display: contents` para que nodo y cuerpo compartan las filas de la grilla. */
function Grupo({ nodo, children }: { nodo: ReactNode; children: ReactNode }) {
  return (
    <div className="contents">
      {nodo}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Nodo({
  n,
  hecho,
  activo,
  ultimo,
}: {
  n: number;
  hecho: boolean;
  activo: boolean;
  ultimo: boolean;
}) {
  return (
    <div className="relative flex justify-center max-md:hidden">
      {ultimo ? null : (
        <span aria-hidden="true" className="absolute top-[30px] -bottom-3 w-px bg-white/10" />
      )}
      <span
        className={`relative z-[1] grid size-[26px] place-items-center rounded-full border font-mono text-[11.5px] font-medium ${
          hecho
            ? "border-ok/30 bg-ok/10 text-ok"
            : activo
              ? "border-accent/40 bg-accent/10 text-accent-text shadow-[0_0_0_4px_rgb(129_137_200/0.07)]"
              : "border-white/10 bg-canvas text-ink-faint"
        }`}
      >
        {hecho ? <CheckIcon className="size-3" /> : n}
      </span>
    </div>
  );
}

function Bienvenida({ onListo }: { onListo: () => void }) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-12">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-ambient-glow" />

      <div className="animate-rise relative flex max-w-[420px] flex-col items-center pb-[5vh] text-center">
        <span className="grid size-14 place-items-center rounded-2xl border border-ok/26 bg-ok/10">
          <CheckIcon className="size-7 text-ok" />
        </span>
        <h1 className="mt-6 text-[27px] font-semibold tracking-[-0.028em]">Todo listo</h1>
        <p className="mt-2 text-[14.5px]/[22px] text-ink-muted">
          Ya tenés proveedor, la App instalada y repositorios vinculados. Podés lanzar tu primera
          auditoría.
        </p>
        <Button
          variant="primary"
          size="lg"
          className="mt-8"
          icon={<ArrowRightIcon className="size-[17px]" />}
          onClick={onListo}
        >
          Auditar mi primer repositorio
        </Button>
      </div>
    </main>
  );
}
