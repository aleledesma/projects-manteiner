import { useCallback, useEffect, useState } from "react";

import { api, ApiError, type Me } from "./api.ts";

type State =
  | { estado: "cargando" }
  | { estado: "listo"; me: Me }
  | { estado: "error"; error: ApiError };

/**
 * `GET /api/me`: usuario + estado de onboarding.
 *
 * `recargar` se llama después de cada paso completado. El estado de onboarding
 * vive en el servidor, no en el cliente: así el flujo sobrevive a una recarga,
 * al redirect de la GitHub App y a que el usuario cierre la pestaña durante el
 * device flow.
 */
export function useMe() {
  const [state, setState] = useState<State>({ estado: "cargando" });

  const recargar = useCallback(async () => {
    try {
      setState({ estado: "listo", me: await api.get<Me>("/api/me") });
    } catch (error) {
      setState({
        estado: "error",
        error: error instanceof ApiError ? error : new ApiError("INTERNAL_ERROR", "Error inesperado.", 0),
      });
    }
  }, []);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  return { state, recargar };
}
