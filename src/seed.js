import { db, initSchema, resetDatabase } from './db.js';
import { hashPassword } from './auth.js';

const CATEGORIES = [
  { name: 'Golosinas',   slug: 'golosinas',   emoji: '🍭', color: '#ff2d95', description: 'Bolsas de gominolas, jellies y dulces de todos los sabores.' },
  { name: 'Regalices',   slug: 'regalices',   emoji: '🖤', color: '#2b2b2b', description: 'Regaliz negro, tubes, tiras y espirales para los más valientes.' },
  { name: 'Nubes',       slug: 'nubes',       emoji: '☁️', color: '#ff8fc7', description: 'Nubes de fresa, limón y nata que se deshacen en boca.' },
  { name: 'Rollers',     slug: 'rollers',     emoji: '🌀', color: '#00b8d9', description: 'Gominolas enrollables para reventar el aburrimiento.' },
  { name: 'Chicles',     slug: 'chicles',     emoji: '🫧', color: '#7c4dff', description: 'Chicles de bomba y tiras súper aromáticas.' },
  { name: 'Surtidos',    slug: 'surtidos',    emoji: '🎁', color: '#ff9500', description: 'Mezclas perfectas para compartir sin discutir el sabor.' },
  { name: 'Packs Fiesta',slug: 'packs-fiesta',emoji: '🎉', color: '#e53935', description: 'Packs y mesas de chuches listas para tu evento.' },
  { name: 'Halloween',   slug: 'halloween',   emoji: '🎃', color: '#ff6d00', description: 'Golosinas terroríficamente ricas para la noche más loca.' },
];

