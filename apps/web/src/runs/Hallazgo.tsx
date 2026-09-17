import { useState } from "react";

import type { Report } from "../api.ts";
import { Chip } from "../components/Chip.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ChevronIcon, ExternalIcon } from "../components/icons.tsx";
import { COLOR_SEVERIDAD, NOMBRE_SEVERIDAD } from "../salud.ts";

const ESFUERZO: Record<string, string> = { low: "bajo", medium: "medio", high: "alto" };
const CONFIANZA: Record<string, string> = { low: "baja", medium: "media", high: "alta" };

type Finding = Report["findings"][number];

/**
 * Tarjeta de hallazgo. Un hallazgo con `confidence: low` se ve menos firme que
 * uno con `high`: la app no debe presentar todo con la misma autoridad (doc 15).
 */
export function Hallazgo({ finding, abierto: inicial }: { finding: Finding; abierto?: boolean }) {
  const [abierto, setAbierto] = useState(inicial ?? false);
  const color = COLOR_SEVERIDAD[finding.severity] ?? COLOR_SEVERIDAD["info"]!;
  const dudoso = finding.confidence === "low";

  return (
    <article
      className="overflow-hidden rounded-xl border border-white/6 bg-surface"
      style={{ borderLeft: `2px solid ${color}` }}
    >
      <button
        type="button"
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span
          className="mt-px inline-flex h-[19px] shrink-0 items-center rounded-md border px-1.5 text-[10.5px] font-medium"
          style={{ color, borderColor: `${color}44`, backgroundColor: `${color}1a` }}
        >
          {NOMBRE_SEVERIDAD[finding.severity] ?? finding.severity}
        </span>

        <span className="min-w-0 flex-1">
          <span className={`block text-[13.5px]/[20px] font-medium ${dudoso ? "text-ink-muted" : ""}`}>
            {finding.title}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint">
            <span className="font-mono">{finding.category}</span>
            {finding.effort ? (
              <>
                <span className="opacity-40">·</span>
                <span>esfuerzo {ESFUERZO[finding.effort] ?? finding.effort}</span>
              </>
            ) : null}
            <span className="opacity-40">·</span>
            <span className={dudoso ? "text-sev-medium" : ""}>
              confianza {CONFIANZA[finding.confidence] ?? finding.confidence}
            </span>
          </span>
        </span>

        <ChevronIcon
          className={`mt-1 size-3.5 shrink-0 text-ink-faint transition-transform duration-150 ${
            abierto ? "rotate-0" : "rotate-180"
          }`}
        />
      </button>

      {abierto ? (
        <div className="border-t border-white/6 px-4 pt-3.5 pb-4">
          <Markdown texto={finding.description} />

          <div className="mt-3.5 rounded-[10px] border border-accent/22 bg-accent/6 px-3.5 py-3">
            <p className="mb-1.5 text-[11px] font-medium tracking-[0.06em] text-accent-text uppercase">
              Recomendación
            </p>
            <Markdown texto={finding.recommendation} />
          </div>

          {finding.locations && finding.locations.length > 0 ? (
            <Fila titulo="Ubicaciones">
              <div className="flex flex-wrap gap-2">
                {finding.locations.map((ubicacion, i) => (
                  <span
                    key={`${ubicacion.path}-${i}`}
                    className="rounded-md border border-white/6 bg-sunken px-2 py-1 font-mono text-[11.5px] text-ink-muted"
                  >
                    {ubicacion.path}
                    {ubicacion.line ? `:${ubicacion.line}` : ""}
                  </span>
                ))}
              </div>
            </Fila>
          ) : null}

          {finding.references && finding.references.length > 0 ? (
            <Fila titulo="Referencias">
              <div className="flex flex-col gap-1.5">
                {finding.references.map((referencia) => (
                  <a
                    key={referencia.url}
                    href={referencia.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-ink-muted transition-colors hover:text-ink"
                  >
                    {referencia.title ?? referencia.url}
                    {referencia.kind ? <Chip>{referencia.kind}</Chip> : null}
                    <ExternalIcon className="size-3 shrink-0" />
                  </a>
                ))}
              </div>
            </Fila>
          ) : null}

          <Fila titulo="Clave">
            <span className="font-mono text-[11.5px] text-ink-faint">{finding.finding_key}</span>
          </Fila>
        </div>
      ) : null}
    </article>
  );
}

function Fila({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="mt-3.5 grid gap-1.5 border-t border-white/4 pt-3.5 sm:grid-cols-[110px_1fr] sm:gap-3">
      <p className="text-[11px] font-medium tracking-[0.06em] text-ink-faint uppercase">{titulo}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
