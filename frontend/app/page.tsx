import { Suspense } from "react";
import { Catalog, CatalogLoading } from "./components/catalog";

export default function HomePage() {
  return (
    <Suspense fallback={<CatalogLoading />}>
      <Catalog locale="th" />
    </Suspense>
  );
}
