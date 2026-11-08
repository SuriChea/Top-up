"use client";

import { usePathname } from "next/navigation";

export type Locale = "en" | "th";

export function useLocale(): Locale {
  const pathname = usePathname();
  return pathname.startsWith("/en") ? "en" : "th";
}

export function localizedPath(path: string, locale: Locale): string {
  const unprefixedPath = path.replace(/^\/(en|th)(?=\/|$)/, "") || "/";
  if (unprefixedPath === "/") return locale === "en" ? "/en" : "/th";
  return `/${locale}${unprefixedPath}`;
}

export function changeLocale(pathname: string, locale: Locale, navigate: (href: string) => void): void {
  const targetLocale = locale === "en" ? "th" : "en";
  const unprefixedPath = pathname.replace(/^\/(en|th)(?=\/|$)/, "") || "/";
  document.cookie = `inblack_locale=${targetLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  navigate(`${localizedPath(unprefixedPath, targetLocale)}${window.location.search}`);
}
