import { Button } from "./components/Button.tsx"
import { BrandMark } from "./components/BrandMark.tsx"
import { Sidebar } from "./components/Sidebar.tsx"
import { LoginView } from "./views/LoginView.tsx"
import { authClient } from "./auth-client.ts"

/** Errores que GitHub puede devolver al volver del OAuth, traducidos. */
function errorDeCallback(): string | null {
  const code = new URLSearchParams(window.location.search).get("error")
  if (!code) return null
  if (code === "access_denied")
    return "No se completó la autorización. Podés intentarlo de nuevo."
  return "No se pudo completar el inicio de sesión. Probá de nuevo."
}

export function App() {
  const session = authClient.useSession()

  if (session.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <p className="text-[13px] text-ink-faint">Cargando sesión…</p>
      </main>
    )
  }

  if (!session.data) {
    return (
      <LoginView
        error={
          session.error
            ? "No se pudo consultar la sesión. Revisá tu conexión e intentá de nuevo."
            : errorDeCallback()
        }
      />
    )
  }

  const { user } = session.data
  const signOut = () => void authClient.signOut()

  return (
    <div className="flex min-h-dvh">
      <Sidebar user={user} onSignOut={signOut} />

      <div className="min-w-0 flex-1">
        {/* Mientras el sidebar no tenga su drawer de mobile, la marca y la salida
            viven acá abajo de md. Ver el responsive de docs/15-diseno-ui.md. */}
        <header className="flex h-[57px] items-center gap-2.5 border-b border-white/6 px-6 md:hidden">
          <BrandMark size="sm" />
          <span className="text-[14.5px] font-semibold tracking-[-0.015em]">
            Manteiner
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={signOut}
          >
            Cerrar sesión
          </Button>
        </header>

        <main className="px-6 py-8 sm:px-8">
          <h1 className="text-2xl font-semibold tracking-[-0.018em]">
            Repositorios
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            Sesión iniciada como <span className="font-mono">{user.email}</span>
            .
          </p>
        </main>
      </div>
    </div>
  )
}
