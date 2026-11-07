# SEO notes

- Thai and English catalog URLs are `/th` and `/en`; both declare reciprocal language alternates.
- The sitemap includes only those public catalog pages.
- `robots.txt` disallows checkout, tracking, customer-order, and admin paths. Tracking and checkout set `noindex`.
- Product names and prices render as text from the API. Product JSON-LD and dynamic Open Graph images are not implemented yet.
- The catalog currently fetches fresh product data at request time. A production deployment should add bounded ISR for product metadata while keeping flash-sale stock fresh.
