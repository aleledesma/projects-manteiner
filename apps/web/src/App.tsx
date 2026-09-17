import { useCallback, useEffect, useState } from "react"

import { Alert } from "./components/Alert.tsx"
import { Button } from "./components/Button.tsx"
import { BrandMark } from "./components/BrandMark.tsx"
import { Sidebar, type NavKey } from "./components/Sidebar.tsx"
import { Spinner } from "./components/icons.tsx"
import { LoginView } from "./views/LoginView.tsx"
import { OnboardingView } from "./views/OnboardingView.tsx"
import { SettingsView } from "./views/SettingsView.tsx"
import { authClient } from "./auth-client.ts"
import { useMe } from "./useMe.ts"

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

  return <ConSesion user={session.data.user} />
}

type User = { name?: string | null; image?: string | null; email?: string | null }

function ConSesion({ user }: { user: User }) {
  const { state, recargar } = useMe()

  // Si al entrar falta algo del onboarding, la vista se sostiene hasta que el
  // usuario la cierre desde la pantalla de bienvenida. Sin esto, completar el
  // tercer paso saltaría al dashboard sin cierre y sin acción siguiente.
  const [enOnboarding, setEnOnboarding] = useState<boolean | null>(null)
  const [vista, setVista] = useState<NavKey>("repos")
  const incompleto =
    state.estado === "listo" &&
    !(state.me.onboarding.hasProvider &&
      state.me.onboarding.hasInstallation &&
      state.me.onboarding.hasRepos)

  useEffect(() => {
    if (state.estado === "listo") setEnOnboarding((previo) => previo ?? incompleto)
  }, [state.estado, incompleto])

  // Identidad estable: los pasos la usan dentro de efectos.
  const recargarMe = useCallback(() => void recargar(), [recargar])
  const signOut = () => void authClient.signOut()

  if (state.estado === "cargando" || enOnboarding === null) {
    return (
      <main className="flex min-h-dvh items-center justify-center gap-2.5 px-6 text-[13px] text-ink-faint">
        <Spinner className="size-4" />
        Cargando tu cuenta…
      </main>
    )
  }

  if (state.estado === "error") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6">
        <Alert className="max-w-[420px]">{state.error.message}</Alert>
        <Button onClick={() => void recargar()}>Reintentar</Button>
      </main>
    )
  }

  if (enOnboarding) {
    return (
      <OnboardingView
        onboarding={state.me.onboarding}
        recargar={recargarMe}
        onListo={() => setEnOnboarding(false)}
        onSignOut={signOut}
      />
    )
  }

  return (
    <div className="flex min-h-dvh">
      <Sidebar user={user} onSignOut={signOut} activa={vista} onNavegar={setVista} />

      <div className="min-w-0 flex-1">
        {/* Mientras el sidebar no tenga su drawer de mobile, la marca, la
            navegación y la salida viven acá abajo de md. */}
        <header className="flex h-[57px] items-center gap-2.5 border-b border-white/6 px-6 md:hidden">
          <BrandMark size="sm" />
          <span className="text-[14.5px] font-semibold tracking-[-0.015em]">
            Manteiner
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setVista(vista === "settings" ? "repos" : "settings")}
          >
            {vista === "settings" ? "Repositorios" : "Configuración"}
          </Button>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Salir
          </Button>
        </header>

        {vista === "settings" ? (
          <main>
            <SettingsView me={state.me} recargarMe={recargarMe} onSignOut={signOut} />
          </main>
        ) : (
          <main className="px-6 py-8 sm:px-8">
            <h1 className="text-2xl font-semibold tracking-[-0.018em]">
              Repositorios
            </h1>
            <p className="mt-1.5 text-[13px] text-ink-muted">
              Sesión iniciada como <span className="font-mono">{user.email}</span>
              .
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-4 -ml-2.5"
              onClick={() => {
                void recargar()
                setEnOnboarding(true)
              }}
            >
              Volver a la configuración inicial
            </Button>
          </main>
        )}
      </div>
    </div>
  )
}
