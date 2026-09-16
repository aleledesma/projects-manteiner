import { useEffect, useRef, useState } from "react"

import { Avatar } from "./Avatar.tsx"
import { BrandMark } from "./BrandMark.tsx"
import {
  ChevronIcon,
  ReposIcon,
  RunsIcon,
  SettingsIcon,
  SignOutIcon,
} from "./icons.tsx"

type NavKey = "repos" | "runs" | "settings"

const NAV = [
  { key: "repos", label: "Repositorios", Icon: ReposIcon },
  { key: "runs", label: "Ejecuciones", Icon: RunsIcon },
  { key: "settings", label: "Configuración", Icon: SettingsIcon },
] as const satisfies readonly {
  key: NavKey
  label: string
  Icon: typeof ReposIcon
}[]

type User = {
  name?: string | null
  image?: string | null
  email?: string | null
}

type Props = {
  user: User
  onSignOut: () => void
}

export function Sidebar({ user, onSignOut }: Props) {
  // Marca el item activo sin navegar: las rutas todavía no existen.
  const [activa, setActiva] = useState<NavKey>("repos")

  return (
    <aside className="sticky top-0 hidden h-dvh w-[244px] shrink-0 flex-col border-r border-white/6 bg-[linear-gradient(180deg,#0c0d10_0%,var(--color-canvas)_260px)] md:flex">
      <div className="flex h-[57px] items-center gap-2.5 border-b border-white/6 px-[18px]">
        <BrandMark size="sm" />
        <span className="text-[14.5px] font-semibold tracking-[-0.015em]">
          Manteiner
        </span>
      </div>

      <nav className="flex flex-col gap-0.5 p-3 pt-3.5">
        {NAV.map(({ key, label, Icon }) => {
          const on = key === activa
          return (
            <button
              key={key}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => setActiva(key)}
              className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                on
                  ? "bg-white/5 text-ink before:absolute before:-left-3 before:top-2 before:bottom-2 before:w-0.5 before:rounded-r-sm before:bg-accent before:content-['']"
                  : "text-ink-muted hover:bg-raised hover:text-ink"
              }`}
            >
              <Icon className="size-[15px] shrink-0 opacity-80" />
              {label}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto p-3">
        <UserMenu user={user} onSignOut={onSignOut} />
      </div>
    </aside>
  )
}

function UserMenu({ user, onSignOut }: Props) {
  const [abierto, setAbierto] = useState(false)
  const contenedor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!abierto) return

    function alClickAfuera(event: MouseEvent) {
      if (!contenedor.current?.contains(event.target as Node)) setAbierto(false)
    }
    function alEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setAbierto(false)
    }

    document.addEventListener("mousedown", alClickAfuera)
    document.addEventListener("keydown", alEscape)
    return () => {
      document.removeEventListener("mousedown", alClickAfuera)
      document.removeEventListener("keydown", alEscape)
    }
  }, [abierto])

  return (
    <div ref={contenedor} className="relative">
      {abierto ? (
        <div
          role="menu"
          className="animate-pop absolute bottom-full left-0 mb-2 w-full origin-bottom rounded-xl border border-white/10 bg-overlay p-1 shadow-[0_16px_48px_rgb(0_0_0/0.55)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAbierto(false)
              onSignOut()
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-muted transition-colors duration-150 hover:bg-white/5 hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <SignOutIcon className="size-4 shrink-0" />
            Cerrar sesión
          </button>
        </div>
      ) : null}

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left transition-colors duration-150 hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <Avatar name={user.name} src={user.image} />
        <div className="flex flex-col max-w-[77%]">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
            {user.name ?? "Sin nombre"}
          </span>
          <span className="text-[10px] font-mono truncate text-gray-400">
            {user.email ?? "Sin email"}
          </span>
        </div>
        <ChevronIcon
          className={`size-3 shrink-0 text-ink-faint transition-transform duration-150 ${abierto ? "rotate-180" : ""}`}
        />
      </button>
    </div>
  )
}
