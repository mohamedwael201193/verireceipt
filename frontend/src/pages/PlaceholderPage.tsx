export default function PlaceholderPage({
  kicker,
  title,
  note,
}: {
  kicker: string;
  title: string;
  note: string;
}) {
  return (
    <main className="container page-placeholder">
      <p className="kicker">{kicker}</p>
      <h1 className="sec-h2">{title}</h1>
      <p className="placeholder-note">
        <span className="mono placeholder-badge">PLACEHOLDER</span> {note}
      </p>
    </main>
  );
}