// [nombre, slug, categoría slug, precio, precio anterior, stock, unidad, peso, emoji, color, badge, destacado, rating, descripción]
const PRODUCTS = [
  ['Fresa Salvaje Bolsa 1 kg', 'fresa-salvaje-1kg', 'golosinas', 6.99, null, 120, 'bolsa', '1 kg', '🍓', '#e91e63', 'top', 1, 4.9, 'La fresa más icónica: gominola cubierta de azúcar con un toque ácido que engancha desde la primera pieza. Bolsa de 1 kg lista para compartir.'],
  ['Moras Bolsa 1 kg', 'moras-1kg', 'golosinas', 7.79, 8.99, 80, 'bolsa', '1 kg', '🫐', '#5c2d91', '', 1, 4.8, 'Gominola de mora con relleno líquido frutal. Sabor intenso, textura masticable y color morado precioso en la mesa de chuches.'],
  ['Besos Fresa Bolsa 1 kg', 'besos-fresa-1kg', 'golosinas', 6.99, null, 95, 'bolsa', '1 kg', '💋', '#ff4081', '', 1, 4.7, 'Pequeños besitos de fresa con capa de nata. Blanditos, esponjosos y perfectos para mezclar en tus surtidos favoritos.'],
  ['Corazón Melocotón Bolsa 1 kg', 'corazon-melocoton-1kg', 'golosinas', 6.99, null, 60, 'bolsa', '1 kg', '🍑', '#ff7043', '', 0, 4.6, 'Corazones de melocotón masticables con un aroma tropical que llena la casa. Clásicos que nunca fallan.'],
  ['Sensation Red Mix Bolsa 1 kg', 'sensation-red-mix-1kg', 'golosinas', 6.99, 7.49, 110, 'bolsa', '1 kg', '🍒', '#d50000', 'top', 1, 4.8, 'Mezcla roja de fresa, cereza, sandía y frambuesa. Todos los sabores rojos en una sola bolsa para no elegir.'],
  ['Sour Little Mix Bolsa 1 kg', 'sour-little-mix-1kg', 'golosinas', 6.99, null, 75, 'bolsa', '1 kg', '🍬', '#c6ff00', 'hot', 1, 4.7, 'Mini gominolas súper ácidas de colores. El nivel de acidez perfecto para retorcerse la cara con alegría.'],
  ['Botella Cola Bolsa 1 kg', 'botella-cola-1kg', 'golosinas', 6.99, null, 140, 'bolsa', '1 kg', '🥤', '#4e342e', '', 0, 4.5, 'Las clásicas botellitas de cola con doble capa: sabor cola arriba y licor abajo. Un clásico atemporal.'],
  ['Corazón Tricolor Bolsa 1 kg', 'corazon-tricolor-1kg', 'golosinas', 6.99, null, 88, 'bolsa', '1 kg', '❤️', '#e53935', '', 0, 4.6, 'Corazones de goma con tres colores y tres frutas. Ideales para San Valentín, meriendas y regalos improv.'],
  ['Fresón con Nata Rellenas Bolsa 1 kg', 'freson-con-nata-1kg', 'golosinas', 6.99, null, 70, 'bolsa', '1 kg', '🍓', '#f06292', '', 0, 4.8, 'Fresones rellenos de crema de nata. La combinación de fruta y nata que enamora a todos los comensales.'],
  ['Mini Mochis Berries Caja 12x90 g', 'mini-mochis-berries', 'golosinas', 14.99, null, 45, 'caja', '12 x 90 g', '🍡', '#ad1457', 'nuevo', 1, 4.9, 'Mini mochis inspirados en la textura japonesa, con sabores de frambuesa, mora y cereza. Suaves y adictivos.'],
  ['Crunchy Kisses Butterfly 12x75 g', 'crunchy-kisses-butterfly', 'golosinas', 14.99, null, 38, 'caja', '12 x 75 g', '🦋', '#ec407a', 'nuevo', 0, 4.7, 'Besitos crujientes con centro de frambuesa. El crunch exterior y el relleno suave hacen magia en cada bocado.'],
  ['Puzzle Mix Caja 12x90 g', 'puzzle-mix', 'golosinas', 14.99, null, 30, 'caja', '12 x 90 g', '🧩', '#26a69a', 'nuevo', 0, 4.6, 'Gominolas con forma de piezas de puzzle en fresa, naranja, limón y melón. Combina los colores como quieras.'],
  ['Galleta Jengibre Foam Bolsa 1 kg', 'galleta-jengibre-foam', 'golosinas', 6.99, null, 55, 'bolsa', '1 kg', '🍪', '#8d6e63', '', 0, 4.5, 'Gominola con sabor a galleta de jengibre y textura esponjosa. El toque especiado que tanto mola en otoño.'],

  ['Regaliz Tubes Xtreme Sour 12x90 g', 'regaliz-tubes-xtreme', 'regalices', 14.99, null, 60, 'caja', '12 x 90 g', '🖤', '#212121', 'nuevo', 1, 4.8, 'Tubos de regaliz con relleno de fresa y melón y una capa ácida extrema. Para amantes del regaliz sin miedo.'],
  ['Tiras Regaliz Clásicas Bolsa 1 kg', 'tiras-regaliz-clasicas-1kg', 'regalices', 7.49, 8.49, 90, 'bolsa', '1 kg', '🐍', '#263238', 'top', 1, 4.9, 'Tiras de regaliz negro con un sabor intenso y una textura perfectamente elástica. El clásico de siempre.'],
  ['Espirales Regaliz Bicolor 500 g', 'espirales-regaliz-bicolor', 'regalices', 4.49, null, 70, 'bolsa', '500 g', '🌀', '#37474f', '', 0, 4.6, 'Espirales de regaliz negro y fresa en espiral bicolores. Bonitas de ver y espectaculares en la mesa.'],
  ['Regaliz Dipping Tubes 12 uds', 'regaliz-dipping-tubes', 'regalices', 12.00, null, 50, 'estuche', '12 uds', '🧪', '#00897b', 'nuevo', 0, 4.7, 'Tubos de regaliz con saborizante líquido para sumergir. Un experimento dulce para hacer en grupo.'],
  ['Bobas Regaliz Bolsa 1 kg', 'bobas-regaliz-1kg', 'regalices', 6.99, null, 65, 'bolsa', '1 kg', '⚫', '#1b1b1b', '', 0, 4.5, 'Bolas de regaliz cubiertas de azúcar crujiente. Ideales para expositores y carameleras de fiesta.'],

  ['Nubes Fresas con Nata Tarro 200 uds', 'nubes-fresa-nata-tarro', 'nubes', 10.99, null, 85, 'tarro', '200 uds', '☁️', '#f8bbd0', 'top', 1, 4.9, 'Nubes de fresa y nata en tarro de 200 unidades. Esponjosas, aromáticas y perfectas para decorar mesas dulces.'],
  ['Nubes Limón Tarro 200 uds', 'nubes-limon-tarro', 'nubes', 10.99, null, 60, 'tarro', '200 uds', '🍋', '#fff176', '', 0, 4.7, 'Nubes de limón con un toque cítrico refrescante. Su color amarillo alegra cualquier candy bar.'],
  ['Nubes Rellenas Chocolate 500 g', 'nubes-rellenas-chocolate', 'nubes', 5.99, 6.99, 40, 'bolsa', '500 g', '🍫', '#6d4c41', '', 0, 4.8, 'Nubes de malvavisco rellenas de chocolate suave. La unión perfecta entre el algodón y la chocolatería.'],
  ['Nubes Gigantes Surtidas 30 uds', 'nubes-gigantes-surtidas', 'nubes', 8.49, null, 35, 'bolsa', '30 uds', '🌈', '#ff80ab', '', 0, 4.6, 'Nubes XXL de colores surtidos con sabores de fruta. Un espectáculo visual y dulce para fiestas infantiles.'],

  ['Rollers Fresa y Nata 12x90 g', 'rollers-fresa-nata', 'rollers', 14.99, null, 55, 'caja', '12 x 90 g', '🍥', '#ff1744', '', 1, 4.8, 'Gominolas enrollables con sabor a fresa rellena de nata. Enróllalas, mórdelas y compártelas.'],
  ['Rollers Mora y Frambuesa 500 g', 'rollers-mora-frambuesa', 'rollers', 5.49, 6.29, 72, 'bolsa', '500 g', '🍇', '#8e24aa', '', 0, 4.7, 'Rollers de mora y frambuesa con un centro cremoso. Sabor bosque intenso en formato bolsa.'],
  ['Rollers Ácidos Limón 500 g', 'rollers-acidos-limon', 'rollers', 5.49, null, 48, 'bolsa', '500 g', '🍋', '#c0ca33', 'hot', 0, 4.6, 'Rollers cubiertos de azúcar ácido de limón. El reto ácido favorito de la comunidad dulcera.'],

  ['Chicles Bola Fresa 20 uds', 'chicles-bola-fresa', 'chicles', 3.99, null, 150, 'pack', '20 uds', '🔵', '#2979ff', '', 0, 4.5, 'El chicle bola con centro líquido de fresa. Tira de la varilla, chupa, tritura y explota el sabor.'],
  ['Chicles Tira Sandía 12 uds', 'chicles-tira-sandia', 'chicles', 4.29, null, 90, 'pack', '12 uds', '🍉', '#00c853', '', 0, 4.6, 'Tiras de chicle con sabor a sandía y azúcar crujiente. Frescas, coloridas y muy masticables.'],
  ['Chicles Menta Fuerte 30 uds', 'chicles-menta-fuerte', 'chicles', 3.79, null, 110, 'pack', '30 uds', '🌿', '#00bfa5', '', 0, 4.4, 'Chicles de menta de intensidad máxima para refrescar el aliento entre chuches y chuches.'],

  ['Surtido Fiesta Bolsa 2 kg', 'surtido-fiesta-2kg', 'surtidos', 12.99, 14.99, 66, 'bolsa', '2 kg', '🎉', '#ff6f00', 'top', 1, 4.9, 'La bolsa definitiva de surtido variado: fresas, moras, regaliz, botellas y corazón. Todo lo bueno en 2 kg.'],
  ['Surtido Clásico Bolsa 1 kg', 'surtido-clasico-1kg', 'surtidos', 6.99, null, 100, 'bolsa', '1 kg', '🍬', '#ffc107', '', 0, 4.6, 'Mezcla clásica de gominolas surtidas para la bandeja de recepción o el bote de siempre en casa.'],
  ['Mix Ácido Total Bolsa 1 kg', 'mix-acido-total-1kg', 'surtidos', 7.49, null, 58, 'bolsa', '1 kg', '⚡', '#eeff41', 'hot', 0, 4.8, 'Todo el surtido con baño de azúcar ácido. Para quienes dicen "más ácido, por favor".'],

  ['Pack Mesa de Chuches 30 personas', 'pack-mesa-30', 'packs-fiesta', 32.95, 36.95, 25, 'pack', '30 personas', '🎊', '#8e24aa', '', 1, 4.8, 'Pack completo para candy bar de 30 personas: bolsas surtidas, conos, bandeja y etiquetas decorativas.'],
  ['Pack Mesa de Chuches 60 personas', 'pack-mesa-60', 'packs-fiesta', 57.73, 62.90, 18, 'pack', '60 personas', '🥳', '#6a1b9a', 'top', 1, 4.9, 'El pack estrella para 60 invitados: incluye 8 sabores, dispensadores rellenables y decoración a juego.'],
  ['Pack Mesa de Chuches 100 personas', 'pack-mesa-100', 'packs-fiesta', 89.69, 99.90, 12, 'pack', '100 personas', '👑', '#4a148c', '', 1, 5.0, 'La mesa definitiva para 100 personas. Todos los formatos: bolsas, tarros, rollers y regaliz para todos los gustos.'],
  ['Pack Piñata Fiesta 3 kg', 'pack-pinata-fiesta', 'packs-fiesta', 31.45, null, 22, 'pack', '3 kg', '🪅', '#d81b60', '', 0, 4.7, 'Mezcla de chuches para rellenar tu piñata: 3 kg de alegría que revienta en mil pedazos de sabor.'],
  ['Caramelera Expositor 500 g', 'caramelera-expositor', 'packs-fiesta', 3.49, null, 130, 'uds', '500 g', '🏺', '#a1887f', '', 0, 4.5, 'Caramelera clásica transparente con tapa. Perfecta para exponer golosinas en mesas y mostradores.'],

  ['Chuches Halloween Calabaza 500 g', 'chuches-halloween-calabaza', 'halloween', 5.19, null, 44, 'bolsa', '500 g', '🎃', '#ef6c00', 'nuevo', 0, 4.7, 'Calabazas de gominola de sabor frutal para la noche más terrorífica del año.'],
  ['Surtido Halloween Terror 1,5 kg', 'surtido-halloween-terror', 'halloween', 11.99, 13.49, 33, 'bolsa', '1,5 kg', '👻', '#4527a0', '', 0, 4.8, 'Surtido temático con arañas, fantasmas, gusanos y calabazas. Todo negro, naranja y deliciosamente miedo.'],
  ['Arañitas Ácidas Bolsa 1 kg', 'aranitas-acidas-1kg', 'halloween', 6.99, null, 52, 'bolsa', '1 kg', '🕷️', '#212121', 'hot', 0, 4.6, 'Arañitas de regaliz con patas masticables y centro de fresa ácida. Da más miedo verlas venir que comértelas.'],
];

