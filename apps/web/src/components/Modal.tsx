import { useEffect, useRef, type ReactNode } from "react";

type Props = {
  titulo: string;
  descripcion?: string;
  onCerrar: () => void;
  children: ReactNode;
  /** Acciones del pie. Sin esto el modal solo se cierra con Esc o la X. */
  pie?: ReactNode;
  ancho?: "md" | "lg";
};

/**
 * Diálogo modal. Cierra con Esc y con clic en el fondo, devuelve el foco al
 * elemento que lo abrió y atrapa el tabulado mientras está abierto.
 */
export function Modal({ titulo, descripcion, onCerrar, children, pie, ancho = "md" }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const previo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previo.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    function alTeclado(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCerrar();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focuseables = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const primero = focuseables[0];
      const ultimo = focuseables[focuseables.length - 1];
      if (!primero || !ultimo) return;
      if (event.shiftKey && document.activeElement === primero) {
        event.preventDefault();
        ultimo.focus();
      } else if (!event.shiftKey && document.activeElement === ultimo) {
        event.preventDefault();
        primero.focus();
      }
    }

    document.addEventListener("keydown", alTeclado);
    panel.current?.querySelector<HTMLElement>("button, input, a[href]")?.focus();

    return () => {
      document.removeEventListener("keydown", alTeclado);
      document.body.style.overflow = overflow;
      previo.current?.focus();
    };
  }, [onCerrar]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-[6vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCerrar();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className={`animate-pop w-full rounded-2xl border border-white/10 bg-overlay shadow-[0_24px_72px_rgb(0_0_0/0.6)] ${
          ancho === "lg" ? "max-w-[640px]" : "max-w-[500px]"
        }`}
      >
        <header className="flex items-start gap-3 border-b border-white/6 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-[-0.012em]">{titulo}</h2>
            {descripcion ? (
              <p className="mt-1 text-[13px]/[19px] text-ink-muted">{descripcion}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="-mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className="size-3.5">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
            </svg>
          </button>
        </header>

        <div className="px-5 py-4">{children}</div>

        {pie ? (
          <footer className="flex items-center justify-end gap-2.5 border-t border-white/6 px-5 py-3.5">
            {pie}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
