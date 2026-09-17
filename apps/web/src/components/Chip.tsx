import type { ReactNode } from "react";

type Tone = "neutral" | "accent" | "ok";

const TONES: Record<Tone, string> = {
  neutral: "border-white/10 bg-white/4 text-ink-faint",
  accent: "border-accent/30 bg-accent/10 text-accent-text",
  ok: "border-ok/26 bg-ok/10 text-ok",
};

type Props = {
  tone?: Tone;
  children: ReactNode;
  className?: string;
};

export function Chip({ tone = "neutral", children, className = "" }: Props) {
  return (
    <span
      className={`inline-flex h-[19px] shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10.5px] font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
