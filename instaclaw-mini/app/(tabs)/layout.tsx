import TabBar from "@/components/tab-bar";
import PageTransition from "@/components/page-transition";

export default function TabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-[100dvh] flex-col">
      <div className="scroll-area flex flex-col">
        <PageTransition>{children}</PageTransition>
      </div>
      <TabBar />
    </div>
  );
}
