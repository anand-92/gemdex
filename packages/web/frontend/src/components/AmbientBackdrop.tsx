/**
 * Fixed, non-interactive atmosphere behind the whole console: two slow-drifting
 * light sources, a dot grid that fades out, and a film of noise so the flat
 * near-black never looks like plain #000.
 */
export function AmbientBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute inset-0 bg-canvas" />

      <div className="absolute -left-40 -top-52 h-[620px] w-[620px] animate-drift rounded-full bg-[radial-gradient(circle,rgba(108,140,255,0.18),transparent_62%)] blur-[10px]" />
      <div className="absolute -right-52 top-1/3 h-[560px] w-[560px] animate-drift rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.12),transparent_60%)] blur-[10px] [animation-delay:-8s]" />
      <div className="absolute -bottom-64 left-1/3 h-[520px] w-[520px] animate-drift rounded-full bg-[radial-gradient(circle,rgba(61,220,151,0.07),transparent_62%)] blur-[10px] [animation-delay:-14s]" />

      <div className="dotgrid absolute inset-0 opacity-60 [mask-image:radial-gradient(120%_90%_at_50%_0%,#000_10%,transparent_75%)]" />
      <div className="noise absolute inset-0 opacity-[0.035] mix-blend-soft-light" />
    </div>
  );
}
