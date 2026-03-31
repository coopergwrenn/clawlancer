import TabBar from "@/components/tab-bar";

export default function TabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative h-[100dvh]">
      <div className="scroll-area h-full" style={{ paddingBottom: "76px" }}>
        {children}
      </div>
      <TabBar />
    </div>
  );
}
