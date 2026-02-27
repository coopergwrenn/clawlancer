import {
  Music,
  Palette,
  Video,
  Camera,
  Pen,
  Paintbrush,
  Image,
  Mic,
  Film,
  Wand2,
  Mail,
  BarChart3,
  Search,
  FileText,
  Calendar,
  ClipboardList,
  Clock,
  BookOpen,
  ListChecks,
  BrainCircuit,
  ShoppingCart,
  Package,
  DollarSign,
  Receipt,
  Store,
  Truck,
  CreditCard,
  PieChart,
  MessageCircle,
  AtSign,
  Share2,
  Heart,
  Users,
  Globe,
  Megaphone,
  Rss,
  Code,
  Terminal,
  Shield,
  Bug,
  Database,
  GitBranch,
  Cpu,
  Server,
  Zap,
  Repeat,
  Bot,
  Workflow,
  Cog,
  RefreshCw,
  Languages,
  MessageSquare,
  Phone,
  Headphones,
  Send,
  type LucideIcon,
} from "lucide-react";

export const CATEGORY_COLORS: Record<string, string> = {
  creative: "#E87461",
  productivity: "#4A90D9",
  commerce: "#4CAF7D",
  social: "#9B6DD7",
  developer: "#2BB5A0",
  automation: "#E5A13B",
  communication: "#5A8FA5",
};

const CATEGORY_FALLBACK_ICONS: Record<string, LucideIcon> = {
  creative: Wand2,
  productivity: ClipboardList,
  commerce: Store,
  social: Globe,
  developer: Code,
  automation: Zap,
  communication: MessageSquare,
};

const KEYWORD_RULES: [RegExp, LucideIcon][] = [
  // Creative
  [/music|audio|sound|spotify|beat/i, Music],
  [/design|brand|logo|graphic/i, Palette],
  [/video|film|youtube|stream/i, Video],
  [/photo|camera|portrait/i, Camera],
  [/writ|blog|article|copy|content/i, Pen],
  [/paint|illustrat|draw|art/i, Paintbrush],
  [/image|photo edit|thumbnail/i, Image],
  [/podcast|voice|record/i, Mic],
  [/animat|motion|vfx/i, Film],
  [/game|sprite|asset/i, Wand2],

  // Productivity
  [/email|mail|inbox|newsletter/i, Mail],
  [/analytics|report|chart|dashboard/i, BarChart3],
  [/seo|search engine|keyword/i, Search],
  [/document|pdf|note/i, FileText],
  [/calendar|schedule|meeting|appoint/i, Calendar],
  [/task|todo|project manage/i, ListChecks],
  [/time|track|pomodoro/i, Clock],
  [/research|learn|study/i, BookOpen],
  [/ai|machine learn|neural|gpt/i, BrainCircuit],
  [/data|csv|spreadsheet/i, PieChart],

  // Commerce
  [/shop|store|ecommerce|product/i, ShoppingCart],
  [/inventor|stock|warehouse/i, Package],
  [/price|financ|money|revenue/i, DollarSign],
  [/invoice|bill|receipt/i, Receipt],
  [/ship|deliver|fulfil|logistic/i, Truck],
  [/pay|checkout|stripe|subscri/i, CreditCard],

  // Social
  [/discord|bot manage/i, MessageCircle],
  [/twitter|tweet|x\.com/i, AtSign],
  [/social|post|share|viral/i, Share2],
  [/like|follow|engag|influenc/i, Heart],
  [/communit|member|group/i, Users],
  [/market|advertis|promot|campaign/i, Megaphone],
  [/feed|rss|aggregat/i, Rss],

  // Developer
  [/code|program|develop|script/i, Code],
  [/terminal|cli|command|shell/i, Terminal],
  [/secur|audit|vulnerab|pen.?test/i, Shield],
  [/bug|debug|test|qa/i, Bug],
  [/database|sql|postgres|mongo/i, Database],
  [/git|version|deploy|ci.?cd/i, GitBranch],
  [/api|endpoint|webhook|rest/i, Server],
  [/hardware|iot|embed/i, Cpu],

  // Automation
  [/automat|zapier|trigger|make\.com/i, Zap],
  [/schedul|recurr|cron|repeat/i, Repeat],
  [/bot|agent|assist/i, Bot],
  [/workflow|pipeline|orchestrat/i, Workflow],
  [/config|setting|setup/i, Cog],
  [/sync|mirror|replicate/i, RefreshCw],

  // Communication
  [/translat|language|locali/i, Languages],
  [/chat|messag|convers/i, MessageSquare],
  [/call|phone|voip/i, Phone],
  [/support|help desk|ticket/i, Headphones],
  [/send|notif|alert|push/i, Send],
];

export function resolveSkillOrb(
  name: string,
  category: string
): { color: string; icon: LucideIcon } {
  const cat = category.toLowerCase();
  const color = CATEGORY_COLORS[cat] ?? "#888888";

  // Try keyword match against the skill name
  for (const [pattern, icon] of KEYWORD_RULES) {
    if (pattern.test(name)) {
      return { color, icon };
    }
  }

  // Fall back to category default icon
  const icon = CATEGORY_FALLBACK_ICONS[cat] ?? Wand2;
  return { color, icon };
}
