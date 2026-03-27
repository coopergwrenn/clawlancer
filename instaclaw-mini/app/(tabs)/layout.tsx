import TabBar from "@/components/tab-bar";

export default function TabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-[100dvh] flex-col">
      <div className="scroll-area">{children}</div>
      <TabBar />
    </div>
  );
}
