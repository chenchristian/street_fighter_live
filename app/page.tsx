import Link from "next/link";

export default function MenuPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-black">
      {/* Background gradient */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(220,38,38,0.15)_0%,_transparent_70%)]" />

      {/* Title */}
      <div className="relative z-10 flex flex-col items-center gap-10 px-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-red-500">
            Computer Vision Fighting Game
          </p>
          <h1 className="text-6xl font-black uppercase tracking-tight text-white sm:text-8xl">
            Street Fighter
            <span className="block text-red-500">Live</span>
          </h1>
        </div>

        {/* Move list */}
        <div className="flex flex-wrap justify-center gap-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
          {[
            "Jab", "Cross", "Lead Hook", "Rear Hook",
            "Uppercut", "Side Kick", "Hadouken", "Shoryuken",
          ].map((move) => (
            <span key={move} className="rounded border border-zinc-800 px-2 py-1">
              {move}
            </span>
          ))}
        </div>

        {/* Play button */}
        <Link
          href="/game"
          className="group relative mt-4 inline-flex items-center gap-3 border-2 border-red-500 bg-transparent px-12 py-5 text-lg font-black uppercase tracking-widest text-red-500 transition-all duration-150 hover:bg-red-500 hover:text-black"
        >
          <span>Play</span>
          <svg
            className="h-5 w-5 transition-transform duration-150 group-hover:translate-x-1"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </Link>

        {/* Setup instructions */}
        <div className="mt-2 max-w-sm text-center text-xs text-zinc-600">
          <p>Requires a webcam. Stand 6–8 feet back so your full body is visible.</p>
          <p className="mt-1">Best on desktop Chrome or Firefox.</p>
        </div>
      </div>

      {/* Bottom credit */}
      <p className="absolute bottom-6 text-xs text-zinc-700">
        Built with MediaPipe · PyTorch LSTM · PixiJS
      </p>
    </main>
  );
}
