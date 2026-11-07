import type { Metadata } from "next";
import SiteHeader from "./components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "InBlack Top-Up | Game top-ups, made easy",
    template: "%s · InBlack Top-Up"
  },
  description: "Fast, secure game top-ups with real-time order tracking.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000")
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th">
      <body>
        <SiteHeader />
        {children}
        <footer className="site-footer">
          <span>© 2026 InBlack Top-Up</span>
          <span>เติมเกมง่าย ปลอดภัย ได้ไว</span>
        </footer>
      </body>
    </html>
  );
}
