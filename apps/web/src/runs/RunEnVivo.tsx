import { useEffect, useState } from "react";

import type { Run } from "../api.ts";
import { CheckIcon, InfoIcon } from "../components/icons.tsx";
import type { ProgresoRun, StepView } from "./useRunEvents.ts";

const FASES_ESPERADAS = 7;

/**
 * Vista del run en curso (V4).
 *
 * Todo lo que muestra sale del stream SSE. Si el stream se cae, la vista no
 * queda vacía: conserva lo último recibido y lo dice, en vez de fingir que no
 * pasa nada.
 */
export function RunEnVivo({ run, progreso }: { run: Run; progreso: ProgresoRun }) {
  const completados = progreso.steps.filter((paso) => paso.status === "completed").length;
  const total = progreso.steps.length || FASES_ESPERADAS;
  const enCurso = progreso.steps.find((paso) => paso.status === "running");

  return (
    <div className="mt-6">
      <div className="mb-4">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Cronometro desde={run.startedAt ?? run.queuedAt} />
          {progreso.steps.length > 0 ? (
            <span className="text-[12.5px] text-ink-faint">
              paso {Math.min(completados + 1, total)} de {total}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-faint">
            <span
              className={`size-1.5 rounded-full ${progreso.conectado ? "animate-pulse bg-ok" : "bg-ink-faint"}`}
            />
            {progreso.conectado ? "En vivo" : "Reconectando…"}
          </span>
        </div>

        <div className="h-1 overflow-hidden rounded-full bg-white/6">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${Math.round((completados / total) * 100)}%` }}
          />
        </div>
      </div>

      {progreso.reintento ? <Reintentando reintento={progreso.reintento} /> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_290px]">
        <section className="rounded-xl border border-white/6 bg-surface">
          <header className="flex items-center gap-2 border-b border-white/6 px-4 py-2.5">
            <span className="text-[11px] font-medium tracking-[0.06em] text-ink-faint uppercase">
              Recorrido del agente
            </span>
            <span className="ml-auto text-[12px] text-ink-faint">
              {completados} de {total} completados
            </span>
          </header>

          {progreso.steps.length === 0 ? (
            <Esperando />
          ) : (
            <ol className="px-4 py-2">
              {progreso.steps.map((paso, indice) => (
                <Paso
                  key={`${paso.key}-${paso.seq}`}
                  paso={paso}
                  ultimo={indice === progreso.steps.length - 1}
                  herramienta={paso.status === "running" ? progreso.herramienta : null}
                />
              ))}
            </ol>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <Panel titulo="Actividad">
            {enCurso ? (
              <p className="text-[13px] text-ink">{enCurso.title}</p>
            ) : (
              <p className="text-[13px] text-ink-faint">Sin fase en curso</p>
            )}
            {progreso.mensajes[0] ? (
              <p className="mt-2 line-clamp-4 text-[12.5px]/[18px] text-ink-muted">
                {progreso.mensajes[0]}
              </p>
            ) : null}
          </Panel>

          {progreso.archivos.length > 0 ? (
            <Panel titulo="Archivos tocados">
              <div className="flex flex-col gap-1.5">
                {progreso.archivos.map((archivo) => (
                  <span key={archivo} className="truncate font-mono text-[12px] text-ink-muted">
                    {archivo}
                  </span>
                ))}
              </div>
              <p className="mt-2.5 text-xs/[17px] text-ink-faint">
                Solo manifiestos y lockfiles: el resto está denegado por la allowlist al publicar.
              </p>
            </Panel>
          ) : null}

          <Panel titulo="Qué va a pasar al terminar">
            <p className="text-xs/[18px] text-ink-faint">
              El informe queda en el histórico y se puede releer cuando quieras. La creación del
              Pull Request llega con la Fase 7; hasta entonces, el agente propone los cambios pero
              no los publica.
            </p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function Paso({
  paso,
  ultimo,
  herramienta,
}: {
  paso: StepView;
  ultimo: boolean;
  herramienta: ProgresoRun["herramienta"];
}) {
  const hecho = paso.status === "completed";
  const corriendo = paso.status === "running";
  const salteado = paso.status === "skipped";

  return (
    <li className="grid grid-cols-[18px_1fr] gap-x-3">
      <div className="relative flex justify-center">
        {ultimo ? null : (
          <span aria-hidden="true" className="absolute top-[22px] -bottom-1 w-px bg-white/8" />
        )}
        <span
          className={`relative z-[1] mt-[5px] grid size-[15px] place-items-center rounded-full border ${
            hecho
              ? "border-ok/40 bg-ok/16 text-ok"
              : corriendo
                ? "border-accent bg-accent/20"
                : "border-white/12 bg-canvas"
          }`}
        >
          {hecho ? <CheckIcon className="size-2.5" /> : null}
          {corriendo ? <span className="size-1.5 animate-pulse rounded-full bg-accent" /> : null}
        </span>
      </div>

      <div className={`min-w-0 pb-4 ${ultimo ? "pb-2" : ""}`}>
        <p
          className={`text-[13.5px] ${
            corriendo ? "font-semibold text-ink" : hecho ? "text-ink" : "text-ink-faint"
          }`}
        >
          {paso.title}
          {salteado ? <span className="ml-2 text-[12px] text-ink-faint">— omitida</span> : null}
        </p>

        {corriendo && herramienta ? (
          <p className="mt-1.5 flex gap-1.5 truncate font-mono text-[11.5px] text-ink-faint">
            <span className="text-accent">&gt;</span>
            {herramienta.title}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** Cronómetro desde que el run arrancó. */
function Cronometro({ desde }: { desde: number }) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const segundos = Math.max(0, Math.floor((ahora - desde) / 1_000));
  return (
    <span className="font-mono text-[14px] text-ink tabular-nums">
      {String(Math.floor(segundos / 60)).padStart(2, "0")}:{String(segundos % 60).padStart(2, "0")}
    </span>
  );
}

function Reintentando({ reintento }: { reintento: NonNullable<ProgresoRun["reintento"]> }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-sev-medium/24 bg-sev-medium/6 px-4 py-3">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-sev-medium" />
      <p className="text-[13px]/[19px] text-[#d8b47f]">
        Reintentando (intento {reintento.attempt}) — {reintento.message}. Media hora de silencio
        sería indistinguible de un cuelgue, por eso se avisa.
      </p>
    </div>
  );
}

function Esperando() {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[13px] text-ink-muted">Esperando que el agente arme su plan…</p>
      <p className="mx-auto mt-1.5 max-w-[46ch] text-[12.5px] text-ink-faint">
        Las fases aparecen acá en cuanto el agente crea su lista de tareas.
      </p>
    </div>
  );
}

function Panel({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/6 bg-surface px-4 py-3.5">
      <p className="mb-2 text-[11px] font-medium tracking-[0.06em] text-ink-faint uppercase">
        {titulo}
      </p>
      {children}
    </section>
  );
}
