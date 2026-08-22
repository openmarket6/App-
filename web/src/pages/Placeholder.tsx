export default function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="card card-pad mt-6 text-sm text-ink-soft">Under construction.</div>
    </div>
  );
}
