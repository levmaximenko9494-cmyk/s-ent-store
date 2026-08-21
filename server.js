import express from "express";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  console.error("JWT_SECRET is required");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});
const auth = (req, res, next) => {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Требуется авторизация" });
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, SECRET);

    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Недействительный токен" });
  }
};
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins(
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      notes TEXT NOT NULL,
      price INTEGER NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS products_id_seq;
  `);

  await pool.query(`
    SELECT setval(
      'products_id_seq',
      COALESCE((SELECT MAX(id) FROM products), 0) + 1,
      false
    );
  `);

  await pool.query(`
    ALTER TABLE products
    ALTER COLUMN id SET DEFAULT nextval('products_id_seq');
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      address TEXT NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'paid', 'processing', 'shipped', 'completed', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS brand TEXT,
      ADD COLUMN IF NOT EXISTS volume TEXT,
      ADD COLUMN IF NOT EXISTS sku TEXT,
      ADD COLUMN IF NOT EXISTS wholesale_price INTEGER,
      ADD COLUMN IF NOT EXISTS min_qty INTEGER;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique
    ON products(sku) WHERE sku IS NOT NULL;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'products_wholesale_price_nonnegative'
          AND conrelid = 'products'::regclass
      ) THEN
        ALTER TABLE products ADD CONSTRAINT products_wholesale_price_nonnegative
          CHECK (wholesale_price IS NULL OR wholesale_price >= 0);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'products_min_qty_positive'
          AND conrelid = 'products'::regclass
      ) THEN
        ALTER TABLE products ADD CONSTRAINT products_min_qty_positive
          CHECK (min_qty IS NULL OR min_qty > 0);
      END IF;
    END
    $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items(
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      qty INTEGER NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_requests(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT,
      comment TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const products = [
    [1,"Santal 01","woody","Сандал · Кедр · Амбра",8900,20],
    [2,"Rose No. 7","floral","Роза · Ирис · Мускус",7600,18],
    [3,"Thé Vert","fresh","Зелёный чай · Бергамот · Нероли",6900,25],
    [4,"Velours","floral","Пион · Ваниль · Белый мускус",8200,14],
    [5,"Bois Noir","woody","Ветивер · Пачули · Кожа",9400,12],
    [6,"Côte Blanche","fresh","Морская соль · Лимон · Кедр",7300,20],
    [7,"Ambre 24","unisex","Амбра · Тонка · Ладан",9700,10],
    [8,"Fleur Blanche","unisex","Жасмин · Груша · Сандал",7800,15]
  ];

  const count = (await pool.query("SELECT COUNT(*)::int AS c FROM products")).rows[0].c;
  if (!count) {
    for (const p of products) {
      await pool.query(
        `INSERT INTO products(id,name,category,notes,price,stock)
         VALUES($1,$2,$3,$4,$5,$6)`,
        p
      );
    }
  }

  const adminCount = (await pool.query("SELECT COUNT(*)::int AS c FROM admins")).rows[0].c;
  if (!adminCount) {
    const email = process.env.ADMIN_EMAIL || "admin@scent-store.ru";
    const pass = process.env.ADMIN_PASSWORD || "change-this-password";
    const hash = await bcrypt.hash(pass, 12);
    await pool.query(
      "INSERT INTO admins(email,password_hash) VALUES($1,$2)",
      [email, hash]
    );
  }
}

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use("/api/", apiLimiter);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function validateProductExtensions(product, partial = false) {
  const values = {};
  for (const field of ["brand", "volume", "sku"]) {
    if (partial && !hasOwn(product, field)) continue;
    const raw = product[field];
    if (raw != null && typeof raw !== "string") {
      return { error: `${field} должен быть строкой` };
    }
    values[field] = typeof raw === "string" ? raw.trim() || null : null;
  }

  if (!partial || hasOwn(product, "wholesale_price")) {
    const raw = product.wholesale_price;
    if (raw == null || raw === "") values.wholesale_price = null;
    else {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        return { error: "Оптовая цена должна быть целым неотрицательным числом" };
      }
      values.wholesale_price = value;
    }
  }

  if (!partial || hasOwn(product, "min_qty")) {
    const raw = product.min_qty;
    if (raw == null || raw === "") values.min_qty = null;
    else {
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: "Минимальная партия должна быть положительным целым числом" };
      }
      values.min_qty = value;
    }
  }
  return { values };
}



