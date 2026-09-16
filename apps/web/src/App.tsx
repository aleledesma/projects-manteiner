import { authClient } from "./auth-client.ts";

export function App() {
  const session = authClient.useSession();

  if (session.isPending) return <p>Cargando sesion...</p>;

  if (!session.data) {
    return (
      <main>
        <h1>Manteiner</h1>
        {session.error ? <p>No se pudo consultar la sesion.</p> : null}
        <button
          type="button"
          onClick={() =>
            authClient.signIn.social({
              provider: "github",
              callbackURL: window.location.origin,
            })
          }
        >
          Continuar con GitHub
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Sesion iniciada</h1>
      <p>{session.data.user.name}</p>
      <p>{session.data.user.email}</p>
      <button type="button" onClick={() => authClient.signOut()}>
        Cerrar sesion
      </button>
    </main>
  );
}