const COUPONS = [
  ['HOLA10', 'percent', 10, 0],
  ['BIENVENIDA5', 'fixed', 5, 20],
  ['MESA20', 'percent', 20, 60],
];

const REVIEWS = [
  ['Fresa Salvaje Bolsa 1 kg', 'Laura M.', 5, 'Llegaron en 24 h y fresquísimas. Las de fresa se acabaron en un día.'],
  ['Fresa Salvaje Bolsa 1 kg', 'Diego R.', 5, 'Calidad-precio top. El kilo no se hace nada grande.'],
  ['Pack Mesa de Chuches 60 personas', 'Marta G.', 5, 'La mesa quedó preciosa, todos preguntaron de dónde eran las chuches.'],
  ['Nubes Fresas con Nata Tarro 200 uds', 'Sofía L.', 4, 'El tarro es enorme, ideal para la oficina. Repetiré seguro.'],
  ['Tiras Regaliz Clásicas Bolsa 1 kg', 'Andrés P.', 5, 'Para mí el mejor regaliz del mercado, sin discusión.'],
];

export async function seed({ force = false } = {}) {
  const count = (await db.get('SELECT COUNT(*) AS n FROM products')).n;
  if (count > 0 && !force) {
    return { skipped: true, products: count };
  }
  await resetDatabase();

  for (const c of CATEGORIES) {
    await db.run(
      'INSERT INTO categories (name, slug, emoji, color, description) VALUES (?, ?, ?, ?, ?)',
      c.name, c.slug, c.emoji, c.color, c.description
    );
  }
  const cats = await db.all('SELECT id, slug FROM categories');
  const catId = new Map(cats.map((c) => [c.slug, c.id]));

  for (const p of PRODUCTS) {
    await db.run(
      `INSERT INTO products (name, slug, description, price, compare_price, stock, unit, weight,
                             category_id, image_emoji, color, badge, featured, rating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p[0], p[1], p[13], p[3], p[4], p[5], p[6], p[7], catId.get(p[2]), p[8], p[9], p[10], p[11], p[12]
    );
  }

  await ensureDemoUsers();

  for (const [code, type, value, minTotal] of COUPONS) {
    await db.run('INSERT INTO coupons (code, type, value, min_total) VALUES (?, ?, ?, ?)', code, type, value, minTotal);
  }

  for (const r of REVIEWS) {
    const prod = await db.get('SELECT id FROM products WHERE name = ?', r[0]);
    if (prod) {
      await db.run('INSERT INTO reviews (product_id, name, rating, comment) VALUES (?, ?, ?, ?)', prod.id, r[1], r[2], r[3]);
    }
  }

  return { skipped: false, products: PRODUCTS.length, categories: CATEGORIES.length };
}

/* Cuentas de prueba (admin / staff / cliente). Idempotente: se ejecuta en
   cada arranque para que existan también en bases de datos ya pobladas. */
export async function ensureDemoUsers() {
  const DEMO_USERS = [
    ['Admin Chuches', 'admin@candyshop.test', 'admin123', 'admin'],
    ['Staff Chuches', 'staff@candyshop.test', 'staff123', 'staff'],
    ['Cliente Demo', 'cliente@candyshop.test', 'cliente123', 'customer'],
  ];
  for (const [name, email, password, role] of DEMO_USERS) {
    await db.run(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
      name, email, hashPassword(password), role
    );
  }
}

/* Ejecutable directo: `npm run seed` / `npm run reset` (reset = --reset) */
if (process.argv[1] && /seed\.js$/.test(process.argv[1])) {
  const force = process.argv.includes('--reset');
  initSchema()
    .then(() => seed({ force }))
    .then((r) => {
      console.log(r.skipped
        ? `Ya había datos (${r.products} productos). Usa --reset para regenerar.`
        : `Seed creado: ${r.categories} categorías, ${r.products} productos.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error al generar datos:', err.message);
      process.exit(1);
    });
}
