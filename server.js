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



app.get("/api/products", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id,name,category,notes,price,stock,active FROM products WHERE active=TRUE ORDER BY id"
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const checked = [];
    let total = 0;

    for (const item of items) {
      const qty = Math.max(1, Math.min(99, Number(item.qty) || 1));
      const r = await client.query(
        "SELECT id,name,price,stock FROM products WHERE id=$1 AND active=TRUE FOR UPDATE",
        [Number(item.productId)]
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
      await client.query(
        "UPDATE products SET stock=stock-$1 WHERE id=$2",
        [p.qty, p.id]
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
  const { name, category, notes, price, stock } = req.body || {};
  if (!name || !category || !notes || !Number(price))
    return res.status(400).json({ error: "Нужны name/category/notes/price" });
  try {
    const r = await pool.query(
      `INSERT INTO products(name,category,notes,price,stock)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [name, category, notes, Number(price), Number(stock) || 0]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Не удалось добавить товар" });
  }
});

app.patch("/api/admin/products/:id", auth, async (req, res) => {
  const p = req.body || {};
  try {
    await pool.query(
      `UPDATE products SET
       name=COALESCE($1,name), category=COALESCE($2,category),
       notes=COALESCE($3,notes), price=COALESCE($4,price),
       stock=COALESCE($5,stock), active=COALESCE($6,active)
       WHERE id=$7`,
      [
        p.name ?? null, p.category ?? null, p.notes ?? null,
        p.price ?? null, p.stock ?? null, p.active ?? null,
        Number(req.params.id)
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Ошибка базы данных" });
  }
});

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
