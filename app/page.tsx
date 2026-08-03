import Link from "next/link";

const MOVES = [
  "Jab", "Cross", "Lead Hook", "Rear Hook",
  "Uppercut", "Side Kick", "Hadouken", "Shoryuken",
];

export default function MenuPage() {
  return (
    <main
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 34,
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <p
          style={{
            fontSize: 10,
            letterSpacing: ".34em",
            textTransform: "uppercase",
            color: "var(--steel)",
          }}
        >
          Computer Vision Fighting Game
        </p>
        <h1
          style={{
            fontSize: "clamp(34px, 7vw, 64px)",
            lineHeight: 1,
            fontWeight: 800,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            color: "var(--paper)",
            textShadow: "0 0 28px rgba(255,190,90,.28)",
          }}
        >
          Street Fighter
          <span style={{ display: "block", color: "var(--gold)" }}>Live</span>
        </h1>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 6,
          maxWidth: 520,
        }}
      >
        {MOVES.map(move => (
          <span
            key={move}
            style={{
              border: "1px solid var(--border)",
              padding: "4px 8px",
              fontSize: 9,
              letterSpacing: ".16em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            {move}
          </span>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14 }}>
        <Link href="/game" className="menu-btn">
          1P vs CPU
        </Link>
        <Link href="/versus" className="menu-btn secondary">
          2P Online
        </Link>
      </div>

      <div style={{ fontSize: 10, lineHeight: 1.8, color: "var(--muted)", maxWidth: 380 }}>
        <p>Requires a webcam. Stand 6–8 feet back so your full body is visible.</p>
        <p>Keyboard debug controls work without one. Best on desktop Chrome.</p>
      </div>

      <p
        style={{
          position: "absolute",
          bottom: 18,
          fontSize: 9,
          letterSpacing: ".18em",
          textTransform: "uppercase",
          color: "#2f2a3d",
        }}
      >
        MediaPipe · ONNX Runtime Web · Canvas 2D · WebRTC
      </p>
    </main>
  );
}
