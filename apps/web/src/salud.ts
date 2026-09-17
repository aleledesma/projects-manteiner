/**
 * Bandas del health score (doc 15).
 *
 * El numero nunca va solo: el color no es accesible por si mismo y un 72 sin
 * contexto no dice nada. Por eso cada banda trae su etiqueta.
 */

export type Banda = { color: string; etiqueta: string };

const BANDAS: { desde: number; banda: Banda }[] = [
  { desde: 90, banda: { color: "#7CB194", etiqueta: "Impecable" } },
  { desde: 75, banda: { color: "#93B489", etiqueta: "Sano" } },
  { desde: 50, banda: { color: "#CFA469", etiqueta: "Atención" } },
  { desde: 0, banda: { color: "#CF7C83", etiqueta: "Crítico" } },
];

export function bandaDeSalud(score: number): Banda {
  return BANDAS.find(({ desde }) => score >= desde)!.banda;
}

export const COLOR_SEVERIDAD: Record<string, string> = {
  high: "#cf7c83",
  medium: "#cfa469",
  low: "#7fa3c4",
  info: "#78818f",
};

export const NOMBRE_SEVERIDAD: Record<string, string> = {
  high: "Alta",
  medium: "Media",
  low: "Baja",
  info: "Informativa",
};

/** Plural del recuento por severidad, para los pies de tarjeta. */
export const PLURAL_SEVERIDAD: Record<string, [string, string]> = {
  high: ["alto", "altos"],
  medium: ["medio", "medios"],
  low: ["bajo", "bajos"],
  info: ["informativo", "informativos"],
};
