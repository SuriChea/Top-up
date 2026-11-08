# ADR 0003: ใช้ Redis pub/sub สำหรับ event สดข้าม replica

- สถานะ: ยอมรับแล้ว
- การตัดสินใจ: บันทึก order event ลง PostgreSQL ก่อน จากนั้นเผยแพร่ ID และ payload ไปยัง Redis channel ที่กำหนดตาม order ID โดย SSE จะ subscribe ก่อน replay event จากฐานข้อมูล และตัด event ซ้ำด้วย event ID
- เหตุผล: API replica ตัวใดก็ให้บริการ tracking ได้ แม้ webhook หรือ worker event จะถูกจัดการโดยอีกตัว ฐานข้อมูลเป็นแหล่งข้อมูลสำหรับ replay หลังเชื่อมต่อใหม่
- ผลที่ตามมา: pub/sub เป็นข้อมูลชั่วคราว client จะเชื่อมต่อใหม่ด้วย `Last-Event-ID` และ replay จากตาราง event แบบ append-only ต้องมี Redis พร้อมใช้งานจึงจะรายงานสถานะ ready และส่ง event สดได้
