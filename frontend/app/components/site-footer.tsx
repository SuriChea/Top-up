"use client";

import { useLocale } from "./locale";

export default function SiteFooter() {
  const english = useLocale() === "en";
  return (
    <footer className="site-footer">
      <span>© 2026 InBlack Top-Up</span>
      <span>{english ? "Top up with ease. Securely and quickly." : "เติมเกมง่าย ปลอดภัย ได้ไว"}</span>
    </footer>
  );
}
