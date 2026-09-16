const SIZES = {
  sm: "size-6 rounded-[7px] text-[10.5px]",
  md: "size-7 rounded-lg text-[11px]",
  /** Bloque de usuario del sidebar, con nombre y email en dos lineas. */
  lg: "size-[30px] rounded-[9px] text-[11.5px]",
} as const

type Props = {
  name?: string | null
  src?: string | null
  size?: keyof typeof SIZES
  className?: string
}

/** Iniciales de las dos primeras palabras del nombre. Fallback cuando no hay avatar. */
function iniciales(name?: string | null): string {
  const partes = (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2)
  if (partes.length === 0) return "?"
  return partes.map((p) => p[0]!.toUpperCase()).join("")
}

export function Avatar({ name, src, size = "sm", className = "" }: Props) {
  const box = `grid shrink-0 place-items-center overflow-hidden border border-white/10 bg-[#262a33] font-semibold text-ink-muted ${SIZES[size]} ${className}`

  if (src) {
    return <img src={src} alt="" className={box} referrerPolicy="no-referrer" />
  }

  return (
    <span className={box} aria-hidden="true">
      {iniciales(name)}
    </span>
  )
}
