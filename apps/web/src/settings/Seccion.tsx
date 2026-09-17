import type { ReactNode } from "react";

type Props = {
  id: string;
  titulo: string;
  bajada?: string;
  /** Acción principal de la sección, alineada a la derecha del encabezado. */
  accion?: ReactNode;
  children: ReactNode;
};

/** Bloque de Configuración. El `id` es el ancla de la navegación lateral. */
export function Seccion({ id, titulo, bajada, accion, children }: Props) {
  return (
    <section id={id} className="scroll-mt-8 border-b border-white/6 pb-9 last:border-b-0 last:pb-0">
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-[-0.016em]">{titulo}</h2>
          {bajada ? (
            <p className="mt-1 max-w-[62ch] text-[13px]/[20px] text-ink-muted">{bajada}</p>
          ) : null}
        </div>
        {accion ? <div className="shrink-0">{accion}</div> : null}
      </div>
      {children}
    </section>
  );
}
