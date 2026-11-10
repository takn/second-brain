import { Activity, Brain, FileText, GitBranch, LayoutDashboard, ListChecks, MessageCircleQuestion, ScrollText, Search, Server } from "lucide-react";
import type { ReactNode } from "react";
import type { User } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Portfolio", icon: LayoutDashboard },
  { href: "/ask", label: "Ask the brain", icon: MessageCircleQuestion },
  { href: "/workflows", label: "Workflows", icon: GitBranch },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/decisions", label: "Decisions", icon: ScrollText },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/search", label: "Search", icon: Search },
  { href: "/untracked", label: "Untracked work", icon: ListChecks },
  { href: "/status", label: "System status", icon: Server },
];

export function Shell({ user, children }: { user: User; children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <a className="shell-logo" href="/">
          <Brain size={26} strokeWidth={1.75} />
          <span>second-brain</span>
        </a>
        <nav>
          {NAV.map(({ href, label, icon: Icon }) => (
            <a key={href} className="shell-nav-item" href={href}>
              <Icon size={17} strokeWidth={1.75} />
              {label}
            </a>
          ))}
        </nav>
        <div className="shell-user">
          <div className="shell-user-email" title={user.email}>
            {user.email}
          </div>
          <span className={`role-chip role-${user.role.toLowerCase()}`}>{user.role}</span>
        </div>
      </aside>
      <main className="shell-main">{children}</main>
    </div>
  );
}
