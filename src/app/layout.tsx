import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChurnSave — PayPal churn-recovery agent",
  description:
    "Autonomous agent that detects PayPal subscription churn, analyzes buyer history, and recovers revenue with personalized offers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-200 antialiased">
        <header className="border-b border-slate-800">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-2 text-lg font-bold text-white">
              <span className="rounded-lg bg-blue-600 px-2 py-0.5">ChurnSave</span>
              <span className="text-sm font-normal text-slate-400">PayPal churn-recovery agent</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-400">
              <a href="/api/agent/tools" className="hover:text-white">Agent tools</a>
              <a
                href="https://github.com/skye-cqu/churnsave"
                className="hover:text-white"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
