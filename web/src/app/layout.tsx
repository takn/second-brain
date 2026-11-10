import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
import { getUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "second-brain",
  description: "An LLM-maintained knowledge base and single pane of glass for engineering orgs",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getUser();
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Figtree:wght@300..700&family=Roboto:ital,wght@0,300..700;1,300..700&family=Roboto+Mono:ital,wght@0,300..700;1,300..700&family=Zilla+Slab:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="packets light">
        <Shell user={user}>{children}</Shell>
      </body>
    </html>
  );
}
