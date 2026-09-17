const UNIDADES: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3_600_000],
  ["month", 30 * 24 * 3_600_000],
  ["day", 24 * 3_600_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const formato = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

/** "hace 4 horas", "en 3 días". Devuelve "recién" por debajo del minuto. */
export function relativo(timestamp: number, ahora = Date.now()): string {
  const diferencia = timestamp - ahora;
  const magnitud = Math.abs(diferencia);
  for (const [unidad, ms] of UNIDADES) {
    if (magnitud >= ms) return formato.format(Math.round(diferencia / ms), unidad);
  }
  return diferencia < 0 ? "recién" : "en instantes";
}
