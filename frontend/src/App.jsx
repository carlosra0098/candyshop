import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Account from './pages/Account'
import Admin from './pages/Admin'
import Cart from './pages/Cart'
import Home from './pages/Home'
import NotFound from './pages/NotFound'
import Product from './pages/Product'
import Shop from './pages/Shop'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/tienda" element={<Shop />} />
        <Route path="/producto" element={<Product />} />
        <Route path="/carrito" element={<Cart />} />
        <Route path="/cuenta" element={<Account />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