app.get("/api/products", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,name,category,notes,price,stock,active,
              brand,volume,sku,wholesale_price,min_qty
       FROM products WHERE active=TRUE ORDER BY id`
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.post("/api/orders", async (req, res) => {
  const { name, phone, email, address, items } = req.body || {};
  if (!name || !phone || !email || !address || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: "Заполните все поля заказа" });

  const quantities = new Map();
  for (const item of items) {
    const productId = Number(item?.productId);
    const qty = Number(item?.qty);
    if (!Number.isInteger(productId) || productId <= 0 || !Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ error: "Некорректные товар или количество" });
    }
    quantities.set(productId, (quantities.get(productId) || 0) + qty);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const checked = [];
    let total = 0;

    for (const [productId, qty] of quantities) {
      const r = await client.query(
        "SELECT id,name,price,stock FROM products WHERE id=$1 AND active=TRUE FOR UPDATE",
        [productId]
      );
      const p = r.rows[0];
      if (!p) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Товар не найден" });
      }
      if (p.stock < qty) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Недостаточно товара: ${p.name}` });
      }

      const updated = await client.query(
        "UPDATE products SET stock=stock-$1 WHERE id=$2 AND stock >= $1 RETURNING id",
        [qty, p.id]
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `Недостаточно товара: ${p.name}` });
      }

      checked.push({ ...p, qty });
      total += p.price * qty;
    }

    const order = await client.query(
      `INSERT INTO orders(customer_name,phone,email,address,total)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [name, phone, email, address, total]
    );
    const orderId = order.rows[0].id;

    for (const p of checked) {
      await client.query(
        `INSERT INTO order_items(order_id,product_id,name,price,qty)
         VALUES($1,$2,$3,$4,$5)`,
        [orderId, p.id, p.name, p.price, p.qty]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ orderId, total, status: "new" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Не удалось создать заказ" });
  } finally {
    client.release();
  }
});

app.post("/api/price-requests", async (req, res) => {
  const { name, phone, email, company, comment } = req.body || {};
  const required = [name, phone, email];
  if (required.some(value => typeof value !== "string" || !value.trim())) {
    return res.status(400).json({ error: "Укажите имя, телефон и email" });
  }
  try {
    const request = await pool.query(
      `INSERT INTO price_requests(name,phone,email,company,comment)
       VALUES($1,$2,$3,$4,$5) RETURNING id,status`,
      [
        name.trim(), phone.trim(), email.trim(),
        typeof company === "string" ? company.trim() || null : null,
        typeof comment === "string" ? comment.trim() || null : null
      ]
    );
    res.status(201).json(request.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось отправить запрос прайс-листа" });
  }
});

app.post("/api/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await pool.query("SELECT * FROM admins WHERE email=$1", [email]);
    const a = r.rows[0];
    if (!a || !(await bcrypt.compare(password || "", a.password_hash)))
      return res.status(401).json({ error: "Неверный email или пароль" });

    res.json({ token: jwt.sign({ id: a.id, email: a.email }, SECRET, { expiresIn: "8h" }) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка входа" });
  }
});

app.get("/api/admin/orders", auth, async (req, res) => {
  try {
    const orders = (await pool.query("SELECT * FROM orders ORDER BY id DESC")).rows;
    const items = (await pool.query("SELECT * FROM order_items ORDER BY id")).rows;
    const byOrder = new Map();
    for (const item of items) {
      if (!byOrder.has(item.order_id)) byOrder.set(item.order_id, []);
      byOrder.get(item.order_id).push(item);
    }
    res.json(orders.map(o => ({ ...o, items: byOrder.get(o.id) || [] })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.get("/api/admin/price-requests", auth, async (req, res) => {
  try {
    const requests = await pool.query(
      `SELECT id,name,phone,email,company,comment,status,created_at
       FROM price_requests ORDER BY created_at DESC, id DESC`
    );
    res.json(requests.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.patch("/api/admin/orders/:id", auth, async (req, res) => {
  const allowed = ["new", "paid", "processing", "shipped", "completed", "cancelled"];
  if (!allowed.includes(req.body.status))
    return res.status(400).json({ error: "Недопустимый статус" });
  try {
    await pool.query("UPDATE orders SET status=$1 WHERE id=$2", [
      req.body.status, Number(req.params.id)
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.get("/api/admin/products", auth, async (req, res) => {
  try {
    res.json((await pool.query("SELECT * FROM products ORDER BY id")).rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

app.post("/api/admin/products", auth, async (req, res) => {
  const product = req.body || {};
  const { name, category, notes, price, stock } = product;
  if (!name || !category || !notes || !Number(price))
    return res.status(400).json({ error: "Нужны name/category/notes/price" });
  const extension = validateProductExtensions(product);
  if (extension.error) return res.status(400).json({ error: extension.error });
  const { brand, volume, sku, wholesale_price, min_qty } = extension.values;
  try {
    const r = await pool.query(
      `INSERT INTO products(name,category,notes,price,stock,brand,volume,sku,wholesale_price,min_qty)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [name, category, notes, Number(price), Number(stock) || 0,
       brand, volume, sku, wholesale_price, min_qty]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    if (e.code === "23505") return res.status(409).json({ error: "Такой артикул уже существует" });
    res.status(500).json({ error: "Не удалось добавить товар" });
  }
});

app.patch("/api/admin/products/:id", auth, async (req, res) => {
  const p = req.body || {};
  const extension = validateProductExtensions(p, true);
  if (extension.error) return res.status(400).json({ error: extension.error });
  const value = field => extension.values[field] ?? null;
  const changes = field => hasOwn(extension.values, field);
  try {
    await pool.query(
      `UPDATE products SET
       name=COALESCE($1,name), category=COALESCE($2,category),
       notes=COALESCE($3,notes), price=COALESCE($4,price),
       stock=COALESCE($5,stock), active=COALESCE($6,active),
       brand=CASE WHEN $7 THEN $8 ELSE brand END,
       volume=CASE WHEN $9 THEN $10 ELSE volume END,
       sku=CASE WHEN $11 THEN $12 ELSE sku END,
       wholesale_price=CASE WHEN $13 THEN $14 ELSE wholesale_price END,
       min_qty=CASE WHEN $15 THEN $16 ELSE min_qty END
       WHERE id=$17`,
      [
        p.name ?? null, p.category ?? null, p.notes ?? null,
        p.price ?? null, p.stock ?? null, p.active ?? null,
        changes("brand"), value("brand"),
        changes("volume"), value("volume"),
        changes("sku"), value("sku"),
        changes("wholesale_price"), value("wholesale_price"),
        changes("min_qty"), value("min_qty"),
        Number(req.params.id)
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    if (e.code === "23505") return res.status(409).json({ error: "Такой артикул уже существует" });
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});
app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "admin.html"))
);

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Scent Store listening on ${PORT}`));
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
