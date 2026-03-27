export default function HomeLoading() {
  return (
    <div className="flex flex-col gap-4 p-4 pb-6 animate-pulse">
      {/* Agent card skeleton */}
      <div className="glass-card rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="h-5 w-24 rounded bg-white/[0.06]" />
          <div className="h-6 w-16 rounded-full bg-white/[0.06]" />
        </div>
        <div className="rounded-xl bg-white/[0.03] p-4 mb-4">
          <div className="h-4 w-16 rounded bg-white/[0.06] mb-2" />
          <div className="h-8 w-12 rounded bg-white/[0.06] mb-2" />
          <div className="h-2 w-full rounded-full bg-white/[0.06]" />
        </div>
        <div className="flex gap-3">
          <div className="flex-1 rounded-xl bg-white/[0.03] h-16" />
          <div className="flex-1 rounded-xl bg-white/[0.03] h-16" />
        </div>
      </div>
      {/* Chat button skeleton */}
      <div className="flex gap-3">
        <div className="flex-1 h-12 rounded-2xl bg-white/[0.06]" />
        <div className="h-12 w-14 rounded-2xl bg-white/[0.06]" />
      </div>
    </div>
  );
}
