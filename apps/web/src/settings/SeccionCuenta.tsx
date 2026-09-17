import type { Me } from "../api.ts";
import { Avatar } from "../components/Avatar.tsx";
import { Button } from "../components/Button.tsx";
import { InfoIcon } from "../components/icons.tsx";
import { Seccion } from "./Seccion.tsx";

type Props = {
  me: Me;
  onSignOut: () => void;
};

export function SeccionCuenta({ me, onSignOut }: Props) {
  return (
    <Seccion id="cuenta" titulo="Cuenta" bajada="Tu identidad de GitHub. Manteiner no guarda contraseñas.">
      <div className="flex items-center gap-3 rounded-xl border border-white/6 bg-surface px-[15px] py-3.5">
        <Avatar name={me.user.name} src={me.user.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold">{me.user.name ?? "Sin nombre"}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 truncate font-mono text-[12.5px] text-ink-faint">
            {me.user.githubLogin ? <span>@{me.user.githubLogin}</span> : null}
            {me.user.githubLogin && me.user.email ? <span className="opacity-40">·</span> : null}
            {me.user.email ? <span>{me.user.email}</span> : null}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onSignOut}>
          Cerrar sesión
        </Button>
      </div>

      <div className="mt-3 flex gap-2.5">
        <InfoIcon className="mt-px size-3.5 shrink-0 text-ink-faint" />
        <p className="max-w-[62ch] text-xs/[18px] text-ink-faint">
          El borrado de cuenta todavía no está implementado en la API. Mientras tanto, para cortar
          el acceso: desinstalá la App desde GitHub y eliminá tus credenciales acá arriba.
        </p>
      </div>
    </Seccion>
  );
}
