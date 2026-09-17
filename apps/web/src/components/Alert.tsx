import type { ReactNode } from "react";

type Tone = "error" | "warn" | "info";

const TONES: Record<Tone, string> = {
  error: "border-sev-high/22 bg-sev-high/6 text-[#dda0a5]",
  warn: "border-sev-medium/22 bg-sev-medium/6 text-[#d8b47f]",
  info: "border-white/10 bg-white/3 text-ink-muted",
};

type Props = {
  tone?: Tone;
  children: ReactNode;
  className?: string;
};

/**
 * Alerta inline. Persistente y sin auto-cierre: solo se usa para problemas que
 * requieren una acción del usuario. Las confirmaciones de bajo riesgo no van acá.
 */
export function Alert({ tone = "error", children, className = "" }: Props) {
  return (
    <p
      role="status"
      className={`rounded-[10px] border px-3.5 py-2.5 text-[13px]/[19px] ${TONES[tone]} ${className}`}
    >
      {children}
    </p>
  );
}
