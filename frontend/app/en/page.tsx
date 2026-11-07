import type { Metadata } from "next";
import { Suspense } from "react";
import { Catalog, CatalogLoading } from "../components/catalog";

export const metadata: Metadata = {
  title: "InBlack Top-Up | Game top-ups, made easy",
  description: "Find your pack, pay securely, and track your game top-up in real time.",
  alternates: { canonical: "/en", languages: { th: "/th", en: "/en" } },
  openGraph: { title: "InBlack Top-Up", locale: "en_US", type: "website" }
};

export default function EnglishStorePage() {
  return <Suspense fallback={<CatalogLoading locale="en" />}><Catalog locale="en" /></Suspense>;
}
