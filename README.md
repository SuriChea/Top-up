# InBlack Top-Up

โปรเจกต์ตัวอย่างสำหรับระบบเติมเงิน/สินค้าเกมที่ใช้ Docker Compose ประกอบด้วยรายการสินค้าและขั้นตอนชำระเงินที่ใช้ PostgreSQL, webhook การชำระเงินแบบลงลายมือชื่อ, worker แยกสำหรับดำเนินการเติมสินค้า, ตัวจำลองผู้ให้บริการชำระเงินและเกม และระบบติดตามคำสั่งซื้อแบบเรียลไทม์

## เริ่มใช้งานในเครื่อง

1. คัดลอก `.env.example` เป็น `.env` ตั้งค่า `AUTH_SECRET` และ `TRACKING_TOKEN_SECRET` ให้เป็นค่าที่ไม่ซ้ำกัน แล้วเพิ่มอีเมลผู้ดูแลระบบที่เชื่อถือได้ใน `ADMIN_EMAILS` ค่า secret ตัวอย่างใช้สำหรับการพัฒนาเท่านั้น
2. รัน `docker compose up --build`
3. เปิดหน้าร้านที่ <http://localhost:3000>, API ที่ <http://localhost:8080> และกล่องจดหมาย OTP ที่ <http://localhost:8025>
4. เข้าสู่ระบบที่ `/login` ข้อความ OTP ในเครื่องจะส่งไปยัง Mailpit อีเมลที่อยู่ใน `ADMIN_EMAILS` จะได้รับสิทธิ์ผู้ดูแลระบบ ส่วนอีเมลอื่นจะเป็นลูกค้า
5. หากต้องการกระทบยอด ให้เข้าสู่หน้า `/admin` ด้วยบัญชีผู้ดูแลระบบ แล้วอัปโหลดไฟล์ CSV ที่มีคอลัมน์ `event_id,order_id,amount_satang,currency,type` จำนวนเงินเป็นจำนวนเต็มหน่วยสตางค์ ประเภทเหตุการณ์ต้องเป็น `payment.succeeded`, `payment.failed` หรือ `payment.refunded`

ข้อมูล PostgreSQL และ Redis จัดเก็บใน Docker volume แบบตั้งชื่อ ข้อมูลสินค้าเริ่มต้นและรหัสส่วนลดจะถูกเพิ่มเมื่อสร้าง volume ฐานข้อมูลครั้งแรก หากต้องการเริ่ม seed ใหม่ตั้งแต่ต้น ให้หยุดระบบก่อน แล้วลบเฉพาะ volume `postgres-data` ของโปรเจกต์นี้

### เครื่องมือฐานข้อมูล

ฐานข้อมูลทำงานใน Compose service ชื่อ `postgres`; ไฟล์ข้อมูลอยู่ใน Docker named volume `postgres-data` ไม่ได้อยู่ในโฟลเดอร์ PostgreSQL บนเครื่อง เปิดเครื่องมือเสริมด้วยคำสั่ง:

```powershell
docker compose --profile tools up -d pgadmin prisma-studio
```

- Prisma Studio: <http://localhost:5555>
- pgAdmin: <http://localhost:5050> (ใช้ `PGADMIN_DEFAULT_EMAIL` และ `PGADMIN_DEFAULT_PASSWORD` จาก `.env`)

ใน pgAdmin ให้ลงทะเบียน server โดยใช้ host `postgres`, port `5432`, maintenance database `inblack`, username `inblack` และรหัสผ่านฐานข้อมูลในเครื่อง `inblack_dev` หากเชื่อมต่อจาก pgAdmin ที่ติดตั้งบน Windows โดยตรง ให้ใช้ host `localhost` และ port `5433` ดูและแก้ไขแถวข้อมูลได้ที่ **Databases → inblack → Schemas → public → Tables** โมเดล Prisma อยู่ใน `backend/prisma/schema.prisma`; การเปลี่ยนแปลงฐานข้อมูลควรทำผ่าน SQL migration ใน `backend/migrations` ไม่ใช่ `prisma db push`

ค่า PostgreSQL และ SMTP เริ่มต้นใช้สำหรับพัฒนาในเครื่อง หากต้องการรับ OTP ที่กล่องอีเมลจริง ให้ตั้งค่า SMTP host, port, username, app password, secure mode และ sender ของผู้ให้บริการในไฟล์ `.env` ที่ไม่ถูกติดตามด้วย Git แล้วสร้าง API containers ใหม่:

```powershell
docker compose up -d --force-recreate api-1 api-2
```

