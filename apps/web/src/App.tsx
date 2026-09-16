import { BrandMark } from "./components/BrandMark.tsx";
import { Button } from "./components/Button.tsx";
import { LoginView } from "./views/LoginView.tsx";
import { authClient } from "./auth-client.ts";

/** Errores que GitHub puede devolver al volver del OAuth, traducidos. */
function errorDeCallback(): string | null {
  const code = new URLSearchParams(window.location.search).get("error");
  if (!code) return null;
  if (code === "access_denied") return "No se completó la autorización. Podés intentarlo de nuevo.";
  return "No se pudo completar el inicio de sesión. Probá de nuevo.";
}

export function App() {
  const session = authClient.useSession();

  if (session.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <p className="text-[13px] text-ink-faint">Cargando sesión…</p>
      </main>
    );
  }

  if (!session.data) {
    return (
      <LoginView
        error={
          session.error ? "No se pudo consultar la sesión. Revisá tu conexión e intentá de nuevo." : errorDeCallback()
        }
      />
    );
  }

  const { user } = session.data;

  return (
    <main className="mx-auto flex min-h-dvh max-w-[1244px] flex-col px-6 py-8 sm:px-8">
      <header className="flex items-center gap-3">
        <BrandMark size="sm" />
        <span className="text-[14.5px] font-semibold tracking-[-0.015em]">Manteiner</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => authClient.signOut()}>
          Cerrar sesión
        </Button>
      </header>

      <div className="mt-10">
        <h1 className="text-2xl font-semibold tracking-[-0.018em]">Sesión iniciada</h1>
        <p className="mt-1.5 text-[13px] text-ink-muted">
          {user.name} · <span className="font-mono">{user.email}</span>
        </p>
      </div>
    </main>
  );
}
