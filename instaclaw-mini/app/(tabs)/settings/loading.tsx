export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-4 p-4 pb-8 animate-pulse">
      <div className="h-6 w-20 rounded bg-white/[0.06] mb-1" />
      {/* Account skeleton */}
      <div className="glass-card rounded-2xl p-4">
        <div className="h-3 w-16 rounded bg-white/[0.06] mb-3" />
        <div className="rounded-xl bg-white/[0.03] h-14 mb-2" />
        <div className="rounded-xl bg-white/[0.03] h-14" />
      </div>
      {/* Subscription skeleton */}
      <div className="glass-card rounded-2xl p-4">
        <div className="h-3 w-24 rounded bg-white/[0.06] mb-3" />
        <div className="rounded-xl bg-white/[0.03] h-16 mb-3" />
        <div className="flex gap-2">
          <div className="flex-1 h-10 rounded-xl bg-white/[0.06]" />
          <div className="flex-1 h-10 rounded-xl bg-white/[0.06]" />
        </div>
      </div>
    </div>
  );
}