ตัวอย่างเช่น Gmail ต้องใช้ app password โดยทั่วไปใช้ `smtp.gmail.com`, port `587` และ `MAIL_SECURE=false` เก็บข้อมูล SMTP ไว้ใน `.env` เท่านั้น โดย Mailpit ยังคงเป็นกล่องจดหมายเริ่มต้นสำหรับการทดสอบในเครื่อง

กฎการซื้อถูกบังคับใช้ภายใน transaction ของ API: Monthly Pass ซื้อได้หนึ่งครั้งต่ออีเมล, Limited Skin ซื้อได้สองครั้งต่ออีเมลและรวมทั้งระบบ 100 คำสั่งซื้อ, ส่วน SAVE10 ใช้ได้ทั้งหมด 10 ครั้งที่ยังใช้งานอยู่และหนึ่งครั้งต่ออีเมล คำสั่งซื้อที่หมดอายุหรือชำระเงินไม่สำเร็จจะคืนโควตา ส่วนคำสั่งซื้อที่ชำระแล้วหรือคืนเงินแล้วจะยังนับรวมในขีดจำกัดต่ออีเมล

## บริการ

| บริการ | หน้าที่ |
| --- | --- |
| `web` | หน้าร้าน Next.js |
| `proxy` | Nginx reverse proxy แบบ round-robin สำหรับ API |
| `api-1`, `api-2` | API REST แบบ stateless จำนวนสอง replica |
| `worker` | ตรวจคำสั่งซื้อหมดอายุ ลองทำงานซ้ำ และดำเนินการเติมเกม |
| `postgres`, `redis` | จัดเก็บข้อมูลระบบแบบถาวรและกระจายเหตุการณ์/จำกัดอัตราคำขอระหว่าง replica |
| `mock-pay`, `mock-game` | ตัวจำลองผู้ให้บริการในเครื่อง |
| `mailpit` | กล่องจดหมาย SMTP ในเครื่องสำหรับรหัสเข้าสู่ระบบและทดสอบ OTP |
| `pgadmin`, `prisma-studio` | เครื่องมือฐานข้อมูลเสริมภายใต้ profile `tools` |

## ทดสอบ

รันทดสอบ backend unit ด้วย `npm test --prefix backend` ส่วน lint, type-check และ production build ของ frontend ใช้ `npm run lint --prefix frontend`, `npx --prefix frontend tsc --noEmit -p frontend/tsconfig.json --incremental false` และ `npm run build --prefix frontend` ตามลำดับ Integration tests ที่ใช้ PostgreSQL/Redis จะทำงานเมื่อกำหนด `RUN_INTEGRATION_TESTS=1` และชี้ `API_BASE_URL`, `DATABASE_URL` และ `MOCK_PAY_PUBLIC_URL` ไปยัง Compose stack สำหรับทดสอบโดยเฉพาะ เพราะชุดทดสอบจะล้างข้อมูลในฐานข้อมูลนั้น หากต้องการทดสอบ E2E บนเบราว์เซอร์ ให้เริ่ม Compose stack โดยกำหนด `ADMIN_EMAILS` ติดตั้ง Chromium ด้วย `npx --prefix frontend playwright install chromium` แล้วรัน `npm run test:e2e --prefix frontend`

สำหรับวัดการแบ่งหน้ารายการคำสั่งซื้อกับข้อมูล 100,000 รายการ ให้รัน `docker compose exec -e BENCHMARK_ADMIN_EMAIL=admin@example.com api-1 npm run seed:orders -- 100000` แล้วตามด้วย `docker compose exec -e API_BASE_URL=http://proxy:8080 -e BENCHMARK_ADMIN_EMAIL=admin@example.com api-1 npm run benchmark:admin-orders` ผลลัพธ์รายงาน median, p95 และค่าสูงสุดเป็นมิลลิวินาที

## ความสามารถที่ทำแล้วและข้อจำกัดที่ทราบ

