import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Spinner } from "./icons.tsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  /** Muestra el spinner en el lugar del icono: el ancho no cambia. */
  loading?: boolean;
  icon?: ReactNode;
  fullWidth?: boolean;
};

const BASE =
  "inline-flex items-center justify-center gap-2 border font-medium tracking-[-0.003em] whitespace-nowrap " +
  "transition-colors duration-150 active:translate-y-px " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "disabled:pointer-events-none disabled:opacity-55";

const VARIANTS: Record<Variant, string> = {
  // El unico relleno solido de la app.
  primary: "bg-accent-fill text-[#edeff7] border-white/8 font-semibold hover:bg-accent-hover",
  secondary: "bg-raised text-ink border-white/10 hover:bg-[#1c2028] hover:border-white/18",
  ghost: "border-transparent text-ink-muted hover:bg-raised hover:text-ink",
  danger: "bg-sev-high/6 text-sev-high border-sev-high/24 hover:bg-sev-high/12 hover:border-sev-high/40",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 rounded-lg px-2.5 text-[12.5px]",
  md: "h-[34px] rounded-[10px] px-3.5 text-[13px]",
  lg: "h-[46px] rounded-xl px-5 text-[14.5px]",
};

const ICON_SIZE: Record<Size, string> = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-[17px]",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  fullWidth = false,
  disabled,
  children,
  className = "",
  ...rest
}: Props) {
  const leading = loading ? <Spinner className={ICON_SIZE[size]} /> : icon;

  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${fullWidth ? "w-full" : ""} ${className}`}
    >
      {leading ? <span className={`grid shrink-0 place-items-center ${ICON_SIZE[size]}`}>{leading}</span> : null}
      {children}
    </button>
  );
}
