import { useCallback, useEffect, useState } from "react";

import { api, type Me, type ProviderCredential } from "../api.ts";
import { Spinner } from "../components/icons.tsx";
import { SeccionCuenta } from "../settings/SeccionCuenta.tsx";
import { SeccionGithub } from "../settings/SeccionGithub.tsx";
import { SeccionModelo } from "../settings/SeccionModelo.tsx";
import { SeccionProveedores } from "../settings/SeccionProveedores.tsx";

const NAV = [
  { id: "proveedores", label: "Proveedores de IA" },
  { id: "modelo", label: "Modelo por defecto" },
  { id: "github", label: "GitHub" },
  { id: "cuenta", label: "Cuenta" },
] as const;

type Props = {
  me: Me;
  /** Refresca `/api/me`: el estado de onboarding cambia al tocar credenciales. */
  recargarMe: () => void;
  onSignOut: () => void;
};

export function SettingsView({ me, recargarMe, onSignOut }: Props) {
  const [credenciales, setCredenciales] = useState<ProviderCredential[] | null>(null);
  const [visible, setVisible] = useState<string>(NAV[0].id);

  const recargarCredenciales = useCallback(async () => {
    setCredenciales(await api.get<ProviderCredential[]>("/api/providers").catch(() => []));
    recargarMe();
  }, [recargarMe]);

  useEffect(() => {
    void api
      .get<ProviderCredential[]>("/api/providers")
      .then(setCredenciales)
      .catch(() => setCredenciales([]));
  }, []);

  /**
   * Marca en la navegación la sección que se está leyendo: la última cuyo tope
   * ya pasó el umbral. Con IntersectionObserver y una banda angosta, una sección
   * más alta que la banda nunca la activaba y la marca quedaba en la anterior.
   */
  useEffect(() => {
    const UMBRAL = 140;
    function alScroll() {
      let actual: string = NAV[0].id;
      for (const { id } of NAV) {
        const nodo = document.getElementById(id);
        if (nodo && nodo.getBoundingClientRect().top <= UMBRAL) actual = id;
      }
      // Al fondo de la página gana la última: si no, nunca llega al umbral.
      const fondo = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setVisible(fondo ? NAV[NAV.length - 1]!.id : actual);
    }

    alScroll();
    window.addEventListener("scroll", alScroll, { passive: true });
    window.addEventListener("resize", alScroll);
    return () => {
      window.removeEventListener("scroll", alScroll);
      window.removeEventListener("resize", alScroll);
    };
  }, [credenciales]);

  if (credenciales === null) {
    return (
      <div className="flex items-center gap-2.5 px-6 py-8 text-[13px] text-ink-faint sm:px-8">
        <Spinner className="size-4" />
        Cargando configuración…
      </div>
    );
  }

  return (
    <div className="px-6 py-8 sm:px-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-[-0.018em]">Configuración</h1>
        <p className="mt-1.5 max-w-[62ch] text-[13px] text-ink-muted">
          Todo lo que definiste al empezar se puede cambiar desde acá.
        </p>
      </header>

      {/* La nav queda pegada a la izquierda, junto al sidebar de la app: centrada
          con el contenido flotaba suelta en el medio. Solo se centra el contenido. */}
      <div className="flex gap-10">
        <nav className="sticky top-8 hidden h-fit w-[180px] shrink-0 flex-col gap-0.5 lg:flex">
          {NAV.map(({ id, label }) => {
            const on = visible === id;
            return (
              <a
                key={id}
                href={`#${id}`}
                aria-current={on ? "true" : undefined}
                className={`rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                  on ? "bg-white/5 font-medium text-ink" : "text-ink-muted hover:bg-raised hover:text-ink"
                }`}
              >
                {label}
              </a>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-1 justify-center">
          <div className="flex w-full max-w-[720px] flex-col gap-9">
            <SeccionProveedores
              credenciales={credenciales}
              recargar={() => void recargarCredenciales()}
            />
            <SeccionModelo credenciales={credenciales} />
            <SeccionGithub />
            <SeccionCuenta me={me} onSignOut={onSignOut} />
          </div>
        </div>

        {/* Contrapeso del ancho de la nav: sin esto el contenido se centraría en
            el espacio sobrante y quedaría corrido a la derecha. */}
        <div aria-hidden="true" className="hidden w-[180px] shrink-0 lg:block" />
      </div>
    </div>
  );
}
