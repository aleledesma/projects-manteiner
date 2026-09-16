const SIZES = {
  sm: { box: "size-6 rounded-[7px]", glyph: 11 },
  md: { box: "size-8 rounded-[10px]", glyph: 14 },
  lg: { box: "size-10 rounded-xl", glyph: 17 },
} as const;

type Props = {
  size?: keyof typeof SIZES;
  className?: string;
};

/** Marca de Manteiner: cuadrado mate con un anillo. Plano a propósito, sin glow. */
export function BrandMark({ size = "md", className = "" }: Props) {
  const { box, glyph } = SIZES[size];

  return (
    <div
      className={`grid shrink-0 place-items-center bg-[#4e548c] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] ${box} ${className}`}
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 20 20"
        fill="none"
        stroke="rgb(255 255 255 / 0.9)"
        strokeWidth={1.7}
        aria-hidden="true"
      >
        <circle cx="10" cy="10" r="6" />
      </svg>
    </div>
  );
}
