export const money = (n) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0)

export function hexA(hex = '#ff2d95', alpha = 0.16) {
  const h = String(hex).replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

export const stars = (rating = 0) => '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating))

export const statusLabel = (s) =>
  ({ pending: 'Pendiente', paid: 'Pagado', shipped: 'Enviado', delivered: 'Entregado', cancelled: 'Cancelado' }[s] || s)

export const roleLabel = (r) =>
  ({ admin: '👑 Admin', staff: '🧑‍🍳 Staff', customer: '🛒 Cliente' }[r] || r)

export const badgeLabel = { nuevo: 'Novedad', top: 'Top ventas', hot: '🔥 En redes' }