- แสดงรายการสินค้าและค้นหาสินค้า โดยใช้ราคาเป็นจำนวนเต็มหน่วยสตางค์
- คำนวณราคาจากฝั่งเซิร์ฟเวอร์สำหรับค่าธรรมเนียม PromptPay, TrueMoney และบัตร, จำกัดส่วนลด, คำนวณ VAT และสร้างรหัสคำสั่งซื้อที่มี checksum แบบสุ่ม
- สร้างคำสั่งซื้อหลาย SKU ภายใน transaction, จองสต็อก, รองรับการเรียกซ้ำด้วย idempotency key และจองคูปอง
- ตรวจสอบลายเซ็น HMAC ของ webhook จาก raw body, ป้องกันเหตุการณ์ซ้ำ, ตรวจสอบสต็อกเมื่อชำระเงินล่าช้า, บันทึกเหตุการณ์คำสั่งซื้อ และส่ง SSE ข้าม API replica
- ใช้ worker แยกต่างหากพร้อม retry/backoff, กู้คืนงานค้าง, ตรวจสอบสถานะ mock game ก่อน retry, สถานะ dead-letter และงานคืนเงินอัตโนมัติเมื่องานหมดจำนวนครั้งหรือดำเนินการไม่ได้
- แค็ตตาล็อก ภาษาไทย/อังกฤษที่ตอบสนองต่อหน้าจอ, checkout, ตัวควบคุมจำลองการชำระเงิน, tracking ที่ตรวจ checksum, อัปเดต SSE, metadata, กฎ sitemap/robots และ CSP ที่ใช้ nonce
- เข้าสู่ระบบด้วยอีเมล OTP แบบใช้ครั้งเดียวและหมดอายุ พร้อมจำกัดจำนวนครั้ง/อัตราคำขอ, session token แบบ opaque ที่เพิกถอนได้, HttpOnly cookie และ logout
- ประวัติการซื้อของลูกค้า คำขอคืนเงินที่ผู้ดูแลอนุมัติได้ และขีดจำกัดการซื้อที่บังคับใช้ใน server
- ตรวจสอบ role ลูกค้า/ผู้ดูแล ผู้ดูแลจัดการราคา/สต็อก/สถานะสินค้า ตรวจสอบคำสั่งซื้อ และเข้าคิวคืนเงินพร้อม audit trail
- กระทบยอด CSV กับเหตุการณ์ชำระเงินภายใน โดยบันทึกแถวที่ตรงกัน/ขาดหาย/ไม่ตรงกันไว้เพื่อตรวจสอบ
- Backend unit/integration tests สำหรับ purchase limits, idempotency, concurrency, refunds และ RBAC, Playwright browser E2E coverage และ GitHub Actions workflow สำหรับ Compose stack

ก่อนส่งงานจริง ควรตรวจผล benchmark เทียบกับเกณฑ์ p95 ในเอกสารโจทย์ และตรวจทาน OpenAPI กับทุก endpoint ที่เปิดใช้จริง

กำหนดกล่องอีเมลผู้ดูแลระบบที่เชื่อถือได้อย่างน้อยหนึ่งรายการใน `ADMIN_EMAILS` ก่อนเข้าสู่ระบบ การนำอีเมลออกจาก allowlist จะเพิกถอนสิทธิ์ผู้ดูแลเมื่อมีคำขอ API ครั้งถัดไป ตั้ง `COOKIE_SECURE=true` เมื่อให้บริการผ่าน HTTPS หากใช้ SMTP ภายนอก ให้กำหนด `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_SECURE` และ `MAIL_FROM`

## ไฟล์สำคัญ

- `backend/schema.sql`: ตาราง PostgreSQL และข้อมูล seed
- `backend/server.js`: REST API และ payment webhook
- `backend/migrations/002_auth_admin_reconciliation.sql`: migration เพิ่มเติมสำหรับ auth, audit และ reconciliation schema
- `backend/migrations/003_purchase_limits.sql` ถึง `backend/migrations/005_backend_requirements.sql`: ขีดจำกัดการซื้อ, คำขอคืนเงิน และข้อกำหนดฝั่ง backend
- `backend/scripts/seed-orders.js`, `backend/scripts/benchmark-admin-orders.js`: สร้างข้อมูลและวัด p95 ของหน้ารายการผู้ดูแล
- `backend/prisma/schema.prisma`: โมเดล Prisma Studio ที่ map กับตาราง PostgreSQL
- `backend/auth.js`, `backend/reconciliation.js`: ส่วนประกอบ OTP/session และตัวแยกวิเคราะห์/เปรียบเทียบ CSV สำหรับ settlement
- `backend/worker.js`: worker ตรวจหมดอายุและดำเนินการเติมสินค้า
- `backend/mock.js`: ตัวจำลองผู้ให้บริการชำระเงินและเกม
- `docker-compose.yml`: โครงสร้างบริการหลายตัวสำหรับเครื่อง local
- `openapi.yaml`: สัญญา API สาธารณะที่ implement แล้ว
- `frontend/e2e/`: สถานการณ์ทดสอบ end-to-end ของ Playwright
- `.github/workflows/ci.yml`: lint, type-check, build, unit tests และ Compose-backed E2E
- `ARCHITECTURE.md`, `RUNBOOK.md`, `docs/adr/`: บันทึกการออกแบบและการปฏิบัติการ
