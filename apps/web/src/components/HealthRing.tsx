import { bandaDeSalud } from "../salud.ts";

type Props = {
  score: number;
  size?: number;
  /** Muestra la etiqueta debajo del numero. */
  conEtiqueta?: boolean;
};

/**
 * Anillo del health score. El numero nunca va sin su etiqueta textual: el color
 * solo no es accesible y un 72 sin contexto no dice nada (doc 15).
 */
export function HealthRing({ score, size = 46, conEtiqueta = false }: Props) {
  const { color, etiqueta } = bandaDeSalud(score);
  const radio = size / 2 - 4.5;
  const circunferencia = 2 * Math.PI * radio;
  const offset = circunferencia * (1 - Math.max(0, Math.min(100, score)) / 100);

  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5">
      <div className="relative grid place-items-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radio}
            fill="none"
            strokeWidth={3}
            className="stroke-white/8"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radio}
            fill="none"
            strokeWidth={3}
            stroke={color}
            strokeLinecap="round"
            strokeDasharray={circunferencia}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 700ms cubic-bezier(0.16,1,0.3,1)" }}
          />
        </svg>
        <span
          className="absolute font-semibold tabular-nums"
          style={{ fontSize: size * 0.32, color }}
        >
          {score}
        </span>
      </div>
      {conEtiqueta ? (
        <span className="text-[11px] font-medium" style={{ color }}>
          {etiqueta}
        </span>
      ) : null}
    </div>
  );
}
